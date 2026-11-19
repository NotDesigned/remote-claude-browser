import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [listen, proxyPort, webPort] = process.argv.slice(2);
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
    reply.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        ip: "203.0.113.21",
        city: "Tokyo",
        country: "Japan",
        timezone: { id: "Asia/Tokyo" },
      }),
    );
  } else if (url.pathname === "/cookies/set") {
    reply.writeHead(302, { "set-cookie": "mirror=first; Path=/", location: "/cookies" }).end();
  } else if (url.pathname === "/cookies") {
    const cookies = Object.fromEntries(
      (request.headers.cookie ?? "")
        .split("; ")
        .filter(Boolean)
        .map((cookie) => cookie.split("=")),
    );
    reply.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ cookies }));
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
