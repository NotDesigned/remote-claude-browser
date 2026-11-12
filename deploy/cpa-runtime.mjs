import { spawn, spawnSync } from "node:child_process";
import { open, mkdir, stat, chown, chmod, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, createServer } from "node:net";
import { outboundFor, xrayConfig, DEFAULT_BOOTSTRAP_DNS } from "./egress-proxy.mjs";

export function cpaConfig(env) {
  for (const name of ["CPA_API_KEY", "CPA_MANAGEMENT_KEY"]) {
    if (typeof env[name] !== "string" || env[name].trim().length < 32)
      throw new Error(`${name} must contain at least 32 characters`);
  }
  if (env.CPA_API_KEY === env.CPA_MANAGEMENT_KEY)
    throw new Error("CPA API and management keys must be different");
  return {
    "config-version": 8,
    server: { host: "0.0.0.0", port: 8317, "max-request-body-bytes": 33554432 },
    management: {
      "allow-remote": true,
      "secret-key": env.CPA_MANAGEMENT_KEY,
      "disable-auto-update-panel": true,
    },
    access: { "api-keys": [env.CPA_API_KEY] },
    oauth: { "auth-dir": "/auth" },
    routing: {
      strategy: "fill-first",
      "session-affinity": true,
      "session-affinity-rebind-on": "never",
      retry: { "request-retry": 1, "max-retry-credentials": 1, "max-retry-interval": 3 },
    },
    requests: {
      "proxy-url": "socks5://cpa-egress:1080",
      "tls-handshake-timeout-seconds": 15,
      "passthrough-headers": true,
      streaming: { "keepalive-seconds": 15 },
    },
    upstream: {
      claude: {
        "header-defaults": { timezone: env.TZ || "Etc/UTC" },
        // Keep advertised names usable across Messages and OpenAI-compatible routes.
        "disable-cloaking-model-list": true,
      },
    },
    observability: {
      logs: {
        debug: false,
        "logging-to-file": false,
        "request-log": false,
        "error-logs-max-files": 1,
        "logs-max-total-size-mb": 16,
      },
    },
  };
}

// Private networks are blocked at the SOCKS destination, independently of the provider config.
const PRIVATE_IPS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "64:ff9b::/96",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
];
export function cpaEgressConfig(env) {
  const config = xrayConfig({
    proxy: outboundFor(env.EGRESS_PROXY),
    bootstrapDns: env.EGRESS_BOOTSTRAP_DNS?.trim() || DEFAULT_BOOTSTRAP_DNS,
  });
  config.inbounds = [
    {
      tag: "cpa-socks",
      listen: "0.0.0.0",
      port: 1080,
      protocol: "socks",
      settings: { auth: "noauth", udp: false },
    },
  ];
  config.outbounds.push({ tag: "blocked", protocol: "blackhole" });
  config.routing.domainStrategy = "IPIfNonMatch";
  config.routing.rules = config.routing.rules.filter((r) => !r.inboundTag?.includes("tun-in"));
  config.routing.rules.push({
    type: "field",
    inboundTag: ["cpa-socks"],
    outboundTag: "blocked",
    ip: [...PRIVATE_IPS, ...(env.EGRESS_BLOCK || "").split(/[\s,]+/).filter(Boolean)],
  });
  return config;
}

export async function initializeCpa(dirs, env, options = {}) {
  const config = cpaConfig(env);
  const uid = options.uid ?? 10003,
    gid = options.gid ?? 10003;
  for (const dir of Object.values(dirs)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Initialization alone claims volumes; the long-running CPA has no capabilities.
    await chown(dir, process.getuid(), process.getgid());
    await chmod(dir, 0o700);
  }
  const target = join(dirs.config, "config.yaml");
  const exists = await stat(target).then(
    () => true,
    (e) => {
      if (e.code !== "ENOENT") throw e;
      return false;
    },
  );
  if (!exists || options.force) {
    const temp = `${target}.init-${process.pid}`;
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chown(temp, uid, gid);
    await rename(temp, target);
  }
  for (const dir of Object.values(dirs)) await chown(dir, uid, gid);
  return !exists || options.force === true;
}

export function probeSocks(host = "127.0.0.1", port = 1080) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const finish = (error) => {
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.setTimeout(2500, () => finish(new Error("SOCKS probe timed out")));
    socket.once("error", finish);
    socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
    let received = Buffer.alloc(0);
    socket.on("data", (data) => {
      received = Buffer.concat([received, data]);
      if (received.length >= 2)
        finish(
          received[0] === 5 && received[1] === 0 ? undefined : new Error("SOCKS probe rejected"),
        );
    });
    socket.once("end", () => finish(new Error("SOCKS probe closed early")));
  });
}

async function runEgress() {
  const config = cpaEgressConfig(process.env);
  delete process.env.EGRESS_PROXY;
  const path = "/tmp/cpa-xray.json";
  await writeFile(path, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  const log = await open("/tmp/cpa-xray.log", "a", 0o600);
  const checked = spawnSync("xray", ["run", "-test", "-config", path], {
    stdio: ["ignore", log.fd, log.fd],
  });
  if (checked.status !== 0) {
    await log.close();
    throw new Error("Xray configuration check failed; private diagnostics: /tmp/cpa-xray.log");
  }
  const child = spawn("xray", ["run", "-config", path], { stdio: ["ignore", log.fd, log.fd] });
  // Internal-only containers cannot return Docker Desktop host-NAT traffic directly. Forward
  // the two published loopback ports through this dual-network service without parsing secrets.
  const sockets = new Set();
  const servers = [8317, 54545].map((port) =>
    createServer((socket) => {
      const upstream = connect({ host: "cpa", port });
      sockets.add(socket);
      sockets.add(upstream);
      const timer = setTimeout(() => {
        socket.destroy();
        upstream.destroy();
      }, 5000);
      upstream.once("connect", () => clearTimeout(timer));
      for (const s of [socket, upstream]) {
        s.once("error", () => {
          socket.destroy();
          upstream.destroy();
        });
        s.once("close", () => {
          clearTimeout(timer);
          sockets.delete(s);
        });
      }
      socket.pipe(upstream).pipe(socket);
    }),
  );
  const closeIngress = () => {
    for (const server of servers) server.close();
    for (const socket of sockets) socket.destroy();
  };
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      stopping = true;
      closeIngress();
      child.kill(signal);
    });
  child.once("error", () => {
    closeIngress();
    console.error("Xray could not start");
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    closeIngress();
    process.exitCode = stopping ? 0 : code || 1;
  });
  try {
    for (let i = 0; i < servers.length; i++) {
      await new Promise((resolve, reject) => {
        servers[i].once("error", reject);
        servers[i].listen([8317, 54545][i], "0.0.0.0", resolve);
      });
    }
  } catch (error) {
    closeIngress();
    child.kill();
    throw error;
  } finally {
    await log.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    switch (process.argv[2]) {
      case "init":
        console.log(
          (await initializeCpa(
            { config: "/config", auth: "/auth", static: "/static" },
            process.env,
            { force: process.argv.includes("--force") },
          ))
            ? "CPA configuration initialized"
            : "Existing CPA configuration retained",
        );
        break;
      case "health": {
        const response = await fetch("http://127.0.0.1:8317/", {
          signal: AbortSignal.timeout(2500),
        });
        if (!response.ok) throw new Error("CPA HTTP probe failed");
        break;
      }
      case "socks-health":
        await probeSocks();
        break;
      case "egress":
        await runEgress();
        break;
      default:
        throw new Error("Use init [--force], health, socks-health or egress");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "CPA operation failed");
    process.exitCode = 1;
  }
}
