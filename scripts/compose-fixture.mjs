import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

// geoDelay (milliseconds, optional) stands for a real exit lookup's round trips through a node.
const [listen, proxyPort, webPort, geoDelay = "0"] = process.argv.slice(2);
/** The real ProseMirror composer (scripts/fixtures), copied in beside this script. */
const COMPOSER_SCRIPT = "/tmp/prosemirror-composer.js";
writeFileSync(
  "/tmp/smoke-exit.json",
  JSON.stringify({
    log: { loglevel: "warning", access: "none" },
    inbounds: [{ listen, port: Number(proxyPort), protocol: "socks", settings: { udp: true } }],
    outbounds: [{ protocol: "freedom" }],
  }),
);
const proxy = spawn("xray", ["run", "-config", "/tmp/smoke-exit.json"], { stdio: "inherit" });
const server = createServer({ maxHeaderSize: 128 * 1024 }, (request, reply) => {
  const url = new URL(request.url, "http://fixture.test");
  if (url.pathname === "/geo") {
    setTimeout(() => {
      reply.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          ip: "203.0.113.21",
          city: "Tokyo",
          country: "Japan",
          timezone: { id: "Asia/Tokyo" },
        }),
      );
    }, Number(geoDelay));
  } else if (url.pathname === "/prosemirror-composer.js" && existsSync(COMPOSER_SCRIPT)) {
    reply
      .writeHead(200, { "content-type": "text/javascript; charset=utf-8" })
      .end(readFileSync(COMPOSER_SCRIPT));
  } else if (url.pathname === "/cookies/set") {
    reply.writeHead(302, { "set-cookie": "mirror=first; Path=/", location: "/cookies" }).end();
  } else if (url.pathname === "/cookies") {
    const cookies = Object.fromEntries(
      (request.headers.cookie ?? "")
        .split("; ")
        .filter(Boolean)
        .map((cookie) => cookie.split("=")),
    );
    const text = JSON.stringify({ cookies }).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
    reply
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(`<!doctype html><meta charset="utf-8"><pre id="cookies">${text}</pre>`);
  } else {
    const html = Buffer.from(url.searchParams.get("html") ?? "", "base64url");
    reply.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  }
});
server.listen(Number(webPort), listen);
proxy.on("exit", (code) => {
  server.close();
  process.exitCode = code ?? 1;
});
process.on("SIGTERM", () => {
  proxy.kill();
  server.close();
});
