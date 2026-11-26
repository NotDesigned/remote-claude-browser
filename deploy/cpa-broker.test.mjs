import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { EventEmitter, once } from "node:events";
import { createServer as createTcpServer, connect as connectTcp } from "node:net";
import {
  allowedUpstream,
  containerSpec,
  initializerSpec,
  createCpaBroker,
  INITIALIZE,
  instanceNetwork,
  instanceSubnet,
  singleFileTar,
} from "./cpa-broker.mjs";

const one = "cpa-11111111111111111111",
  two = "cpa-22222222222222222222",
  three = "cpa-33333333333333333333";
const options = { image: "test-cpa:pinned", network: "test-internal" };
const input = {
  apiKey: "a".repeat(43),
  managementKey: "m".repeat(43),
  proxyUrl: "http://opaque:x@runtime-egress:8781",
};

test("CPA fixed templates isolate volumes, remove privileges and permit no host binds or port publishing", () => {
  const first = containerSpec(one, options),
    second = containerSpec(two, options);
  assert.equal(first.Image, options.image);
  assert.equal(first.User, "10003:10003");
  assert.equal(first.HostConfig.NetworkMode, instanceNetwork(one));
  assert.notEqual(first.HostConfig.NetworkMode, second.HostConfig.NetworkMode);
  assert.deepEqual(Object.keys(first.NetworkingConfig.EndpointsConfig), [instanceNetwork(one)]);
  assert.equal(first.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(first.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(first.HostConfig.SecurityOpt, ["no-new-privileges:true"]);
  assert.equal(first.HostConfig.PortBindings, undefined);
  assert.equal(first.HostConfig.Binds, undefined);
  assert.ok(first.HostConfig.Memory <= 512 * 1024 * 1024);
  assert.ok(first.HostConfig.PidsLimit <= 128);
  const names = new Set(first.HostConfig.Mounts.map((mount) => mount.Source));
  for (const mount of second.HostConfig.Mounts) assert.ok(!names.has(mount.Source));
  assert.equal(first.HostConfig.Mounts.length, 3);
  assert.ok(first.HostConfig.Mounts.every((mount) => mount.Type === "volume"));
  const init = initializerSpec(one, options);
  assert.equal(init.Image, first.Image);
  assert.equal(init.HostConfig.NetworkMode, "none");
  assert.deepEqual(init.HostConfig.CapAdd, ["CHOWN"]);
  assert.equal(init.HostConfig.AutoRemove, undefined);
  assert.deepEqual(init.Env, [], "keys never go into a container's environment");
});

test("instances never carry the Compose labels their image was built with", () => {
  const spec = containerSpec(one, {
    ...options,
    imageId: "sha256:abc",
    imageLabels: {
      "com.docker.compose.project": "remote-claude-browser",
      "com.docker.compose.service": "cpa-engine-image",
      "com.docker.compose.image.builder": "classic",
      "org.opencontainers.image.version": "1",
    },
  });
  for (const key of [
    "com.docker.compose.project",
    "com.docker.compose.service",
    "com.docker.compose.version",
    "com.docker.compose.oneoff",
    "com.docker.compose.image.builder",
  ])
    assert.equal(spec.Labels[key], "", key);
  assert.equal(spec.Labels["org.opencontainers.image.version"], undefined);
  assert.equal(spec.Labels["dev.remote-browser.cpa-image"], "sha256:abc");
  assert.equal(initializerSpec(one, options).Labels["com.docker.compose.project"], "");
});

test("the template digest changes with the engine image and the template", () => {
  const a = containerSpec(one, { ...options, imageId: "sha256:a" });
  const b = containerSpec(one, { ...options, imageId: "sha256:b" });
  assert.equal(
    a.Labels["dev.remote-browser.cpa-spec"],
    containerSpec(one, { ...options, imageId: "sha256:a" }).Labels["dev.remote-browser.cpa-spec"],
  );
  assert.notEqual(a.Labels["dev.remote-browser.cpa-spec"], b.Labels["dev.remote-browser.cpa-spec"]);
});

test("instance subnets stay inside the pool and move on after a collision", () => {
  const first = instanceSubnet(one);
  assert.match(first, /^10\.254\.\d+\.\d+\/28$/);
  assert.equal(Number(first.split(".")[3].split("/")[0]) % 16, 0);
  assert.notEqual(instanceSubnet(one, 1), first);
  assert.equal(instanceSubnet(one, 0, "10.254.0.0/26").replace(/\.\d+\/28$/, ""), "10.254.0");
  assert.match(instanceSubnet(two, 3, "172.20.16.0/20"), /^172\.20\.(1[6-9]|2\d|3[01])\.\d+\/28$/);
  assert.throws(() => instanceSubnet(one, 0, "10.254.0.0/28"), /CPA_INSTANCE_SUBNETS/);
});

test("the initial configuration travels as a root-only tar entry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cpa-tar-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, "config.tar");
  await writeFile(archive, singleFileTar(".initial-config.yaml", "secret: 1\n"));
  assert.equal(
    execFileSync("tar", ["-xOf", archive, ".initial-config.yaml"], { encoding: "utf8" }),
    "secret: 1\n",
  );
  assert.match(execFileSync("tar", ["-tvf", archive], { encoding: "utf8" }), /^-rw------- /);
});

test("broker allows CPA management and inference paths and excludes unrelated routes", () => {
  assert.ok(allowedUpstream("POST", "/v8/management/oauth/auth-url"));
  assert.ok(allowedUpstream("GET", "/v8/management/oauth/status?state=one"));
  assert.ok(allowedUpstream("PATCH", "/v8/management/credentials/fields"));
  assert.ok(allowedUpstream("PUT", "/v8/management/config/requests/proxy-url"));
  assert.ok(allowedUpstream("PUT", "/v8/management/config/requests"));
  assert.ok(allowedUpstream("GET", "/v8/management/credentials/download?name=one.json"));
  assert.ok(allowedUpstream("POST", "/v1/messages"));
  assert.ok(allowedUpstream("GET", "/v8/management/config.yaml"));
  assert.ok(!allowedUpstream("POST", "/containers/create"));
  assert.ok(!allowedUpstream("POST", "http://other/v1/messages"));
  assert.ok(!allowedUpstream("POST", "//other/v1/messages"));
  assert.ok(!allowedUpstream("GET", "/v8/management/../../containers/json"));
});

test("broker authenticates the managed container identity and rejects unrelated names", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "cpa-broker-"));
  const calls = [];
  const broker = createCpaBroker({
    ...options,
    socketGid: process.getgid(),
    async docker(method, path) {
      calls.push({ method, path });
      if (path.startsWith("/networks/")) return { Internal: true };
      if (path.includes(one)) return { Config: { Labels: {} }, State: { Running: true } };
      throw Object.assign(new Error("not found"), { status: 404 });
    },
  });
  t.after(async () => {
    await new Promise((resolve) => broker.server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });
  const socketPath = join(temp, "broker.sock");
  await broker.listen(socketPath);
  async function get(path, method = "GET", body) {
    const result = await new Promise((resolve, reject) => {
      const req = request(
        { socketPath, method, path, headers: { "content-type": "application/json" } },
        resolve,
      );
      req.once("error", reject);
      req.end(body && JSON.stringify(body));
    });
    const chunks = [];
    for await (const chunk of result) chunks.push(chunk);
    return { status: result.statusCode, body: Buffer.concat(chunks).toString() };
  }
  assert.equal((await get(`/instances/${one}`)).status, 409);
  assert.equal((await get(`/instances/${two}`)).status, 200);
  assert.equal((await get("/instances/existing-production-cpa/stop", "POST", {})).status, 404);
  assert.equal(
    (
      await get(`/instances/${two}/ensure`, "POST", {
        ...input,
        proxyUrl: "http://attacker.invalid:8080",
      })
    ).status,
    400,
  );
  assert.equal(
    (await get(`/instances/${two}/request?path=${encodeURIComponent("/containers/json")}`)).status,
    403,
  );
  assert.ok(!calls.some((call) => call.method === "POST"));
});

test("broker streams upstream status, headers and chunks without buffering the full response", async (t) => {
  let continueResponse;
  const continuation = new Promise((resolve) => {
    continueResponse = resolve;
  });
  const upstream = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/messages?beta=true");
    assert.equal(req.headers.authorization, "Bearer instance-internal");
    res.writeHead(429, {
      "content-type": "text/event-stream",
      "retry-after": "9",
      "x-request-id": "upstream-id",
    });
    res.write("data: first\n\n");
    await continuation;
    res.end("data: last\n\n");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const temp = await mkdtemp(join(tmpdir(), "cpa-broker-stream-"));
  const broker = createCpaBroker({
    ...options,
    socketGid: process.getgid(),
    requestUpstream: (settings, callback) =>
      request({ ...settings, port: upstream.address().port }, callback),
    async docker(_method, path) {
      if (path.startsWith("/networks/")) return { Internal: true };
      return {
        Config: {
          Labels: {
            "dev.remote-browser.cpa-managed": "true",
            "dev.remote-browser.cpa-instance": one,
          },
        },
        State: { Running: true },
        NetworkSettings: { Networks: { [options.network]: { IPAddress: "127.0.0.1" } } },
      };
    },
  });
  const socketPath = join(temp, "broker.sock");
  await broker.listen(socketPath);
  t.after(async () => {
    continueResponse();
    await Promise.all([
      new Promise((resolve) => broker.server.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
    await rm(temp, { recursive: true, force: true });
  });
  const result = await new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method: "POST",
        path: `/instances/${one}/request?path=${encodeURIComponent("/v1/messages?beta=true")}`,
        headers: { authorization: "Bearer instance-internal", "content-type": "application/json" },
      },
      resolve,
    );
    req.once("error", reject);
    req.end('{"stream":true}');
  });
  assert.equal(result.statusCode, 429);
  assert.equal(result.headers["retry-after"], "9");
  assert.equal(result.headers["x-request-id"], "upstream-id");
  let content = "";
  for await (const chunk of result) {
    content += chunk;
    if (content.includes("first")) continueResponse();
  }
  assert.equal(content, "data: first\n\ndata: last\n\n");
});

test("broker refuses a network that permits direct Internet egress", async () => {
  const broker = createCpaBroker({ ...options, docker: async () => ({ Internal: false }) });
  await assert.rejects(() => broker.listen("/tmp/not-created-cpa.sock"), /internal Docker network/);
});

test("removal deletes only its labelled container and volumes, and retries partially completed cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cpa-remove-"));
  const tagged = (id) => ({
    "dev.remote-browser.cpa-managed": "true",
    "dev.remote-browser.cpa-instance": id,
  });
  const resources = new Map();
  const container = `/containers/remote-browser-${one}`;
  resources.set(container, {
    Config: { Labels: { ...tagged(one), "dev.remote-browser.cpa-deployment": options.network } },
    State: { Running: true },
  });
  for (const kind of ["config", "auth", "static"]) {
    const Name = `remote-browser-${one}-${kind}`;
    resources.set(`/volumes/${Name}`, { Name, Labels: tagged(one) });
  }
  const foreign = resources.get(`/volumes/remote-browser-${one}-static`);
  foreign.Labels = tagged(two);
  const removed = [];
  let busy = true;
  const broker = createCpaBroker({
    ...options,
    socketGid: process.getgid(),
    async docker(method, path) {
      if (path === `/networks/${options.network}`) return { Internal: true };
      const name = path.replace(/\/json$|\?force=1$/, "");
      if (!resources.has(name)) throw Object.assign(new Error("missing"), { status: 404 });
      if (method === "GET") return resources.get(name);
      if (name.endsWith("-auth") && busy) throw Object.assign(new Error("busy"), { status: 409 });
      assert.equal(method, "DELETE");
      resources.delete(name);
      removed.push(name);
    },
  });
  const socketPath = join(directory, "broker.sock");
  await broker.listen(socketPath);
  t.after(async () => {
    await new Promise((resolve) => broker.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const remove = async () => {
    const response = await new Promise((resolve, reject) => {
      const req = request({ socketPath, method: "DELETE", path: `/instances/${one}` }, resolve);
      req.once("error", reject);
      req.end();
    });
    for await (const _chunk of response) {
      /* consume response */
    }
    return response.statusCode;
  };
  assert.equal(await remove(), 409);
  assert.deepEqual(removed, [], "validate every volume before removing anything");
  foreign.Labels = tagged(one);
  assert.equal(await remove(), 500);
  assert.deepEqual(removed, [container, `/volumes/remote-browser-${one}-config`]);
  busy = false;
  assert.equal(await remove(), 200);
  assert.equal(resources.size, 0);
  assert.equal(await remove(), 200);
  assert.equal(removed.length, 4);
});

test("the broker refuses a Docker Engine older than API 1.47 with a clear message", async () => {
  const broker = createCpaBroker({
    ...options,
    docker: async (_method, path) =>
      path === "/version" ? { ApiVersion: "1.45" } : { Internal: true },
  });
  await assert.rejects(() => broker.listen("/tmp/not-created-cpa.sock"), /Docker Engine 27\.3/);
});

test("reconcile moves an outdated instance to its own network and keeps its volumes", async () => {
  const tagged = {
    "dev.remote-browser.cpa-managed": "true",
    "dev.remote-browser.cpa-instance": one,
  };
  const network = instanceNetwork(one);
  const state = {
    container: {
      Id: "old",
      Image: "sha256:old",
      Config: { Labels: { ...tagged, "com.docker.compose.project": "remote-claude-browser" } },
      State: { Running: true },
      NetworkSettings: { Networks: { [options.network]: { IPAddress: "172.30.0.5" } } },
    },
    networks: new Map(),
    self: { Id: "broker-id", NetworkSettings: { Networks: { [options.network]: {} } } },
  };
  const calls = [];
  let collisions = 1;
  const missing = () => Object.assign(new Error("missing"), { status: 404 });
  const broker = createCpaBroker({
    ...options,
    self: "broker-host",
    log: () => {},
    async docker(method, path, body) {
      calls.push(`${method} ${path.split("?")[0]}`);
      if (path.startsWith("/containers/json?"))
        return [
          {
            Labels: state.container.Config.Labels,
            NetworkSettings: state.container.NetworkSettings,
          },
          // Another deployment's instance, and one from before deployment labels on another
          // network: neither is this broker's to touch.
          {
            Labels: {
              ...tagged,
              "dev.remote-browser.cpa-instance": two,
              "dev.remote-browser.cpa-deployment": "production-network",
            },
            NetworkSettings: { Networks: { [instanceNetwork(two)]: {} } },
          },
          {
            Labels: { ...tagged, "dev.remote-browser.cpa-instance": three },
            NetworkSettings: { Networks: { "production-network": {} } },
          },
        ];
      if (path.includes(two) || path.includes(three))
        throw new Error(`touched another deployment: ${method} ${path}`);
      if (path === `/images/${options.image}/json`)
        return { Id: "sha256:new", Config: { Labels: { "com.docker.compose.service": "cpa" } } };
      if (path.startsWith("/volumes/")) return { Name: path.slice(9), Labels: tagged };
      if (path === `/containers/remote-browser-${one}/json`) {
        if (!state.container) throw missing();
        return state.container;
      }
      if (path === "/containers/broker-host/json") return state.self;
      if (path === `/networks/${network}`) {
        if (!state.networks.has(network)) throw missing();
        return state.networks.get(network);
      }
      if (path === "/networks/create") {
        if (collisions-- > 0) throw Object.assign(new Error("overlap"), { status: 403 });
        state.networks.set(body.Name, {
          Name: body.Name,
          Internal: body.Internal,
          Labels: body.Labels,
        });
        return { Id: "net" };
      }
      if (path === `/networks/${network}/connect`) {
        assert.equal(body.Container, "broker-id");
        assert.deepEqual(body.EndpointConfig.Aliases, ["runtime-egress"]);
        state.self.NetworkSettings.Networks[network] = {};
        return null;
      }
      if (path.startsWith(`/containers/remote-browser-${one}/stop`)) {
        state.container.State.Running = false;
        return null;
      }
      if (path === `/containers/remote-browser-${one}?force=1`) {
        state.container = null;
        return null;
      }
      if (path.startsWith("/containers/create?name=")) {
        assert.equal(body.HostConfig.NetworkMode, network);
        assert.equal(body.Labels["com.docker.compose.service"], "");
        assert.equal(body.Labels["com.docker.compose.project"], "");
        assert.equal(body.Labels["dev.remote-browser.cpa-deployment"], options.network);
        assert.deepEqual(
          body.HostConfig.Mounts.map((mount) => mount.Source),
          ["config", "auth", "static"].map((kind) => `remote-browser-${one}-${kind}`),
        );
        state.container = {
          Id: "new",
          Image: "sha256:new",
          Config: { Labels: { ...body.Labels } },
          State: { Running: false },
          NetworkSettings: { Networks: {} },
        };
        return { Id: "new" };
      }
      if (path === `/containers/remote-browser-${one}/start`) {
        state.container.State.Running = true;
        return null;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  });
  assert.deepEqual(await broker.reconcile(), { current: 0, replaced: 1, failed: 0 });
  assert.equal(state.container.Id, "new");
  assert.equal(state.container.State.Running, true, "a running instance comes back running");
  assert.ok(state.networks.get(network).Internal);
  assert.ok(!calls.some((call) => call.startsWith("DELETE /volumes/")));
  calls.length = 0;
  assert.deepEqual(await broker.reconcile(), { current: 1, replaced: 0, failed: 0 });
  assert.ok(!calls.some((call) => call.startsWith("POST /containers/create")));
});

/**
 * Runs the initializer script against an in-memory /config, /auth and /static that enforce what
 * the initializer container has: root with CAP_CHOWN but without CAP_FOWNER, so chmod needs the
 * file to be owned by root.
 */
async function runInitializer(files) {
  const error = (code) => Object.assign(new Error(code), { code });
  const resolve = (path) => {
    const entry = files.get(path);
    if (!entry) throw error("ENOENT");
    return entry.type === "symlink" ? resolve(entry.target) : entry;
  };
  const fs = {
    async chown(path, uid) {
      resolve(path).uid = uid;
    },
    async lchown(path, uid) {
      if (!files.has(path)) throw error("ENOENT");
      files.get(path).uid = uid;
    },
    async chmod(path, mode) {
      const entry = resolve(path);
      if (entry.uid !== 0) throw error("EPERM");
      entry.mode = mode;
    },
    async link(from, to) {
      if (files.has(to)) throw error("EEXIST");
      files.set(to, resolve(from));
    },
    async rm(path) {
      files.delete(path);
    },
    async lstat(path) {
      if (!files.has(path)) throw error("ENOENT");
      return { isFile: () => files.get(path).type === "file" };
    },
  };
  const proc = { exitCode: undefined };
  const body = INITIALIZE.replace("(async()=>", "return (async()=>");
  assert.notEqual(body, INITIALIZE);
  await new Function("require", "process", "console", body)(() => fs, proc, { error() {} });
  return proc.exitCode ?? 0;
}
const volumeFiles = (owner) =>
  new Map(
    ["/config", "/auth", "/static"].map((path) => [path, { type: "dir", uid: owner, mode: 0o700 }]),
  );

test("the initializer writes a new config.yaml and keeps an existing one the CPA user owns", async () => {
  const fresh = volumeFiles(0);
  fresh.set("/config/.initial-config.yaml", { type: "file", uid: 0, mode: 0o600, data: "new" });
  assert.equal(await runInitializer(fresh), 0);
  assert.deepEqual(fresh.get("/config/config.yaml"), {
    type: "file",
    uid: 10003,
    mode: 0o600,
    data: "new",
  });
  assert.ok(!fresh.has("/config/.initial-config.yaml"));
  for (const path of ["/config", "/auth", "/static"]) assert.equal(fresh.get(path).uid, 10003);

  // The volumes outlive the container: a restore, a removed container, a replacement cut short.
  const existing = volumeFiles(10003);
  existing.set("/config/config.yaml", { type: "file", uid: 10003, mode: 0o644, data: "old" });
  existing.set("/config/.initial-config.yaml", { type: "file", uid: 0, mode: 0o600, data: "new" });
  assert.equal(await runInitializer(existing), 0);
  assert.deepEqual(existing.get("/config/config.yaml"), {
    type: "file",
    uid: 10003,
    mode: 0o600,
    data: "old",
  });
  assert.ok(!existing.has("/config/.initial-config.yaml"));

  const linked = volumeFiles(10003);
  linked.set("/auth/token.json", { type: "file", uid: 10003, mode: 0o600 });
  linked.set("/config/config.yaml", { type: "symlink", target: "/auth/token.json" });
  linked.set("/config/.initial-config.yaml", { type: "file", uid: 0, mode: 0o600, data: "new" });
  assert.equal(await runInitializer(linked), 1, "a link in place of config.yaml is refused");
  assert.equal(linked.get("/auth/token.json").uid, 10003);
});

/** A Docker daemon holding one deployment's CPA resources in memory. */
function fakeDocker(state) {
  const missing = () => Object.assign(new Error("missing"), { status: 404 });
  return async (method, path, body) => {
    const [route, query = ""] = path.split("?");
    if (route === `/networks/${options.network}`) return { Internal: true };
    if (route === `/images/${options.image}/json`) return { Id: "sha256:engine", Config: {} };
    if (route === "/containers/json")
      return [...state.containers.values()].map((value) => ({
        Id: value.Id,
        Names: [value.Name],
        Labels: value.Config.Labels,
      }));
    if (route.startsWith("/networks/") && method === "GET") {
      const value = state.networks.get(route.slice(10));
      if (!value) throw missing();
      return value;
    }
    if (route === "/networks/create") {
      if (state.overlaps) throw Object.assign(new Error("overlap"), { status: 403 });
      state.networks.set(body.Name, { Name: body.Name, Internal: true, Labels: body.Labels });
      return { Id: body.Name };
    }
    if (route.startsWith("/volumes/") && method === "GET") {
      const value = state.volumes.get(route.slice(9));
      if (!value) throw missing();
      return value;
    }
    if (route.startsWith("/volumes/") && method === "DELETE")
      return void state.volumes.delete(route.slice(9));
    if (route === "/volumes/create") {
      state.volumes.set(body.Name, { Name: body.Name, Labels: body.Labels });
      return null;
    }
    if (route === "/containers/create") {
      const name = new URLSearchParams(query).get("name");
      if (state.containers.has(name)) throw Object.assign(new Error("conflict"), { status: 409 });
      const Id = `id-${++state.serial}`;
      state.containers.set(name, {
        Id,
        Name: `/${name}`,
        Image: "sha256:engine",
        Config: { Labels: { ...body.Labels } },
        State: { Running: false },
        NetworkSettings: { Networks: { [body.HostConfig.NetworkMode]: { IPAddress: "10.0.0.2" } } },
      });
      return { Id };
    }
    const match = /^\/containers\/([^/]+)(\/[a-z]+)?$/.exec(route);
    if (match) {
      const entry = [...state.containers.entries()].find(
        ([name, value]) => name === match[1] || value.Id === match[1],
      );
      if (!entry) throw missing();
      const [name, value] = entry;
      if (method === "DELETE") return void state.containers.delete(name);
      if (match[2] === "/json") return value;
      if (match[2] === "/archive") return null;
      if (match[2] === "/start") {
        value.State.Running = true;
        return null;
      }
      if (match[2] === "/wait") return { StatusCode: 0 };
      if (match[2] === "/stop") {
        value.State.Running = false;
        return null;
      }
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
}
const deploymentState = () => ({
  containers: new Map(),
  networks: new Map(),
  volumes: new Map(),
  serial: 0,
});
async function brokerRequest(socketPath, method, path, body) {
  const response = await new Promise((resolve, reject) => {
    const req = request(
      { socketPath, method, path, headers: { "content-type": "application/json" } },
      resolve,
    );
    req.once("error", reject);
    req.end(body);
  });
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return { status: response.statusCode, body: Buffer.concat(chunks).toString() };
}
async function listening(t, broker) {
  const directory = await mkdtemp(join(tmpdir(), "cpa-broker-"));
  const socketPath = join(directory, "broker.sock");
  await broker.listen(socketPath);
  t.after(async () => {
    await new Promise((resolve) => broker.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return socketPath;
}
// waitReady's probe: the instance answers at once.
const readyUpstream = (_settings, callback) =>
  Object.assign(new EventEmitter(), {
    end: () => callback({ statusCode: 200, resume() {} }),
    destroy() {},
  });
const managedLabels = (id, extra = {}) => ({
  "dev.remote-browser.cpa-managed": "true",
  "dev.remote-browser.cpa-instance": id,
  "dev.remote-browser.cpa-deployment": options.network,
  ...extra,
});

test("ensure recreates an instance whose container is gone but whose volumes remain", async (t) => {
  const state = deploymentState();
  const broker = createCpaBroker({
    ...options,
    socketGid: process.getgid(),
    docker: fakeDocker(state),
    requestUpstream: readyUpstream,
  });
  const socketPath = await listening(t, broker);
  const ensure = () =>
    brokerRequest(socketPath, "POST", `/instances/${one}/ensure`, JSON.stringify(input));
  assert.equal((await ensure()).status, 200);
  assert.equal(state.volumes.size, 3);
  for (const volume of state.volumes.values())
    assert.equal(volume.Labels["dev.remote-browser.cpa-deployment"], options.network);
  assert.deepEqual([...state.containers.keys()], [`remote-browser-${one}`]);

  // A replacement cut short after removing the container, `docker rm`, or a restore; and an
  // initializer left by a broker that stopped while it ran.
  state.containers.delete(`remote-browser-${one}`);
  state.containers.set(`remote-browser-${one}-init`, {
    Id: "left",
    Name: `/remote-browser-${one}-init`,
    Config: { Labels: managedLabels(one, { "dev.remote-browser.cpa-role": "initializer" }) },
    State: { Running: true },
  });
  assert.equal((await ensure()).status, 200);
  assert.deepEqual([...state.containers.keys()], [`remote-browser-${one}`]);
  assert.equal(state.containers.get(`remote-browser-${one}`).State.Running, true);
  assert.equal(state.volumes.size, 3, "the volumes were kept");
});

test("reconcile removes initializers left by a broker that stopped mid-way", async () => {
  const state = deploymentState();
  state.containers.set(`remote-browser-${one}-init`, {
    Id: "named",
    Name: `/remote-browser-${one}-init`,
    Config: { Labels: managedLabels(one, { "dev.remote-browser.cpa-role": "initializer" }) },
  });
  // From before initializers had a name.
  state.containers.set("happy_turing", {
    Id: "legacy",
    Name: "/happy_turing",
    Config: { Labels: managedLabels(two) },
  });
  // Another deployment's.
  state.containers.set(`remote-browser-${three}-init`, {
    Id: "foreign",
    Name: `/remote-browser-${three}-init`,
    Config: {
      Labels: managedLabels(three, {
        "dev.remote-browser.cpa-role": "initializer",
        "dev.remote-browser.cpa-deployment": "production-network",
      }),
    },
  });
  const broker = createCpaBroker({ ...options, docker: fakeDocker(state), log: () => {} });
  assert.deepEqual(await broker.reconcile(), { current: 0, replaced: 0, failed: 0 });
  assert.deepEqual([...state.containers.keys()], [`remote-browser-${three}-init`]);
});

test("broker answers bad requests, other deployments' volumes and a full subnet pool clearly", async (t) => {
  assert.throws(
    () => createCpaBroker({ ...options, subnets: "10.0.0.0/30" }),
    /CPA_INSTANCE_SUBNETS/,
  );
  const state = deploymentState();
  const broker = createCpaBroker({
    ...options,
    subnets: "10.254.0.0/26",
    socketGid: process.getgid(),
    docker: fakeDocker(state),
    requestUpstream: readyUpstream,
  });
  const socketPath = await listening(t, broker);
  const ensure = (id, body) => brokerRequest(socketPath, "POST", `/instances/${id}/ensure`, body);
  assert.equal((await ensure(one, "{not json")).status, 400);
  assert.equal((await ensure(one, "[]")).status, 400);
  assert.equal((await ensure(one, JSON.stringify({ ...input, proxyUrl: 7 }))).status, 400);
  assert.equal((await ensure(one, JSON.stringify({ ...input, proxyUrl: "::" }))).status, 400);

  state.overlaps = true;
  const full = await ensure(one, JSON.stringify(input));
  assert.equal(full.status, 503);
  assert.match(JSON.parse(full.body).error, /CPA_INSTANCE_SUBNETS/);
  state.overlaps = false;

  const name = `remote-browser-${two}-config`;
  state.volumes.set(name, {
    Name: name,
    Labels: managedLabels(two, { "dev.remote-browser.cpa-deployment": "production-network" }),
  });
  assert.equal((await brokerRequest(socketPath, "DELETE", `/instances/${two}`)).status, 409);
  assert.ok(state.volumes.has(name));
  // A volume from before deployment labels is accepted for its instance.
  delete state.volumes.get(name).Labels["dev.remote-browser.cpa-deployment"];
  assert.equal((await brokerRequest(socketPath, "DELETE", `/instances/${two}`)).status, 200);
  assert.equal(state.volumes.size, 0);
});

test("the egress relay closes idle connections and caps how many are open", async (t) => {
  const upstream = createTcpServer((socket) => socket.on("data", (data) => socket.write(data)));
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const broker = createCpaBroker({
    ...options,
    docker: async () => ({ Internal: true }),
    egress: `127.0.0.1:${upstream.address().port}`,
    relayIdleMs: 200,
    relayMaxConnections: 1,
  });
  await new Promise((resolve) => broker.relay.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    broker.relay.close();
    upstream.close();
  });
  const port = broker.relay.address().port;
  const first = connectTcp({ port, host: "127.0.0.1" });
  first.write("ping");
  const [echo] = await once(first, "data");
  assert.equal(echo.toString(), "ping");
  const second = connectTcp({ port, host: "127.0.0.1" });
  await once(second, "close");
  const started = Date.now();
  await once(first, "close");
  assert.ok(Date.now() - started < 2000, "an idle connection is closed");
});
