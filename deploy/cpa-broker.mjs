/** Fixed-template CPA provisioner. Only this process has Docker permission. */
import { request as httpRequest, createServer } from "node:http";
import { createServer as createTcpServer, connect as connectTcp } from "node:net";
import { createHash } from "node:crypto";
import { chmod, chown, mkdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const MANAGED = "dev.remote-browser.cpa-managed";
const INSTANCE = "dev.remote-browser.cpa-instance";
// The engine image this container was created from, and a digest of the whole template. Either
// one changing means the instance is re-created (its volumes are kept).
const IMAGE = "dev.remote-browser.cpa-image";
const SPEC = "dev.remote-browser.cpa-spec";
// The deployment an instance belongs to: the name of its broker's shared network.
const DEPLOYMENT = "dev.remote-browser.cpa-deployment";
const ID = /^cpa-[a-f0-9]{20}$/;
// Docker Engine 27.3. Older engines reject the versioned paths below.
export const DOCKER_API_VERSION = "1.47";
const EGRESS_ALIAS = "runtime-egress";
const EGRESS_PORT = 8781;
const STAGED_CONFIG = ".initial-config.yaml";
// Compose labels the images it builds. Containers inherit image labels, so without this an instance
// would claim to be a service of the Compose project, and `docker compose down --remove-orphans`
// or a scale change could remove it. A label set to "" matches no project or service.
const COMPOSE_LABELS = [
  "com.docker.compose.project",
  "com.docker.compose.service",
  "com.docker.compose.version",
  "com.docker.compose.oneoff",
  "com.docker.compose.container-number",
  "com.docker.compose.config-hash",
];
const HEADERS = new Set([
  "connection",
  "transfer-encoding",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
]);
class BrokerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const labels = (id) => ({ [MANAGED]: "true", [INSTANCE]: id });
const volumeNames = (id) =>
  Object.fromEntries(
    ["config", "auth", "static"].map((kind) => [kind, `remote-browser-${id}-${kind}`]),
  );
/** Each instance has its own internal network, shared only with this broker. */
export const instanceNetwork = (id) => `remote-browser-${id}-net`;

export function instanceConfig(input) {
  return {
    "config-version": 8,
    // Only the broker shares this instance's network, so listening on every address reaches nothing
    // but the broker; allow-remote is what lets the broker's address use the management API.
    server: { host: "0.0.0.0", port: 8317, "max-request-body-bytes": 33554432 },
    management: {
      "allow-remote": true,
      "secret-key": input.managementKey,
      "disable-auto-update-panel": true,
    },
    access: { "api-keys": [input.apiKey] },
    oauth: { "auth-dir": "/auth" },
    routing: {
      strategy: "fill-first",
      "session-affinity": true,
      "session-affinity-rebind-on": "never",
      retry: { "request-retry": 1, "max-retry-credentials": 1, "max-retry-interval": 3 },
    },
    requests: {
      "proxy-url": input.proxyUrl,
      "tls-handshake-timeout-seconds": 15,
      "passthrough-headers": true,
      streaming: { "keepalive-seconds": 15 },
    },
    upstream: {
      claude: { "header-defaults": { timezone: "Etc/UTC" }, "disable-cloaking-model-list": true },
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
// The broker uploads the initial configuration into the config volume before this runs, so the
// keys never appear in a container's environment. An existing config.yaml is never replaced.
const INITIALIZE = `
const fs=require('node:fs/promises');
(async()=>{
  for(const p of ['/config','/auth','/static']) { await fs.chown(p,0,0); await fs.chmod(p,448); }
  const staged='/config/${STAGED_CONFIG}';
  try { await fs.link(staged,'/config/config.yaml'); }
  catch(e) { if(e.code!=='EEXIST') throw e; }
  await fs.rm(staged,{force:true});
  await fs.chmod('/config/config.yaml',384);
  for(const p of ['/config/config.yaml','/config','/auth','/static']) await fs.chown(p,10003,10003);
})().catch(()=>{process.exitCode=1});`;

function instanceLabels(id, options) {
  const blank = {};
  for (const key of [...COMPOSE_LABELS, ...Object.keys(options.imageLabels ?? {})])
    if (key.startsWith("com.docker.compose.")) blank[key] = "";
  return {
    ...blank,
    ...labels(id),
    [DEPLOYMENT]: options.network,
    [IMAGE]: options.imageId ?? options.image,
  };
}
export function specDigest(spec) {
  const { [SPEC]: _ignored, ...rest } = spec.Labels;
  return createHash("sha256")
    .update(JSON.stringify({ ...spec, Labels: rest }))
    .digest("hex")
    .slice(0, 32);
}
export function containerSpec(id, options) {
  const volumes = volumeNames(id);
  const network = instanceNetwork(id);
  const spec = {
    Image: options.image,
    User: "10003:10003",
    Labels: instanceLabels(id, options),
    Env: ["HOME=/auth", "MANAGEMENT_STATIC_PATH=/static"],
    WorkingDir: "/logs",
    Cmd: ["/app/CLIProxyAPI", "--config", "/config/config.yaml", "--local-model"],
    HostConfig: {
      NetworkMode: network,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      RestartPolicy: { Name: "unless-stopped" },
      Memory: 512 * 1024 * 1024,
      NanoCpus: 500_000_000,
      PidsLimit: 128,
      Tmpfs: {
        "/tmp": "rw,noexec,nosuid,size=64m,uid=10003,gid=10003",
        "/logs": "rw,noexec,nosuid,size=16m,uid=10003,gid=10003",
      },
      Mounts: Object.entries(volumes).map(([kind, Source]) => ({
        Type: "volume",
        Source,
        Target: `/${kind}`,
        ReadOnly: false,
      })),
      LogConfig: { Type: "json-file", Config: { "max-size": "2m", "max-file": "2" } },
    },
    NetworkingConfig: { EndpointsConfig: { [network]: {} } },
  };
  spec.Labels[SPEC] = specDigest(spec);
  return spec;
}
export function initializerSpec(id, options) {
  const spec = containerSpec(id, options);
  delete spec.Labels[SPEC];
  spec.User = "0:0";
  spec.WorkingDir = "/tmp";
  spec.Env = [];
  spec.Cmd = ["node", "-e", INITIALIZE];
  delete spec.NetworkingConfig;
  spec.HostConfig.NetworkMode = "none";
  spec.HostConfig.CapAdd = ["CHOWN"];
  spec.HostConfig.RestartPolicy = { Name: "no" };
  spec.HostConfig.Memory = 96 * 1024 * 1024;
  return spec;
}

/** A one-file ustar archive, as PUT /containers/{id}/archive expects. */
export function singleFileTar(name, content, mode = 0o600) {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  const field = (offset, length, value) => header.write(value, offset, length, "ascii");
  const octal = (offset, length, value) =>
    field(offset, length, value.toString(8).padStart(length - 1, "0") + "\0");
  field(0, 100, name);
  octal(100, 8, mode);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, data.length);
  octal(136, 12, Math.floor(Date.now() / 1000));
  field(148, 8, "        ");
  field(156, 1, "0");
  field(257, 8, "ustar\u000000");
  let sum = 0;
  for (const byte of header) sum += byte;
  field(148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding, Buffer.alloc(1024)]);
}

/** A /28 inside `pool` for this instance; `attempt` moves to the next one after a collision. */
export function instanceSubnet(id, attempt = 0, pool = "10.254.0.0/16") {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(pool);
  const bits = Number(match?.[5]);
  if (!match || match.slice(1, 5).some((part) => Number(part) > 255) || bits < 8 || bits > 26)
    throw new Error("CPA_INSTANCE_SUBNETS must be an IPv4 network from /8 to /26");
  const base = match.slice(1, 5).reduce((value, part) => value * 256 + Number(part), 0);
  const slots = 2 ** (28 - bits);
  const slot = (createHash("sha256").update(id).digest().readUInt32BE(0) + attempt) % slots;
  const network = ((base >>> (32 - bits)) * 2 ** (32 - bits) + slot * 16) >>> 0;
  return `${[24, 16, 8, 0].map((shift) => (network >>> shift) & 255).join(".")}/28`;
}

export function createDockerClient(socketPath = "/var/run/docker.sock") {
  return async (method, path, body, contentType = "application/json") => {
    const raw = Buffer.isBuffer(body);
    const response = await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath,
          method,
          path: path === "/version" ? path : `/v${DOCKER_API_VERSION}${path}`,
          headers: body === undefined ? {} : { "content-type": contentType },
        },
        resolve,
      );
      req.once("error", reject);
      req.end(body === undefined ? undefined : raw ? body : JSON.stringify(body));
    });
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    if (response.statusCode >= 400)
      throw new BrokerError(response.statusCode, "Docker operation failed");
    const data = Buffer.concat(chunks).toString();
    return data ? JSON.parse(data) : null;
  };
}
const versionAtLeast = (actual, wanted) => {
  const [a = 0, b = 0] = String(actual).split(".").map(Number);
  const [c, d] = wanted.split(".").map(Number);
  return a > c || (a === c && b >= d);
};
function requireManaged(value, id, what = "Container") {
  const found = value.Config?.Labels ?? value.Labels;
  if (found?.[MANAGED] !== "true" || found?.[INSTANCE] !== id)
    throw new BrokerError(409, `${what} name belongs to another service`);
  return value;
}
export function allowedUpstream(method, path) {
  const url = new URL(path, "http://cpa.invalid");
  if (!path.startsWith("/") || path.startsWith("//") || url.origin !== "http://cpa.invalid")
    return false;
  if (url.pathname.startsWith("/v1/")) return true;
  return (
    ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method) &&
    /^\/v(8|0)\/management\//.test(url.pathname)
  );
}
async function jsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 32_768) throw new BrokerError(413, "Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
function validateInitialization(input) {
  for (const name of ["apiKey", "managementKey"])
    if (typeof input[name] !== "string" || input[name].length < 32 || input[name].length > 128)
      throw new BrokerError(400, "Invalid instance key");
  const url = new URL(input.proxyUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== EGRESS_ALIAS ||
    url.port !== String(EGRESS_PORT) ||
    !url.username ||
    url.password !== "x"
  )
    throw new BrokerError(400, "Invalid runtime proxy");
}
/**
 * options.network: the internal network the broker shares with the server.
 * options.self: this broker's container, which joins every instance network as runtime-egress.
 * options.egress: host:port of the server's authenticated proxy on options.network.
 */
export function createCpaBroker(options) {
  const docker = options.docker ?? createDockerClient(options.dockerSocket);
  const requestUpstream = options.requestUpstream ?? httpRequest;
  const log = options.log ?? ((message) => console.error(`cpa-broker: ${message}`));
  const locks = new Map();
  const serialized = async (id, action) => {
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    locks.set(id, next);
    try {
      return await next;
    } finally {
      if (locks.get(id) === next) locks.delete(id);
    }
  };
  const missing = async (read) => {
    try {
      return await read();
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  };
  // Another deployment, or a test beside this one, may run its own broker on the same daemon. An
  // instance is this broker's if it carries this deployment's label, or, from before that label,
  // if it is attached to this deployment's shared network.
  const owned = (value) => {
    const deployment = (value.Config?.Labels ?? value.Labels)?.[DEPLOYMENT];
    if (deployment !== undefined) return deployment === options.network;
    return !!value.NetworkSettings?.Networks?.[options.network];
  };
  const inspect = async (id) => {
    const value = await missing(() => docker("GET", `/containers/remote-browser-${id}/json`));
    if (!value) return null;
    requireManaged(value, id);
    if (!owned(value)) throw new BrokerError(409, "CPA instance belongs to another deployment");
    return value;
  };
  const volume = async (id, name) => {
    const value = await missing(() => docker("GET", `/volumes/${name}`));
    return value && requireManaged(value, id, "Volume");
  };
  const network = async (id) => {
    const value = await missing(() => docker("GET", `/networks/${instanceNetwork(id)}`));
    if (!value) return null;
    requireManaged(value, id, "Network");
    if (value.Labels?.[DEPLOYMENT] !== options.network)
      throw new BrokerError(409, "CPA network belongs to another deployment");
    if (!value.Internal) throw new BrokerError(409, "CPA network permits Internet egress");
    return value;
  };
  const engine = async () => {
    const image = await docker("GET", `/images/${options.image}/json`);
    return { imageId: image.Id, imageLabels: image.Config?.Labels ?? {} };
  };
  const desiredSpec = async (id) => containerSpec(id, { ...options, ...(await engine()) });
  const current = (value, spec) =>
    value.Config.Labels?.[SPEC] === spec.Labels[SPEC] && value.Image === spec.Labels[IMAGE];
  const joinNetwork = async (name) => {
    if (!options.self) return;
    const self = await docker("GET", `/containers/${options.self}/json`);
    if (self.NetworkSettings?.Networks?.[name]) return;
    try {
      await docker("POST", `/networks/${name}/connect`, {
        Container: self.Id,
        EndpointConfig: { Aliases: [EGRESS_ALIAS] },
      });
    } catch (error) {
      // Already connected by a concurrent request.
      if (error.status !== 403 && error.status !== 409) throw error;
    }
  };
  const ensureNetwork = async (id) => {
    const name = instanceNetwork(id);
    if (!(await network(id))) {
      for (let attempt = 0; ; attempt++) {
        try {
          await docker("POST", "/networks/create", {
            Name: name,
            Driver: "bridge",
            Internal: true,
            Labels: { ...labels(id), [DEPLOYMENT]: options.network },
            IPAM: { Config: [{ Subnet: instanceSubnet(id, attempt, options.subnets) }] },
          });
          break;
        } catch (error) {
          // 403: the subnet overlaps another network; 409: created meanwhile.
          if (error.status === 409) break;
          if (error.status !== 403 || attempt >= 31) throw error;
        }
      }
      await network(id);
    }
    await joinNetwork(name);
    return name;
  };
  const removeNetwork = async (id) => {
    const value = await network(id);
    if (!value) return;
    if (options.self)
      await missing(() =>
        docker("POST", `/networks/${value.Name}/disconnect`, {
          Container: options.self,
          Force: true,
        }),
      ).catch((error) => {
        if (error.status !== 403 && error.status !== 409) throw error;
      });
    await docker("DELETE", `/networks/${value.Name}`);
  };
  const initialize = async (id, input) => {
    for (const name of Object.values(volumeNames(id))) {
      if (!(await volume(id, name)))
        await docker("POST", "/volumes/create", { Name: name, Labels: labels(id) });
    }
    const created = await docker(
      "POST",
      "/containers/create",
      initializerSpec(id, { ...options, ...(await engine()) }),
    );
    try {
      await docker(
        "PUT",
        `/containers/${created.Id}/archive?path=/config`,
        singleFileTar(STAGED_CONFIG, JSON.stringify(instanceConfig(input)) + "\n"),
        "application/x-tar",
      );
      await docker("POST", `/containers/${created.Id}/start`);
      const result = await docker("POST", `/containers/${created.Id}/wait?condition=not-running`);
      if (result.StatusCode !== 0) throw new BrokerError(500, "CPA initialization failed");
    } finally {
      await docker("DELETE", `/containers/${created.Id}?force=1`);
    }
  };
  const create = async (id, spec) => {
    await docker("POST", `/containers/create?name=remote-browser-${id}`, spec);
    return inspect(id);
  };
  // Replaces an instance whose image or template is out of date. Only the container is replaced:
  // its three volumes hold the configuration, credentials and panel.
  const replace = async (id, value, spec) => {
    const volumes = await Promise.all(
      Object.values(volumeNames(id)).map((name) => volume(id, name)),
    );
    if (volumes.some((item) => !item)) throw new BrokerError(409, "CPA volumes are missing");
    const running = value.State.Running;
    if (running) await docker("POST", `/containers/remote-browser-${id}/stop?t=10`);
    await docker("DELETE", `/containers/remote-browser-${id}?force=1`);
    await create(id, spec);
    if (running) await docker("POST", `/containers/remote-browser-${id}/start`);
    return inspect(id);
  };
  const target = (id, value) => {
    const networks = value.NetworkSettings.Networks;
    // An instance created before per-instance networks is still on the shared one until replaced.
    const host = (networks[instanceNetwork(id)] ?? networks[options.network])?.IPAddress;
    if (!host || !value.State.Running) throw new BrokerError(503, "CPA instance is stopped");
    return host;
  };
  const waitReady = async (id, value) => {
    const host = target(id, value);
    for (let attempt = 0; attempt < 40; attempt++) {
      const ready = await new Promise((resolve) => {
        const req = requestUpstream({ host, port: 8317, path: "/", timeout: 500 }, (response) => {
          response.resume();
          resolve(response.statusCode === 200);
        });
        req.once("error", () => resolve(false));
        req.once("timeout", () => req.destroy());
        req.end();
      });
      if (ready) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new BrokerError(503, "CPA did not become ready");
  };
  const proxy = async (request, response, id, value, path) => {
    const headers = { ...request.headers, host: "cpa:8317" };
    for (const name of HEADERS) delete headers[name];
    const upstream = requestUpstream({
      host: target(id, value),
      port: 8317,
      path,
      method: request.method,
      headers,
    });
    upstream.once("error", () => {
      if (response.headersSent) return response.destroy();
      response.writeHead(502, { "content-type": "application/json" });
      response.end('{"error":"CPA upstream unavailable"}');
    });
    upstream.once("response", (incoming) => {
      const replyHeaders = { ...incoming.headers };
      for (const name of HEADERS) delete replyHeaders[name];
      response.writeHead(incoming.statusCode, replyHeaders);
      void pipeline(incoming, response).catch(() => response.destroy());
    });
    request.once("aborted", () => upstream.destroy());
    response.once("close", () => upstream.destroy());
    void pipeline(request, upstream).catch(() => upstream.destroy());
  };
  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(request.url, "http://broker.invalid");
      const match = /^\/instances\/([^/]+)(?:\/(ensure|stop|request))?$/.exec(url.pathname);
      if (!match || !ID.test(match[1])) throw new BrokerError(404, "Unknown instance route");
      const [, id, action] = match;
      if (request.method === "GET" && !action) {
        const value = await inspect(id);
        return send(200, {
          status: value ? (value.State.Running ? "running" : "stopped") : "missing",
        });
      }
      if (request.method === "DELETE" && !action) {
        await serialized(id, async () => {
          const value = await inspect(id);
          const volumes = await Promise.all(
            Object.values(volumeNames(id)).map((name) => volume(id, name)),
          );
          await network(id);
          if (value) await docker("DELETE", `/containers/remote-browser-${id}?force=1`);
          for (const item of volumes) if (item) await docker("DELETE", `/volumes/${item.Name}`);
          await removeNetwork(id);
        });
        return send(200, { ok: true });
      }
      if (request.method === "POST" && action === "ensure") {
        const input = await jsonBody(request);
        validateInitialization(input);
        await serialized(id, async () => {
          let value = await inspect(id);
          await ensureNetwork(id);
          const spec = await desiredSpec(id);
          if (!value) {
            await initialize(id, input);
            value = await create(id, spec);
          } else if (!current(value, spec)) value = await replace(id, value, spec);
          if (!value.State.Running) await docker("POST", `/containers/remote-browser-${id}/start`);
          await waitReady(id, await inspect(id));
        });
        return send(200, { ok: true });
      }
      if (request.method === "POST" && action === "stop") {
        await serialized(id, async () => {
          const value = await inspect(id);
          if (value?.State.Running)
            await docker("POST", `/containers/remote-browser-${id}/stop?t=10`);
        });
        return send(200, { ok: true });
      }
      if (action === "request") {
        const path = url.searchParams.get("path");
        if (!path || !allowedUpstream(request.method, path))
          throw new BrokerError(403, "CPA route is not allowed");
        const value = await inspect(id);
        if (!value) throw new BrokerError(404, "CPA instance not created");
        return await proxy(request, response, id, value, path);
      }
      throw new BrokerError(405, "Method not allowed");
    } catch (error) {
      if (!response.headersSent)
        send(error instanceof BrokerError ? error.status : 500, {
          error: error instanceof BrokerError ? error.message : "CPA broker operation failed",
        });
      else response.destroy();
    }
  });
  // The instances' only route out: runtime-egress:8781 on each instance network, relayed to the
  // server's authenticated proxy. The proxy authenticates every request itself.
  const relay = createTcpServer((socket) => {
    const [host, port] = options.egress.split(":");
    const upstream = connectTcp({ host, port: Number(port) });
    socket.pipe(upstream).pipe(socket);
    socket.once("error", () => upstream.destroy());
    upstream.once("error", () => socket.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.once("close", () => socket.destroy());
  });
  return {
    server,
    relay,
    async listen(socketPath) {
      const version = await docker("GET", "/version").catch(() => null);
      if (version?.ApiVersion && !versionAtLeast(version.ApiVersion, DOCKER_API_VERSION))
        throw new Error(
          `CPA broker needs Docker Engine 27.3 or newer (API ${DOCKER_API_VERSION}); this daemon offers API ${version.ApiVersion}`,
        );
      const shared = await docker("GET", `/networks/${encodeURIComponent(options.network)}`);
      if (!shared.Internal) throw new Error("CPA broker requires an internal Docker network");
      if (options.egress)
        await new Promise((resolve, reject) => {
          relay.once("error", reject);
          relay.listen(EGRESS_PORT, "0.0.0.0", resolve);
        });
      await mkdir(dirname(socketPath), { recursive: true, mode: 0o750 });
      await chown(dirname(socketPath), process.getuid(), options.socketGid ?? 10001);
      await chmod(dirname(socketPath), 0o750);
      await rm(socketPath, { force: true });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      await chown(socketPath, process.getuid(), options.socketGid ?? 10001);
      await chmod(socketPath, 0o660);
    },
    /** Puts each of this deployment's instances on its own network and replaces outdated ones. */
    async reconcile() {
      const filters = encodeURIComponent(JSON.stringify({ label: [`${MANAGED}=true`] }));
      const found = await docker("GET", `/containers/json?all=1&filters=${filters}`);
      const results = { current: 0, replaced: 0, failed: 0 };
      for (const item of found) {
        const id = item.Labels?.[INSTANCE];
        if (!ID.test(id ?? "") || !owned(item)) continue;
        try {
          await serialized(id, async () => {
            const value = await inspect(id);
            if (!value) return;
            await ensureNetwork(id);
            const spec = await desiredSpec(id);
            if (current(value, spec)) results.current++;
            else {
              await replace(id, value, spec);
              results.replaced++;
            }
          });
        } catch (error) {
          results.failed++;
          log(`could not bring ${id} up to date: ${error.message}`);
        }
      }
      return results;
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.CPA_BROKER_NETWORK) throw new Error("CPA_BROKER_NETWORK is required");
  const broker = createCpaBroker({
    image: process.env.CPA_BROKER_IMAGE || "remote-claude-browser-cpa:local",
    network: process.env.CPA_BROKER_NETWORK,
    dockerSocket: process.env.CPA_DOCKER_SOCKET || "/var/run/docker.sock",
    socketGid: Number(process.env.CPA_BROKER_SOCKET_GID || 10001),
    self: process.env.CPA_BROKER_CONTAINER || hostname(),
    egress: process.env.CPA_BROKER_EGRESS || `server:${EGRESS_PORT}`,
    subnets: process.env.CPA_INSTANCE_SUBNETS || undefined,
  });
  await broker.listen(process.env.CPA_BROKER_SOCKET || "/run/remote-browser/cpa.sock");
  const results = await broker.reconcile();
  console.error(
    `cpa-broker: ${results.current} instances current, ${results.replaced} replaced, ${results.failed} failed`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      broker.relay.close();
      broker.server.close(() => process.exit(0));
    });
}
