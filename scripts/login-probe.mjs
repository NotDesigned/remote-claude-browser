// Low-cost login-screen probe: no Chromium process on A, pictures explicitly requested.
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
const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
const WebSocket = require("ws");
const origin = process.env.MIRROR_ORIGIN ?? "http://127.0.0.1:3010";
const password = (await readFile("/etc/claude-browser/agent.env", "utf8"))
  .split("\n")
  .find((line) => line.startsWith("MIRROR_ACCESS_PASSWORD="))
  .split("=")[1];
const response = await fetch(`${origin}/gate`, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password }),
});
if (response.status !== 303) throw new Error("Gateway authentication failed");
const cookie = response.headers
  .getSetCookie()
  .map((line) => line.split(";")[0])
  .join("; ");
const socket = new WebSocket(origin.replace(/^http/, "ws") + "/ws", {
  headers: { Cookie: cookie, Origin: origin },
});
let tab,
  requested = false,
  done = false;
const send = (value) => socket.send(JSON.stringify(value));
const deadline = setTimeout(() => {
  if (tab) send({ t: "mode", tab, mode: "dom" });
  socket.close();
}, 20000);
socket.on("message", async (raw, isBinary) => {
  const message = isBinary ? pixelMessage(raw) : JSON.parse(String(raw));
  if (message.t === "tabs")
    tab = message.tabs.find((item) => item.active)?.id || message.tabs[0]?.id;
  if (message.t === "snapshot") {
    tab ||= message.tab;
    if (message.reason === "viewport")
      send({ t: "view-ack", tab: message.tab, epoch: message.epoch });
  }
  if (tab && !requested) {
    requested = true;
    send({ t: "view", tab, w: 1280, h: 900, dpr: 1 });
    setTimeout(() => send({ t: "mode", tab, mode: "px" }), 1500);
  }
  if (message.t === "px" && !done) {
    done = true;
    await writeFile("artifacts/login-screen.jpg", Buffer.from(message.data, "base64"), {
      mode: 0o600,
    });
    send({ t: "mode", tab, mode: "dom" });
  }
  if (done && message.t === "mode" && message.mode === "dom") {
    clearTimeout(deadline);
    socket.close();
  }
});
await new Promise((resolve, reject) => {
  socket.on("close", resolve);
  socket.on("error", reject);
});
if (!done) throw new Error("No remote frame received");
console.log("Remote login frame captured; pixel streaming stopped.");
