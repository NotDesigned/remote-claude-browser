/** Root-owned, fixed-function runtime. Its Unix API never executes caller-supplied programs. */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, chmod, chown, writeFile, rm, readFile } from "node:fs/promises";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { createServer as socketServer, connect as connectSocket } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const UID = 10001;
const ID = /^[a-zA-Z0-9-]{1,64}$/;
const ENV_KEYS = new Set(["DISPLAY", "XAUTHORITY", "FONTCONFIG_FILE", "XDG_CONFIG_HOME"]);

export function networkIdentity(id, offset = 0) {
  if (!ID.test(id)) throw new Error("Invalid runtime id");
  const hash = createHash("sha256").update(id).digest();
  const slot = ((hash.readUInt16BE(0) + offset) % 16382) + 1;
  const base = slot * 4;
  const prefix = `10.253.${base >> 8}`;
  return {
    name: `rb-${hash.toString("hex").slice(0, 12)}`,
    hostIf: `rbh${hash.toString("hex").slice(0, 10)}`,
    hostIp: `${prefix}.${(base & 255) + 1}`,
    peerIp: `${prefix}.${(base & 255) + 2}`,
    subnet: `${prefix}.${base & 255}/30`,
  };
}

export function validateBrowserOptions(options, dataRoot = "/data") {
  const dir = resolve(options.userDataDir);
  if (!dir.startsWith(resolve(dataRoot) + "/")) throw new Error("Profile must be in /data");
  if (!Array.isArray(options.args) || !options.args.every((arg) => typeof arg === "string"))
    throw new Error("Invalid Chromium arguments");
  const env = {};
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!ENV_KEYS.has(key) || typeof value !== "string")
      throw new Error("Invalid browser environment");
    env[key] = value;
  }
  return { userDataDir: dir, args: options.args, env };
}

async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 2000);
  await exited;
  clearTimeout(timer);
}

async function closeChromium(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  // Browser.close acknowledges before Chromium has flushed its profile. Keep the pipe alive
  // and let the process finish instead of terminating its storage services with the gateway.
  if (!child.stdio[3].destroyed) child.stdio[3].write('{"id":-1,"method":"Browser.close"}\0');
  let timer;
  await Promise.race([
    exited,
    new Promise((done) => {
      timer = setTimeout(done, 2000);
    }),
  ]);
  clearTimeout(timer);
  await stopProcess(child);
}

async function listen(server, target) {
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(target, () => {
      server.off("error", fail);
      done();
    });
  });
}

async function waitPort(host, port, child) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Mihomo exited during startup");
    const ready = await new Promise((done) => {
      const socket = connectSocket({ host, port });
      socket.setTimeout(100);
      socket.once("connect", () => {
        socket.destroy();
        done(true);
      });
      socket.once("error", () => done(false));
      socket.once("timeout", () => {
        socket.destroy();
        done(false);
      });
    });
    if (ready) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("Mihomo startup timed out");
}

export async function startProfileBroker({
  socketPath = process.env.MIRROR_RUNTIME_SOCKET ?? "/run/remote-browser/runtime.sock",
  runtimeRoot = "/run/remote-browser",
  networkScript = "/opt/remote-browser/profile-network.sh",
  mihomoPath = "/usr/local/bin/mihomo",
  chromePath = process.env.CHROME_PATH ?? "/usr/bin/chromium",
  createConfig,
  secret,
  proxyPort = 8781,
  proxyHost = "runtime-egress",
  defaultNode = { name: "Deployment default", type: "direct" },
  validateNode = (value) => value,
} = {}) {
  if (!secret) throw new Error("Runtime secret required");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o755 });
  const networks = new Map();
  const reservations = new Map();
  const pending = new Map();
  const browsers = new Map();
  const closingBrowsers = new Map();
  const tokens = new Map();
  const network = (action, info) =>
    exec("sh", [
      networkScript,
      action,
      info.name,
      info.hostIf,
      info.hostIp,
      info.peerIp,
      info.subnet,
    ]);
  const removeNetwork = async (id) => {
    const starting = pending.get(id);
    if (starting) await starting.catch(() => {});
    const item = networks.get(id);
    if (!item) return;
    networks.delete(id);
    tokens.delete(item.token);
    await stopProcess(item.child);
    if (!item.local) await network("stop", item.info);
    reservations.delete(item.info.subnet);
    await rm(item.dir, { recursive: true, force: true });
  };
  const ensureNetwork = async (id, node) => {
    const local = id === "node-deployment-default";
    node = local ? defaultNode : validateNode(node);
    const configHash = createHash("sha256").update(JSON.stringify(node)).digest("hex");
    const existing = networks.get(id);
    if (
      existing &&
      existing.configHash === configHash &&
      existing.child.exitCode === null &&
      existing.child.signalCode === null
    )
      return existing;
    if (pending.has(id)) return pending.get(id);
    const start = (async () => {
      if (existing) await removeNetwork(id);
      let info = local ? { ...networkIdentity(id), peerIp: "127.0.0.1" } : networkIdentity(id);
      const port = local ? 8782 : 8780;
      if (!local) {
        let offset = 0;
        while (reservations.has(info.subnet)) {
          if (++offset >= 16382) throw new Error("Profile network capacity reached");
          info = networkIdentity(id, offset);
        }
        reservations.set(info.subnet, id);
      }
      const dir = join(runtimeRoot, info.name);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      let child;
      try {
        if (!local) await network("start", info);
        const config = createConfig(node, {
          tun: !local,
          listenAddress: info.peerIp,
          port,
          dnsPort: local ? 1054 : 1053,
          device: "profile0",
          bootstrapDns: process.env.EGRESS_BOOTSTRAP_DNS || undefined,
          block: (process.env.EGRESS_BLOCK ?? "")
            .split(",")
            .map((address) => address.trim())
            .filter(Boolean),
        });
        await writeFile(join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });
        // Mihomo owns the TUN. Only browser UID10001 is policy-routed into it.
        let command = "ip";
        let args = [
          "netns",
          "exec",
          info.name,
          mihomoPath,
          "-d",
          dir,
          "-f",
          join(dir, "config.json"),
        ];
        if (local) {
          // Preserve the deployment's existing UID10001 egress, including legacy Xray options.
          await chown(join(dir, "config.json"), UID, UID);
          await chown(dir, 0, UID);
          await chmod(dir, 0o770);
          command = "setpriv";
          args = [
            "--reuid=10001",
            "--regid=10001",
            "--clear-groups",
            "--inh-caps=-all",
            mihomoPath,
            "-d",
            dir,
            "-f",
            join(dir, "config.json"),
          ];
        }
        child = spawn(command, args, { detached: true, stdio: "ignore" });
        await waitPort(info.peerIp, port, child);
        if (!local) await network("route", info);
        const token = createHmac("sha256", secret).update(id).digest("hex");
        const result = {
          id,
          info,
          dir,
          child,
          configHash,
          token,
          local,
          port,
          proxyUrl: `http://${info.peerIp}:${port}`,
          externalProxyUrl: `http://${token}:x@${proxyHost}:${proxyPort}`,
        };
        networks.set(id, result);
        tokens.set(token, result);
        child.once("exit", () => {
          if (networks.get(id) === result && id.startsWith("browser-")) {
            // Reuse the gateway's Chrome health recovery; a dead exit must not leave a live,
            // permanently disconnected browser with no way to reopen its network runtime.
            void closeBrowser(id.slice("browser-".length));
          }
        });
        return result;
      } catch (error) {
        await stopProcess(child);
        if (!local) await network("stop", info);
        reservations.delete(info.subnet);
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
    })();
    pending.set(id, start);
    try {
      return await start;
    } finally {
      pending.delete(id);
    }
  };
  const closeBrowser = async (id) => {
    const closing = closingBrowsers.get(id);
    if (closing) return closing;
    const item = browsers.get(id);
    if (!item) return;
    browsers.delete(id);
    const cleanup = (async () => {
      item.connection?.destroy();
      item.server.close();
      await closeChromium(item.child);
      await rm(item.socketPath, { force: true });
      await removeNetwork(`browser-${id}`);
    })();
    closingBrowsers.set(id, cleanup);
    try {
      await cleanup;
    } finally {
      closingBrowsers.delete(id);
    }
  };
  const startBrowser = async (id, body) => {
    if (!ID.test(id)) throw new Error("Invalid browser id");
    await closingBrowsers.get(id);
    if (browsers.has(id)) throw new Error("Browser already running");
    const options = validateBrowserOptions(body.options);
    const egress = await ensureNetwork(`browser-${id}`, body.node);
    const cdpPath = join(runtimeRoot, `${egress.info.name}.cdp`);
    const child = spawn(
      "ip",
      [
        "netns",
        "exec",
        egress.info.name,
        "setpriv",
        "--reuid=10001",
        "--regid=10001",
        "--clear-groups",
        "--inh-caps=-all",
        chromePath,
        ...options.args,
        `--user-data-dir=${options.userDataDir}`,
        "--remote-debugging-pipe",
      ],
      {
        detached: true,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME ?? "/tmp/home",
          LANG: "C.UTF-8",
          TZ: process.env.TZ,
          ...options.env,
        },
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      },
    );
    const item = { child, socketPath: cdpPath, connection: undefined, server: undefined };
    const server = socketServer((connection) => {
      if (item.connection) return connection.destroy();
      item.connection = connection;
      connection.pipe(child.stdio[3], { end: false });
      child.stdio[4].pipe(connection);
      connection.on("error", () => {});
      connection.once("close", () => void closeBrowser(id));
    });
    child.stdio[3].on("error", () => {});
    item.server = server;
    await listen(server, cdpPath);
    await chmod(cdpPath, 0o600);
    await chown(cdpPath, UID, UID);
    browsers.set(id, item);
    child.once("exit", () => void closeBrowser(id));
    return { socketPath: cdpPath, proxyUrl: egress.proxyUrl };
  };
  const authorized = (request) => {
    const match = /^Basic (.+)$/i.exec(request.headers["proxy-authorization"] ?? "");
    return match && tokens.get(Buffer.from(match[1], "base64").toString().split(":", 1)[0]);
  };
  // CPA containers have only an internal network; this authenticated proxy is their sole exit.
  const proxy = httpServer((request, response) => {
    const item = authorized(request);
    if (!item) {
      response.writeHead(407);
      response.end();
      return;
    }
    const headers = { ...request.headers };
    delete headers["proxy-authorization"];
    const upstream = httpRequest(
      {
        host: item.info.peerIp,
        port: item.port,
        method: request.method,
        path: request.url,
        headers,
      },
      (incoming) => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });
  proxy.on("connect", (request, socket, head) => {
    const item = authorized(request);
    if (!item) {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    const upstream = connectSocket({ host: item.info.peerIp, port: item.port }, () => {
      upstream.write(`CONNECT ${request.url} HTTP/1.1\r\nHost: ${request.url}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });
  await listen(proxy, { host: "0.0.0.0", port: proxyPort });
  await rm(socketPath, { force: true });
  const api = httpServer(async (request, response) => {
    try {
      const match = /^\/(egress|browsers)\/([a-zA-Z0-9-]{1,64})(\/start)?$/.exec(request.url);
      if (!match) {
        response.writeHead(404);
        response.end();
        return;
      }
      const [, type, id, action] = match;
      let result;
      if (request.method === "POST" && action === "/start") {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 262144) throw new Error("Runtime request too large");
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (type === "egress") {
          const item = await ensureNetwork(`node-${id}`, body.node);
          result = { proxyUrl: item.proxyUrl, externalProxyUrl: item.externalProxyUrl };
        } else result = await startBrowser(id, body);
      } else if (request.method === "DELETE" && !action) {
        if (type === "egress") await removeNetwork(`node-${id}`);
        else await closeBrowser(id);
        result = { ok: true };
      } else {
        response.writeHead(405);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      // Config errors may contain credentials. Keep broker failures free of request contents.
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Browser network runtime failed" }));
      console.error("Profile runtime operation failed:", error.code ?? error.name);
    }
  });
  await listen(api, socketPath);
  await chmod(socketPath, 0o600);
  await chown(socketPath, UID, UID);
  return {
    async close() {
      api.close();
      proxy.close();
      for (const id of [...browsers.keys()]) await closeBrowser(id);
      await Promise.all([...closingBrowsers.values()]);
      await Promise.allSettled([...pending.values()]);
      for (const id of [...networks.keys()]) await removeNetwork(id);
      await rm(socketPath, { force: true });
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { createMihomoConfig } = await import("../packages/gateway/src/egress/mihomo.ts");
  const { validateProxy } = await import("../packages/gateway/src/egress/subscription.ts");
  const secretFile = "/data/runtime/secret";
  let secret;
  try {
    secret = await readFile(secretFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    secret = randomBytes(32).toString("hex");
    await writeFile(secretFile, secret, { mode: 0o600 });
  }
  const broker = await startProfileBroker({
    createConfig: createMihomoConfig,
    secret,
    validateNode: validateProxy,
  });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, async () => {
      await broker.close();
      process.exit(0);
    });
}
