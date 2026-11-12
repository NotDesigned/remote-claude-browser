// A local SOCKS5/UDP exit for the container acceptance test. No public proxy or secret is used.
import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
const token = "xray-tunnel-fixture";
const server = createServer((_req, res) => res.end(token));
await new Promise((resolve) => server.listen(18080, "127.0.0.1", resolve));
const udp = createSocket("udp4");
udp.on("message", (message, remote) => udp.send(message, remote.port, remote.address));
await new Promise((resolve) => udp.bind(18080, "127.0.0.1", resolve));
const config = {
  log: { loglevel: "warning", access: "none" },
  inbounds: [{ listen: "127.0.0.1", port: 1080, protocol: "socks", settings: { udp: true } }],
  outbounds: [{ protocol: "freedom", settings: { redirect: "127.0.0.1:18080" } }],
};
await writeFile("/tmp/proxy-fixture.json", JSON.stringify(config), { mode: 0o600 });
const child = spawn("/usr/local/bin/xray", ["run", "-config", "/tmp/proxy-fixture.json"], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code || 0));
process.on("SIGTERM", () => {
  child.kill();
  server.close();
  udp.close();
});
