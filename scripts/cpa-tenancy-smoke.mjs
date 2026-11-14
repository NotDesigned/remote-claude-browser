import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createDockerClient, containerSpec, initializerSpec } from "../deploy/cpa-broker.mjs";
if (process.env.CPA_TENANCY_SMOKE !== "1")
  throw new Error("Set CPA_TENANCY_SMOKE=1 to create disposable test CPA instances");
const docker = createDockerClient();
const suffix = randomBytes(5).toString("hex");
const network = `cpa-tenancy-smoke-${suffix}`;
const ids = [`cpa-${randomBytes(10).toString("hex")}`, `cpa-${randomBytes(10).toString("hex")}`];
const options = {
  image: process.env.CPA_BROKER_ENGINE_IMAGE || "remote-claude-browser-cpa:local",
  network,
};
const containers = [],
  volumes = [];
let networkCreated = false;
const values = ids.map(() => ({
  apiKey: randomBytes(32).toString("base64url"),
  managementKey: randomBytes(32).toString("base64url"),
  proxyUrl: "http://opaque:x@runtime-egress:8781",
}));
const fetchScript = `let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',async()=>{try{const q=JSON.parse(data);const r=await fetch('http://127.0.0.1:8317'+q.path,{method:q.method||'GET',headers:{authorization:'Bearer '+q.key,'content-type':'application/json'},body:q.body===undefined?undefined:JSON.stringify(q.body),signal:AbortSignal.timeout(2500)});console.log(JSON.stringify({status:r.status,body:await r.text()}))}catch(e){console.log(JSON.stringify({error:e.name}))}});`;
function query(index, path, body, method, key) {
  return JSON.parse(
    execFileSync("docker", ["exec", "-i", containers[index], "node", "-e", fetchScript], {
      input: JSON.stringify({ path, body, method, key: key ?? values[index].managementKey }),
      encoding: "utf8",
    }),
  );
}
try {
  await docker("POST", "/networks/create", { Name: network, Internal: true });
  networkCreated = true;
  for (let i = 0; i < ids.length; i++) {
    const spec = containerSpec(ids[i], options);
    for (const mount of spec.HostConfig.Mounts) {
      await docker("POST", "/volumes/create", { Name: mount.Source, Labels: spec.Labels });
      volumes.push(mount.Source);
    }
    const init = await docker(
      "POST",
      "/containers/create",
      initializerSpec(ids[i], options, values[i]),
    );
    try {
      await docker("POST", `/containers/${init.Id}/start`);
      const state = await docker("POST", `/containers/${init.Id}/wait?condition=not-running`);
      assert.equal(state.StatusCode, 0, "initializer failed");
    } finally {
      await docker("DELETE", `/containers/${init.Id}?force=1`);
    }
    const created = await docker("POST", `/containers/create?name=remote-browser-${ids[i]}`, spec);
    containers.push(created.Id);
    await docker("POST", `/containers/${created.Id}/start`);
    let ready = false;
    for (let n = 0; n < 30; n++) {
      const r = query(i, "/");
      if (r.status === 200) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(ready, "CPA did not start");
  }
  const uploaded = query(
    0,
    "/v8/management/credentials?name=alice.json",
    {
      type: "claude",
      access_token: "test-not-a-real-token",
      refresh_token: "test-not-a-real-refresh",
      email: "alice@tenancy.test",
    },
    "POST",
  );
  assert.equal(uploaded.status, 200, "upload credential failed");
  assert.equal(JSON.parse(query(0, "/v8/management/credentials").body).files.length, 1);
  assert.equal(JSON.parse(query(1, "/v8/management/credentials").body).files.length, 0);
  assert.equal(
    query(1, "/v8/management/credentials", undefined, undefined, values[0].managementKey).status,
    401,
  );
  assert.equal(query(1, "/v1/models", undefined, undefined, values[0].apiKey).status, 401);
  assert.equal(query(0, "/v1/models", undefined, undefined, values[0].apiKey).status, 200);
  const patch = query(
    0,
    "/v8/management/credentials/fields",
    { name: "alice.json", proxy_url: "http://second-node:x@runtime-egress:8781" },
    "PATCH",
  );
  assert.equal(patch.status, 200, "proxy patch failed");
  const persisted = execFileSync(
    "docker",
    [
      "exec",
      containers[0],
      "node",
      "-e",
      "const fs=require('fs');const v=JSON.parse(fs.readFileSync('/auth/alice.json'));process.stdout.write(String(v.proxy_url==='http://second-node:x@runtime-egress:8781'));",
    ],
    { encoding: "utf8" },
  );
  assert.equal(persisted, "true");
  assert.equal(
    query(0, "/v8/management/credentials/status", { name: "alice.json", disabled: true }, "PATCH")
      .status,
    200,
  );
  assert.equal(JSON.parse(query(0, "/v8/management/credentials").body).files[0].disabled, true);
  const oauth = query(
    0,
    "/v8/management/oauth/auth-url",
    { provider: "claude", proxy_url: values[0].proxyUrl },
    "POST",
  );
  assert.equal(oauth.status, 200, "oauth auth-url failed");
  const session = JSON.parse(oauth.body);
  assert.ok(session.state && session.url);
  assert.equal(
    query(0, "/v8/management/oauth/status?state=" + encodeURIComponent(session.state)).status,
    200,
  );
  assert.equal(
    query(0, "/v8/management/credentials?name=alice.json", undefined, "DELETE").status,
    200,
  );
  assert.equal(JSON.parse(query(0, "/v8/management/credentials").body).files.length, 0);
  console.log(
    JSON.stringify({
      passed: true,
      instances: 2,
      independentVolumes: true,
      credentialIsolation: true,
      apiKeyIsolation: true,
      managementKeyIsolation: true,
      proxyPatchPersisted: true,
      oauthV8Routes: true,
      credentialStatusAndDelete: true,
    }),
  );
} finally {
  const removedContainers = await Promise.allSettled(
    containers.map((id) => docker("DELETE", `/containers/${id}?force=1`)),
  );
  const removedVolumes = await Promise.allSettled(
    volumes.map((name) => docker("DELETE", `/volumes/${name}`)),
  );
  if (networkCreated) await docker("DELETE", `/networks/${network}`);
  if ([...removedContainers, ...removedVolumes].some((result) => result.status === "rejected"))
    throw new Error("Disposable CPA cleanup failed");
}
