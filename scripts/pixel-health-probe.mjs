// Brief frame-health check only when no other viewer owns control. Never navigates or sends input.
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createProbeSession } from "./probe-session.mjs";
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
    byteLength: b.byteLength - (8 + n),
  };
};
if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");
const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
const WebSocket = require("ws"),
  origin = process.env.MIRROR_ORIGIN ?? "http://127.0.0.1:3010";
const probe = await createProbeSession(origin);
try {
  await mkdir("artifacts", { recursive: true });
  const socket = probe.attach(new WebSocket(probe.socketUrl, { headers: probe.headers }));
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
          bytes: m.byteLength ?? Math.floor(m.data.length * 0.75),
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
} finally {
  await probe.close();
}
