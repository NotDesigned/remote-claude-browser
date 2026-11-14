/** Fixed-template CPA provisioner. Only this process has Docker permission. */
import { request as httpRequest, createServer } from "node:http";
import { chmod, chown, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const MANAGED = "dev.remote-browser.cpa-managed";
const INSTANCE = "dev.remote-browser.cpa-instance";
const ID = /^cpa-[a-f0-9]{20}$/;
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

export function instanceConfig(input) {
  return {
    "config-version": 8,
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
const INITIALIZE = `
const fs=require('node:fs/promises');
(async()=>{
  for(const p of ['/config','/auth','/static']) { await fs.chown(p,0,0); await fs.chmod(p,448); }
  try { await fs.writeFile('/config/config.yaml',process.env.CPA_INITIAL_CONFIG+'\\n',{mode:384,flag:'wx'}); }
  catch(e) { if(e.code!=='EEXIST') throw e; }
  for(const p of ['/config/config.yaml','/config','/auth','/static']) await fs.chown(p,10003,10003);
})().catch(()=>{process.exitCode=1});`;

export function containerSpec(id, options) {
  const volumes = volumeNames(id);
  return {
    Image: options.image,
    User: "10003:10003",
    Labels: labels(id),
    Env: ["HOME=/auth", "MANAGEMENT_STATIC_PATH=/static"],
    WorkingDir: "/logs",
    Cmd: ["/app/CLIProxyAPI", "--config", "/config/config.yaml", "--local-model"],
    HostConfig: {
      NetworkMode: options.network,
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
    NetworkingConfig: { EndpointsConfig: { [options.network]: {} } },
  };
}
export function initializerSpec(id, options, input) {
  const spec = containerSpec(id, options);
  spec.User = "0:0";
  spec.WorkingDir = "/tmp";
  spec.Env = [`CPA_INITIAL_CONFIG=${JSON.stringify(instanceConfig(input))}`];
  spec.Cmd = ["node", "-e", INITIALIZE];
  delete spec.NetworkingConfig;
  spec.HostConfig.NetworkMode = "none";
  spec.HostConfig.CapAdd = ["CHOWN"];
  spec.HostConfig.RestartPolicy = { Name: "no" };
  spec.HostConfig.Memory = 96 * 1024 * 1024;
  return spec;
}

export function createDockerClient(socketPath = "/var/run/docker.sock") {
  return async (method, path, body) => {
    const response = await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath,
          method,
          path: `/v1.47${path}`,
          headers: body === undefined ? {} : { "content-type": "application/json" },
        },
        resolve,
      );
      req.once("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    if (response.statusCode >= 400)
      throw new BrokerError(response.statusCode, "Docker operation failed");
    const data = Buffer.concat(chunks).toString();
    return data ? JSON.parse(data) : null;
  };
}
function requireManaged(value, id) {
  if (value.Config.Labels?.[MANAGED] !== "true" || value.Config.Labels?.[INSTANCE] !== id)
    throw new BrokerError(409, "Container name belongs to another service");
  return value;
}
export function allowedUpstream(method, path) {
  const url = new URL(path, "http://cpa.invalid");
  if (!path.startsWith("/") || path.startsWith("//") || url.origin !== "http://cpa.invalid")
    return false;
  if (url.pathname.startsWith("/v1/")) return true;
  const permitted = {
    "/v8/management/credentials": ["GET", "POST", "DELETE"],
    "/v8/management/credentials/status": ["PATCH"],
    "/v8/management/credentials/fields": ["PATCH"],
    "/v8/management/oauth/auth-url": ["POST"],
    "/v8/management/oauth/status": ["GET"],
    "/v8/management/oauth/callback": ["POST"],
    "/v8/management/oauth/session": ["DELETE"],
  };
  return permitted[url.pathname]?.includes(method) === true;
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
    url.hostname !== "runtime-egress" ||
    url.port !== "8781" ||
    !url.username ||
    url.password !== "x"
  )
    throw new BrokerError(400, "Invalid runtime proxy");
}
export function createCpaBroker(options) {
  const docker = options.docker ?? createDockerClient(options.dockerSocket);
  const requestUpstream = options.requestUpstream ?? httpRequest;
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
  const inspect = async (id) => {
    try {
      return requireManaged(await docker("GET", `/containers/remote-browser-${id}/json`), id);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  };
  const initialize = async (id, input) => {
    for (const name of Object.values(volumeNames(id))) {
      let volume;
      try {
        volume = await docker("GET", `/volumes/${name}`);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      if (volume) {
        if (volume.Labels?.[MANAGED] !== "true" || volume.Labels?.[INSTANCE] !== id)
          throw new BrokerError(409, "Volume name belongs to another service");
      } else await docker("POST", "/volumes/create", { Name: name, Labels: labels(id) });
    }
    const created = await docker("POST", "/containers/create", initializerSpec(id, options, input));
    try {
      await docker("POST", `/containers/${created.Id}/start`);
      const result = await docker("POST", `/containers/${created.Id}/wait?condition=not-running`);
      if (result.StatusCode !== 0) throw new BrokerError(500, "CPA initialization failed");
    } finally {
      await docker("DELETE", `/containers/${created.Id}?force=1`);
    }
  };
  const target = (value) => {
    const host = value.NetworkSettings.Networks[options.network]?.IPAddress;
    if (!host || !value.State.Running) throw new BrokerError(503, "CPA instance is stopped");
    return host;
  };
  const waitReady = async (value) => {
    const host = target(value);
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
  const proxy = async (request, response, value, path) => {
    const headers = { ...request.headers, host: "cpa:8317" };
    for (const name of HEADERS) delete headers[name];
    const upstream = requestUpstream({
      host: target(value),
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
      if (request.method === "POST" && action === "ensure") {
        const input = await jsonBody(request);
        validateInitialization(input);
        await serialized(id, async () => {
          let value = await inspect(id);
          if (!value) {
            await initialize(id, input);
            await docker(
              "POST",
              `/containers/create?name=remote-browser-${id}`,
              containerSpec(id, options),
            );
            value = await inspect(id);
          }
          if (!value.State.Running) await docker("POST", `/containers/remote-browser-${id}/start`);
          await waitReady(await inspect(id));
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
        return await proxy(request, response, value, path);
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
  return {
    server,
    async listen(socketPath) {
      const network = await docker("GET", `/networks/${encodeURIComponent(options.network)}`);
      if (!network.Internal) throw new Error("CPA broker requires an internal Docker network");
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
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const broker = createCpaBroker({
    image: process.env.CPA_BROKER_IMAGE || "remote-claude-browser-cpa:local",
    network: process.env.CPA_BROKER_NETWORK,
    dockerSocket: process.env.CPA_DOCKER_SOCKET || "/var/run/docker.sock",
    socketGid: Number(process.env.CPA_BROKER_SOCKET_GID || 10001),
  });
  if (!process.env.CPA_BROKER_NETWORK) throw new Error("CPA_BROKER_NETWORK is required");
  await broker.listen(process.env.CPA_BROKER_SOCKET || "/run/remote-browser/cpa.sock");
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => broker.server.close(() => process.exit(0)));
}
