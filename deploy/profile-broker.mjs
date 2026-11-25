/** Root-owned, fixed-function runtime. Its Unix API never executes caller-supplied programs. */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, chmod, chown, writeFile, rm, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { createServer as socketServer, connect as connectSocket } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { detectExitMetadata, ExitTimeZoneError } from "../packages/gateway/src/egress/timezone.ts";
import { ALIASMODE_PATH } from "../packages/gateway/src/browser/engine.ts";

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
  const prefix6 = `fd4d:6972:726f:${slot.toString(16)}`;
  return {
    name: `rb-${hash.toString("hex").slice(0, 12)}`,
    hostIf: `rbh${hash.toString("hex").slice(0, 10)}`,
    hostIp: `${prefix}.${(base & 255) + 1}`,
    peerIp: `${prefix}.${(base & 255) + 2}`,
    subnet: `${prefix}.${base & 255}/30`,
    hostIp6: `${prefix6}::1`,
    peerIp6: `${prefix6}::2`,
    subnet6: `${prefix6}::/126`,
  };
}

export function validateBrowserOptions(options, dataRoot = "/data") {
  const dir = resolve(options.userDataDir);
  if (!dir.startsWith(resolve(dataRoot) + "/")) throw new Error("Profile must be in /data");
  if (!Array.isArray(options.args) || !options.args.every((arg) => typeof arg === "string"))
    throw new Error("Invalid Chromium arguments");
  const engine = options.engine ?? "chromium";
  if (engine !== "chromium" && engine !== "aliasmode") throw new Error("Invalid browser engine");
  const env = {};
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!ENV_KEYS.has(key) || typeof value !== "string")
      throw new Error("Invalid browser environment");
    env[key] = value;
  }
  return { userDataDir: dir, engine, args: options.args, env };
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
  filesystemScript = "/opt/remote-browser/browser-filesystem.sh",
  mihomoPath = "/usr/local/bin/mihomo",
  chromePath = process.env.CHROME_PATH ?? "/usr/bin/chromium",
  createConfig,
  secret,
  proxyPort = 8781,
  proxyHost = "runtime-egress",
  defaultNode = { name: "Deployment default", type: "direct" },
  validateNode = (value) => value,
  geoUrl,
} = {}) {
  if (!secret) throw new Error("Runtime secret required");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o755 });
  const networks = new Map();
  const reservations = new Map();
  const pending = new Map();
  const desired = new Map();
  const browsers = new Map();
  const closingBrowsers = new Map();
  const tokens = new Map();
  let stopping = false;
  // Serialize start/change/delete per ID. Cleanup must never wait on its own operation.
  const enqueue = (id, operation) => {
    const next = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    pending.set(id, next);
    const finished = () => {
      if (pending.get(id) === next) pending.delete(id);
    };
    void next.then(finished, finished);
    return next;
  };
  const network = (action, info) =>
    exec("sh", [
      networkScript,
      action,
      info.name,
      info.hostIf,
      info.hostIp,
      info.peerIp,
      info.subnet,
      info.hostIp6,
      info.peerIp6,
      info.subnet6,
    ]);
  const destroyNetwork = async (id) => {
    const item = networks.get(id);
    if (!item) return;
    networks.delete(id);
    tokens.delete(item.token);
    await stopProcess(item.child);
    if (!item.local) await network("stop", item.info);
    reservations.delete(item.info.subnet);
    await rm(item.dir, { recursive: true, force: true });
  };
  const removeNetwork = (id) => {
    clearTimeout(desired.get(id)?.timer);
    desired.delete(id);
    const item = networks.get(id);
    if (item) tokens.delete(item.token);
    return enqueue(id, () => destroyNetwork(id));
  };
  const scheduleRecovery = (id, target) => {
    if (stopping || desired.get(id) !== target || target.timer) return;
    if (target.attempts >= 3) {
      target.health = {
        status: "error",
        checkedAt: Date.now(),
        error: "出口恢复失败，请检查节点后重试",
      };
      return;
    }
    target.health = { status: "error", checkedAt: Date.now(), error: "出口进程已停止，正在重试" };
    const delay = 1000 * 2 ** target.attempts++;
    target.timer = setTimeout(() => {
      target.timer = undefined;
      if (stopping || desired.get(id) !== target) return;
      void enqueue(id, () => startNetwork(id, target)).then(
        (item) => checkAfterRestart(item),
        (error) => {
          // Only the kind of error: messages may carry the node's credentials.
          console.error(
            `egress ${id}: restart ${target.attempts} failed (${error?.code ?? error?.name ?? "error"})`,
          );
          scheduleRecovery(id, target);
        },
      );
    }, delay);
    target.timer.unref();
  };
  // Right after a restart the first exit check can fail while the node path settles; without
  // retries the exit would stay in error although it works.
  const checkAfterRestart = async (item) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await metadataForNetwork(item, attempt > 0);
        return;
      } catch (error) {
        if (
          networks.get(item.id) !== item ||
          item.child.exitCode !== null ||
          item.child.signalCode !== null
        )
          return;
        console.error(
          `egress ${item.id}: exit check after restart failed (${error?.code ?? error?.name ?? "error"})`,
        );
        await new Promise((done) => setTimeout(done, 1000 * 2 ** attempt).unref());
      }
    }
  };
  const ensureNetwork = (id, node) => {
    if (stopping) throw new Error("Runtime is stopping");
    const local = id === "node-deployment-default";
    node = local ? defaultNode : validateNode(node);
    const configHash = createHash("sha256").update(JSON.stringify(node)).digest("hex");
    let target = desired.get(id);
    if (!target || target.configHash !== configHash) {
      clearTimeout(target?.timer);
      target = { node, configHash, attempts: 0, health: { status: "unchecked" } };
      desired.set(id, target);
      const old = networks.get(id);
      if (old) tokens.delete(old.token);
    } else {
      clearTimeout(target.timer);
      target.timer = undefined;
      target.attempts = 0;
    }
    return enqueue(id, () => startNetwork(id, target));
  };
  const startNetwork = async (id, target) => {
    if (stopping || desired.get(id) !== target) throw new Error("Egress start cancelled");
    const local = id === "node-deployment-default";
    const { node, configHash } = target;
    const existing = networks.get(id);
    if (
      existing &&
      existing.configHash === configHash &&
      existing.child.exitCode === null &&
      existing.child.signalCode === null
    )
      return existing;
    if (existing) await destroyNetwork(id);
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
      if (stopping || desired.get(id) !== target) throw new Error("Egress start cancelled");
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Mihomo exited during startup");
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
        target,
        dohTemplate: config.dns.nameserver
          .find((address) => address.startsWith("https://"))
          ?.split("#", 1)[0],
        proxyUrl: `http://${info.peerIp}:${port}`,
        externalProxyUrl: `http://${token}:x@${proxyHost}:${proxyPort}`,
      };
      networks.set(id, result);
      tokens.set(token, result);
      target.health = { status: "unchecked" };
      const startedAt = Date.now();
      child.once("exit", () => {
        if (networks.get(id) !== result || desired.get(id) !== target) return;
        tokens.delete(token);
        result.exitMetadata = undefined;
        target.health = { status: "error", checkedAt: Date.now(), error: "出口进程已停止" };
        if (id.startsWith("browser-")) {
          // Reuse the gateway's Chrome health recovery; a dead exit must not leave a live,
          // permanently disconnected browser with no way to reopen its network runtime.
          void closeBrowser(id.slice("browser-".length));
        } else {
          // A stable run earns a new retry budget; repeated short-lived crashes are bounded.
          if (Date.now() - startedAt >= 60_000) target.attempts = 0;
          scheduleRecovery(id, target);
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
  };
  const closeBrowser = async (id) => {
    const closing = closingBrowsers.get(id);
    if (closing) return closing;
    const item = browsers.get(id);
    if (!item) return removeNetwork(`browser-${id}`);
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
  const metadataForNetwork = (item, fresh = false) => {
    if (item.child.exitCode !== null || item.child.signalCode !== null)
      return Promise.reject(new ExitTimeZoneError("EXIT_STOPPED", "出口进程已停止，请重新打开"));
    if (fresh && !item.checking) item.exitMetadata = undefined;
    if (!item.exitMetadata) {
      item.target.health = { status: "checking" };
      item.checking = detectExitMetadata({ proxyUrl: item.proxyUrl, url: geoUrl })
        .then((metadata) => {
          if (
            networks.get(item.id) !== item ||
            desired.get(item.id) !== item.target ||
            item.child.exitCode !== null ||
            item.child.signalCode !== null
          )
            throw new ExitTimeZoneError("EXIT_CHANGED", "出口在检查期间已变化，请重新检查");
          item.target.health = { status: "healthy", ...metadata };
          return metadata;
        })
        .catch((error) => {
          item.exitMetadata = undefined;
          // A failing probe must not overwrite an in-progress recovery or a new configuration.
          if (
            networks.get(item.id) === item &&
            item.child.exitCode === null &&
            item.child.signalCode === null
          )
            item.target.health = {
              status: "error",
              checkedAt: Date.now(),
              error: error.message,
            };
          throw error;
        })
        .finally(() => {
          item.checking = undefined;
        });
      item.exitMetadata = item.checking;
    }
    return item.exitMetadata;
  };
  const startBrowser = async (id, body) => {
    if (!ID.test(id)) throw new Error("Invalid browser id");
    await closingBrowsers.get(id);
    if (browsers.has(id)) throw new Error("Browser already running");
    const options = validateBrowserOptions(body.options);
    // browser-filesystem.sh enforces this on the open directory; this only fails early and clearly.
    const real = await realpath(options.userDataDir).catch(() => options.userDataDir);
    if (real !== options.userDataDir) throw new Error("Profile path must not contain symlinks");
    if (options.engine === "aliasmode")
      await access(ALIASMODE_PATH, constants.X_OK).catch(() => {
        throw Object.assign(new Error("此浏览器所需的 AliasMode 内核未安装，请联系管理员"), {
          code: "BROWSER_ENGINE_MISSING",
        });
      });
    const egress = await ensureNetwork(`browser-${id}`, body.node);
    let exitMetadata;
    try {
      exitMetadata = await metadataForNetwork(egress);
    } catch (error) {
      await removeNetwork(egress.id);
      throw error;
    }
    const cdpPath = join(runtimeRoot, `${egress.info.name}.cdp`);
    const child = spawn(
      "ip",
      [
        "netns",
        "exec",
        egress.info.name,
        filesystemScript,
        join(egress.dir, "root"),
        options.userDataDir,
        options.engine === "aliasmode" ? ALIASMODE_PATH : chromePath,
        ...options.args,
        ...(options.engine === "aliasmode"
          ? [`--fingerprint-timezone=${exitMetadata.timeZone}`]
          : []),
        `--user-data-dir=${options.userDataDir}`,
        "--remote-debugging-pipe",
      ],
      {
        detached: true,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME ?? "/tmp/home",
          LANG: "C.UTF-8",
          TZ: exitMetadata.timeZone,
          MIRROR_BROWSER_DOH_TEMPLATE: egress.dohTemplate,
          ...options.env,
        },
        stdio: [
          "ignore",
          "ignore",
          process.env.MIRROR_DIAGNOSTIC_STDERR === "1" ? "inherit" : "ignore",
          "pipe",
          "pipe",
        ],
      },
    );
    const item = {
      child,
      socketPath: cdpPath,
      connection: undefined,
      server: undefined,
      timeZone: exitMetadata.timeZone,
      lookups: new Map(),
    };
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
    try {
      await listen(server, cdpPath);
      await chmod(cdpPath, 0o600);
      await chown(cdpPath, UID, UID);
      if (
        stopping ||
        desired.get(egress.id) !== egress.target ||
        egress.child.exitCode !== null ||
        egress.child.signalCode !== null ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        throw new Error("Browser start cancelled");
      browsers.set(id, item);
      child.once("exit", () => void closeBrowser(id));
      return { socketPath: cdpPath, proxyUrl: egress.proxyUrl, ...exitMetadata };
    } catch (error) {
      server.close();
      await closeChromium(child);
      await rm(cdpPath, { force: true });
      if (desired.get(egress.id) === egress.target) await removeNetwork(egress.id);
      throw error;
    }
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
      const url = new URL(request.url, "http://runtime");
      const match =
        /^\/(egress|browsers)\/([a-zA-Z0-9-]{1,64})(\/(?:start|timezone|status|check|resolve))?$/.exec(
          url.pathname,
        );
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
      } else if (request.method === "GET" && type === "browsers" && action === "/resolve") {
        const browser = browsers.get(id);
        const egress = networks.get(`browser-${id}`);
        const hostname = url.searchParams.get("hostname");
        if (!browser || !egress || !hostname) throw new Error("Browser resolver unavailable");
        let lookup = browser.lookups.get(hostname);
        if (!lookup || Date.now() >= lookup.expiresAt) {
          const pending = exec(
            "ip",
            [
              "netns",
              "exec",
              egress.info.name,
              "setpriv",
              "--reuid=10001",
              "--regid=10001",
              "--clear-groups",
              process.execPath,
              "-e",
              'require("node:dns").lookup(process.argv[1],{all:true,verbatim:true},(error,addresses)=>{if(error)process.exit(1);process.stdout.write(JSON.stringify(addresses))})',
              hostname,
            ],
            { timeout: 5000, env: { PATH: process.env.PATH, LANG: "C.UTF-8" } },
          ).then(({ stdout }) => JSON.parse(stdout));
          lookup = { pending, expiresAt: Date.now() + 30_000 };
          browser.lookups.set(hostname, lookup);
          void pending.catch(() => {
            if (browser.lookups.get(hostname) === lookup) browser.lookups.delete(hostname);
          });
        }
        result = await lookup.pending;
      } else if (request.method === "POST" && type === "egress" && action === "/timezone") {
        const item =
          id === "deployment-default"
            ? await ensureNetwork(`node-${id}`)
            : networks.get(`node-${id}`);
        if (!item) throw new Error("Egress network is not running");
        result = await metadataForNetwork(item);
      } else if (
        (request.method === "GET" && action === "/status") ||
        (request.method === "POST" && action === "/check")
      ) {
        const networkId = `${type === "egress" ? "node" : "browser"}-${id}`;
        const item = networks.get(networkId);
        if (action === "/check") {
          if (!item) {
            result = {
              status: "error",
              checkedAt: Date.now(),
              error: "出口未运行，请重新打开后重试",
            };
          } else await metadataForNetwork(item, true).catch(() => {});
        }
        result ??= desired.get(networkId)?.health ?? { status: "unchecked" };
        const browser = type === "browsers" && browsers.get(id);
        if (browser) result = { ...result, browserTimeZone: browser.timeZone };
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
      const timeZoneError = error instanceof ExitTimeZoneError;
      const engineError = error.code === "BROWSER_ENGINE_MISSING";
      response.writeHead(timeZoneError || engineError ? 503 : 500, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          timeZoneError
            ? { error: error.message, code: error.code }
            : engineError
              ? { error: error.message, code: error.code }
              : { error: "Browser network runtime failed" },
        ),
      );
      console.error("Profile runtime operation failed:", error.code ?? error.name);
    }
  });
  await listen(api, socketPath);
  await chmod(socketPath, 0o600);
  await chown(socketPath, UID, UID);
  return {
    async close() {
      stopping = true;
      for (const target of desired.values()) clearTimeout(target.timer);
      desired.clear();
      tokens.clear();
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
    // Tests point the exit's address and time zone lookup at a local fixture.
    geoUrl: process.env.MIRROR_EXIT_LOOKUP_URL || undefined,
  });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, async () => {
      await broker.close();
      process.exit(0);
    });
}
