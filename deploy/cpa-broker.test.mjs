import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedUpstream, containerSpec, initializerSpec, createCpaBroker } from "./cpa-broker.mjs";

const one = "cpa-11111111111111111111",
  two = "cpa-22222222222222222222";
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
  assert.equal(first.HostConfig.NetworkMode, options.network);
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
  const init = initializerSpec(one, options, input);
  assert.equal(init.Image, first.Image);
  assert.equal(init.HostConfig.NetworkMode, "none");
  assert.deepEqual(init.HostConfig.CapAdd, ["CHOWN"]);
  assert.equal(init.HostConfig.AutoRemove, undefined);
  const config = JSON.parse(init.Env[0].slice("CPA_INITIAL_CONFIG=".length));
  assert.equal(config.requests["proxy-url"], input.proxyUrl);
  assert.equal(config.access["api-keys"][0], input.apiKey);
  assert.equal(config.management["secret-key"], input.managementKey);
});

test("broker allowlist includes verified v8 paths and excludes arbitrary management and Docker routes", () => {
  assert.ok(allowedUpstream("POST", "/v8/management/oauth/auth-url"));
  assert.ok(allowedUpstream("GET", "/v8/management/oauth/status?state=one"));
  assert.ok(allowedUpstream("PATCH", "/v8/management/credentials/fields"));
  assert.ok(allowedUpstream("GET", "/v8/management/credentials/download?name=one.json"));
  assert.ok(allowedUpstream("POST", "/v1/messages"));
  assert.ok(!allowedUpstream("GET", "/v8/management/config.yaml"));
  assert.ok(!allowedUpstream("POST", "/containers/create"));
  assert.ok(!allowedUpstream("POST", "http://other/v1/messages"));
  assert.ok(!allowedUpstream("POST", "//other/v1/messages"));
  assert.ok(!allowedUpstream("GET", "/v1/../v8/management/config.yaml"));
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
    (
      await get(
        `/instances/${two}/request?path=${encodeURIComponent("/v8/management/config.yaml")}`,
      )
    ).status,
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
