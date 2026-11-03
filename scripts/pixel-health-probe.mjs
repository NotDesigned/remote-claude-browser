// Brief frame-health check only when no other viewer owns control. Never navigates or sends input.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
// Pixel frames arrive as binary WebSocket frames (see encodePxBinary); keep only their metadata.
const pixelMessage = (raw) => {
  const b = new Uint8Array(raw);
  const n = (b[2] << 8) | b[3];
  return {
    t: "px",
    tab: new TextDecoder().decode(b.subarray(4, 4 + n)),
    w: (b[4 + n] << 8) | b[5 + n],
    h: (b[6 + n] << 8) | b[7 + n],
    data: "",
  };
};
if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");
const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
const WebSocket = require("ws"),
  origin = "https://claude.example.com";
const password = (await readFile("/etc/claude-browser/agent.env", "utf8"))
  .split("\n")
  .find((l) => l.startsWith("MIRROR_ACCESS_PASSWORD="))
  .slice("MIRROR_ACCESS_PASSWORD=".length);
const auth = await fetch(origin + "/gate", {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password }),
  signal: AbortSignal.timeout(10000),
});
if (auth.status !== 303) throw new Error("Gateway authentication failed");
const socket = new WebSocket("wss://claude.example.com/ws", {
  headers: {
    Origin: origin,
    Cookie: auth.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; "),
  },
});
let role,
  tab,
  requested = false,
  received = false,
  restored = false,
  started = 0;
const send = (m) => socket.readyState === 1 && socket.send(JSON.stringify(m));
const stop = () => {
  if (requested && tab) send({ t: "mode", tab, mode: "dom" });
  else socket.close();
};
const deadline = setTimeout(() => {
  stop();
  setTimeout(() => socket.close(), 4000);
}, 15000);
socket.on("message", (raw, isBinary) => {
  const m = isBinary ? pixelMessage(raw) : JSON.parse(String(raw));
  if (m.t === "hello") {
    role = m.role;
    if (role !== "driver") socket.close();
  }
  if (m.t === "tabs") tab = m.tabs.find((t) => t.active)?.id;
  if (tab && role === "driver" && !requested) {
    requested = true;
    started = Date.now();
    send({ t: "mode", tab, mode: "px" });
  }
  if (m.t === "px" && m.tab === tab && !received) {
    received = true;
    console.log(
      JSON.stringify({
        remotePixelFrame: true,
        firstFrameMs: Date.now() - started,
        width: m.w,
        height: m.h,
        bytes: Math.floor(m.data.length * 0.75),
      }),
    );
    stop();
  }
  if (m.t === "mode" && m.tab === tab && m.mode === "dom" && requested) {
    restored = true;
    socket.close();
  }
});
await new Promise((resolve, reject) => {
  socket.on("close", resolve);
  socket.on("error", reject);
});
clearTimeout(deadline);
const result = {
  role,
  remoteFrameReceived: received,
  returnedToDom: restored,
  skipped: role !== "driver",
};
await writeFile("artifacts/pixel-health.json", JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result));
if (role === "driver" && (!received || !restored)) throw new Error("Remote frame probe failed");
