// Isolated acceptance upstream: SOCKS redirects documentation IPs to this fake Anthropic API.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const server = createServer(async (req, res) => {
  if (!req.url.startsWith("/v1/messages")) {
    res.end("browser-fixture");
    return;
  }
  if (
    req.headers["x-api-key"] !== "fixture-upstream-key" &&
    req.headers.authorization !== "Bearer fixture-upstream-key"
  ) {
    res.writeHead(401).end();
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (body.model !== "claude-fixture") {
    res.writeHead(400).end("Unexpected upstream model");
    return;
  }
  const message = {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: body.model,
    content: [{ type: "text", text: "fixture-ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
  };
  if (!body.stream) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(message));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const event = (type, payload) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  event("message_start", {
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  });
  event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "fixture-ok" } });
  event("content_block_stop", { index: 0 });
  event("message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 2 },
  });
  event("message_stop", {});
  res.end();
});
await new Promise((resolve) => server.listen(18080, "0.0.0.0", resolve));
await writeFile(
  "/tmp/fixture-xray.json",
  JSON.stringify({
    log: { loglevel: "warning", access: "none" },
    inbounds: [{ listen: "0.0.0.0", port: 1080, protocol: "socks", settings: { udp: false } }],
    outbounds: [{ protocol: "freedom", settings: { redirect: "127.0.0.1:18080" } }],
  }),
  { mode: 0o600 },
);
const child = spawn("xray", ["run", "-config", "/tmp/fixture-xray.json"], { stdio: "inherit" });
process.on("SIGTERM", () => {
  child.kill();
  server.close();
});
child.on("exit", (code) => {
  server.close();
  process.exitCode = code || 0;
});
