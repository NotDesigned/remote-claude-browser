// Passive transport and event cadence diagnostics. Never sends remote control or reads text.
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
const rtts = [],
  pixels = [],
  mouseBatches = [],
  pending = new Map();
let role,
  nextId = 1,
  pings,
  started = performance.now();
const timeout = setTimeout(() => socket.close(), 8000);
socket.on("open", () => {
  started = performance.now();
  pings = setInterval(() => {
    const id = nextId++,
      sentTs = Date.now();
    pending.set(id, performance.now());
    socket.send(JSON.stringify({ t: "ping", id, sentTs }));
  }, 250);
});
socket.on("message", (raw, isBinary) => {
  const now = performance.now(),
    m = isBinary ? pixelMessage(raw) : JSON.parse(String(raw));
  if (m.t === "hello") role = m.role;
  if (m.t === "pong" && pending.has(m.id)) {
    rtts.push(now - pending.get(m.id));
    pending.delete(m.id);
  }
  if (m.t === "px") pixels.push({ at: now - started, bytes: Math.floor(m.data.length * 0.75) });
  if (m.t === "delta" && now - started > 1000)
    for (const e of m.data) {
      if (e.type === 3 && e.data?.source === 1)
        mouseBatches.push({ at: now - started, positions: e.data.positions?.length || 0 });
    }
});
await new Promise((resolve, reject) => {
  socket.on("close", resolve);
  socket.on("error", reject);
});
clearInterval(pings);
clearTimeout(timeout);
const stats = (values) => {
  const a = values.slice().sort((x, y) => x - y);
  return {
    samples: a.length,
    min: a[0] ?? null,
    median: a[Math.floor(a.length / 2)] ?? null,
    p95: a[Math.floor((a.length - 1) * 0.95)] ?? null,
    max: a.at(-1) ?? null,
  };
};
const result = {
  scope:
    "A to B gateway over public HTTPS and existing SSH tunnel; excludes user's own network and browser",
  role,
  rttMs: stats(rtts),
  pixelFrames: pixels.length,
  pixelFrameBytes: stats(pixels.map((x) => x.bytes)),
  pixelFrameIntervalsMs: stats(pixels.slice(1).map((x, i) => x.at - pixels[i].at)),
  mouseBatches: mouseBatches.length,
  mousePositionsPerBatch: stats(mouseBatches.map((x) => x.positions)),
  mouseBatchIntervalsMs: stats(mouseBatches.slice(1).map((x, i) => x.at - mouseBatches[i].at)),
};
await writeFile("artifacts/latency-probe.json", JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
