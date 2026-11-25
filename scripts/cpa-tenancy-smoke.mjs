import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import {
  createDockerClient,
  containerSpec,
  initializerSpec,
  createCpaBroker,
  instanceConfig,
  instanceNetwork,
  singleFileTar,
} from "../deploy/cpa-broker.mjs";
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
const networks = [];
let networkCreated = false;
const certificates = await mkdtemp(join(tmpdir(), "cpa-timezone-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=api.anthropic.com",
    "-addext",
    "subjectAltName=DNS:api.anthropic.com,DNS:platform.claude.com",
    "-keyout",
    join(certificates, "key.pem"),
    "-out",
    join(certificates, "cert.pem"),
  ],
  { stdio: "ignore" },
);
const cert = await readFile(join(certificates, "cert.pem"), "utf8");
const certKey = await readFile(join(certificates, "key.pem"), "utf8");
// Only this disposable engine sees the fake TLS upstream. Every CONNECT stays on loopback.
const fixtureRunner = `
const fs = require('node:fs');
const http = require('node:http'), https = require('node:https'), net = require('node:net');
const {spawn} = require('node:child_process');
fs.writeFileSync('/tmp/cpa-fixture.crt', process.env.FIXTURE_CERT);
const api = https.createServer({cert:process.env.FIXTURE_CERT,key:process.env.FIXTURE_KEY},async(req,res)=>{
 if(req.url==='/v1/oauth/token'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({access_token:'sk-ant-oat-new-fixture',refresh_token:'new-fixture-refresh',expires_in:86400,account:{uuid:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',email_address:'new@tenancy.test'}}));return;}
 if(req.url==='/api/oauth/profile'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({account:{uuid:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',email:'new@tenancy.test'}}));return;}
 if(!req.url.startsWith('/v1/messages')){res.writeHead(200,{'content-type':'application/json'}).end('{}');return;}
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=JSON.parse(raw);fs.writeFileSync('/tmp/cpa-wire.json',JSON.stringify(body));
 res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:'msg_fixture',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'fixture-ok'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}));
});
const proxy=http.createServer();proxy.on('connect',(req,socket,head)=>{const target=net.connect(18443,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');if(head.length)target.write(head);socket.pipe(target).pipe(socket)});target.on('error',()=>socket.destroy());socket.on('error',()=>target.destroy());});
api.listen(18443,'127.0.0.1',()=>proxy.listen(18080,'127.0.0.1',()=>{
 const child=spawn('/app/CLIProxyAPI',['--config','/config/config.yaml','--local-model'],{stdio:'inherit',env:{...process.env,SSL_CERT_FILE:'/tmp/cpa-fixture.crt'}});
 process.on('SIGTERM',()=>child.kill());child.on('exit',code=>process.exit(code??0));
}));`;
const values = ids.map(() => ({
  apiKey: randomBytes(32).toString("base64url"),
  managementKey: randomBytes(32).toString("base64url"),
  proxyUrl: "http://opaque:x@runtime-egress:8781",
}));
const fetchScript = `let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',async()=>{try{const q=JSON.parse(data);const r=await fetch('http://127.0.0.1:8317'+q.path,{method:q.method||'GET',headers:{authorization:'Bearer '+q.key,'content-type':'application/json',...q.headers},body:q.body===undefined?undefined:JSON.stringify(q.body),signal:AbortSignal.timeout(2500)});console.log(JSON.stringify({status:r.status,body:await r.text()}))}catch(e){console.log(JSON.stringify({error:e.name}))}});`;
function query(index, path, body, method, key, headers) {
  return JSON.parse(
    execFileSync("docker", ["exec", "-i", containers[index], "node", "-e", fetchScript], {
      input: JSON.stringify({
        path,
        body,
        method,
        key: key ?? values[index].managementKey,
        headers,
      }),
      encoding: "utf8",
    }),
  );
}
try {
  await docker("POST", "/networks/create", { Name: network, Internal: true });
  networkCreated = true;
  for (let i = 0; i < ids.length; i++) {
    // Each instance gets its own internal network, labelled as the broker creates it.
    await docker("POST", "/networks/create", {
      Name: instanceNetwork(ids[i]),
      Internal: true,
      Labels: {
        "dev.remote-browser.cpa-managed": "true",
        "dev.remote-browser.cpa-instance": ids[i],
        "dev.remote-browser.cpa-deployment": network,
      },
    });
    networks.push(instanceNetwork(ids[i]));
    const spec = containerSpec(ids[i], options);
    if (i === 0) {
      spec.Cmd = ["node", "-e", fixtureRunner];
      spec.Env.push(`FIXTURE_CERT=${cert}`, `FIXTURE_KEY=${certKey}`);
    }
    for (const mount of spec.HostConfig.Mounts) {
      await docker("POST", "/volumes/create", { Name: mount.Source, Labels: spec.Labels });
      volumes.push(mount.Source);
    }
    const init = await docker("POST", "/containers/create", initializerSpec(ids[i], options));
    try {
      await docker(
        "PUT",
        `/containers/${init.Id}/archive?path=/config`,
        singleFileTar(".initial-config.yaml", JSON.stringify(instanceConfig(values[i])) + "\n"),
        "application/x-tar",
      );
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
      access_token: "sk-ant-oat-fixture-not-a-real-token",
      refresh_token: "test-not-a-real-refresh",
      expired: new Date(Date.now() + 86400000).toISOString(),
      last_refresh: new Date().toISOString(),
      account_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      claude_device_ids: ["0".repeat(64)],
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
    query(
      0,
      "/v8/management/config/requests/proxy-url",
      "http://cpa-unbound:x@runtime-egress:8781",
      "PUT",
    ).status,
    200,
    "default egress migration failed",
  );
  const model = JSON.parse(
    query(0, "/v1/models", undefined, undefined, values[0].apiKey).body,
  ).data.find((item) => item.id.startsWith("claude-")).id;
  const dates = [];
  const oauth = query(
    0,
    "/v8/management/oauth/auth-url",
    { provider: "claude", proxy_url: "http://127.0.0.1:18080" },
    "POST",
  );
  assert.equal(oauth.status, 200, "oauth auth-url failed");
  const session = JSON.parse(oauth.body);
  assert.ok(session.state && session.url);
  for (const timezone of ["Etc/GMT+12", "Pacific/Kiritimati"]) {
    assert.equal(
      query(
        0,
        "/v8/management/credentials/fields",
        { name: "alice.json", proxy_url: "http://127.0.0.1:18080", timezone },
        "PATCH",
      ).status,
      200,
    );
    const generated = query(
      0,
      "/v1/messages",
      { model, max_tokens: 16, messages: [{ role: "user", content: "timezone fixture" }] },
      "POST",
      values[0].apiKey,
      { "x-session-id": `fixture-${timezone}` },
    );
    assert.equal(generated.status, 200, `mock inference failed: ${generated.body}`);
    const wire = execFileSync("docker", ["exec", containers[0], "cat", "/tmp/cpa-wire.json"], {
      encoding: "utf8",
    });
    const expectedDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    assert.ok(
      wire.includes(`Today's date is ${expectedDate}`),
      `credential timezone ${timezone} did not reach generated request date`,
    );
    dates.push(expectedDate);
  }
  assert.notEqual(
    dates[0],
    dates[1],
    "opposing exit timezones must generate different local dates",
  );
  assert.equal(
    query(
      0,
      "/v8/management/oauth/callback",
      { provider: "claude", state: session.state, code: "fixture-code" },
      "POST",
    ).status,
    200,
  );
  let authorized;
  for (let attempt = 0; attempt < 30; attempt++) {
    authorized = JSON.parse(
      query(0, "/v8/management/oauth/status?state=" + encodeURIComponent(session.state)).body,
    );
    if (authorized.status !== "wait") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(authorized.status, "ok", "fixture OAuth did not finish");
  const added = JSON.parse(query(0, "/v8/management/credentials").body).files.find(
    (entry) => entry.email === "new@tenancy.test",
  );
  assert.ok(added, "OAuth did not publish its credential");
  const persistedOAuth = JSON.parse(
    query(0, "/v8/management/credentials/download?name=" + encodeURIComponent(added.name)).body,
  );
  assert.equal(
    persistedOAuth.proxy_url,
    "http://127.0.0.1:18080",
    "new credentials must carry their OAuth exit before gateway reconciliation",
  );
  assert.equal(
    query(
      0,
      "/v8/management/credentials?name=" + encodeURIComponent(added.name),
      undefined,
      "DELETE",
    ).status,
    200,
  );
  assert.equal(
    query(0, "/v8/management/credentials/status", { name: "alice.json", disabled: true }, "PATCH")
      .status,
    200,
  );
  assert.equal(JSON.parse(query(0, "/v8/management/credentials").body).files[0].disabled, true);
  assert.equal(
    query(0, "/v8/management/credentials?name=alice.json", undefined, "DELETE").status,
    200,
  );
  assert.equal(JSON.parse(query(0, "/v8/management/credentials").body).files.length, 0);
  const broker = createCpaBroker({ ...options, socketGid: process.getgid() });
  const socketPath = join(certificates, "broker.sock");
  await broker.listen(socketPath);
  try {
    for (const id of ids) {
      const response = await new Promise((resolve, reject) => {
        const req = request({ socketPath, method: "DELETE", path: `/instances/${id}` }, resolve);
        req.once("error", reject);
        req.end();
      });
      for await (const _chunk of response) {
        /* consume response */
      }
      assert.equal(response.statusCode, 200, "managed CPA removal failed");
      const container = containers.shift();
      await assert.rejects(() => docker("GET", `/containers/${container}/json`), { status: 404 });
      await assert.rejects(() => docker("GET", `/networks/${instanceNetwork(id)}`), {
        status: 404,
      });
      for (const volume of volumes.splice(0, 3))
        await assert.rejects(() => docker("GET", `/volumes/${volume}`), { status: 404 });
      if (containers.length) assert.ok(await docker("GET", `/containers/${containers[0]}/json`));
    }
  } finally {
    await new Promise((resolve) => broker.server.close(resolve));
  }
  console.log(
    JSON.stringify({
      passed: true,
      instances: 2,
      independentVolumes: true,
      credentialIsolation: true,
      apiKeyIsolation: true,
      managementKeyIsolation: true,
      proxyPatchPersisted: true,
      credentialTimezoneOnWire: true,
      oauthV8Routes: true,
      inferenceDuringOAuth: true,
      oauthExitPersistedBeforePublication: true,
      managedContainerAndVolumesRemoved: true,
      credentialStatusAndDelete: true,
    }),
  );
} finally {
  await rm(certificates, { recursive: true, force: true });
  const removedContainers = await Promise.allSettled(
    containers.map((id) => docker("DELETE", `/containers/${id}?force=1`)),
  );
  const removedVolumes = await Promise.allSettled(
    volumes.map((name) => docker("DELETE", `/volumes/${name}`)),
  );
  for (const name of networks) await docker("DELETE", `/networks/${name}`).catch(() => {});
  if (networkCreated) await docker("DELETE", `/networks/${network}`);
  if ([...removedContainers, ...removedVolumes].some((result) => result.status === "rejected"))
    throw new Error("Disposable CPA cleanup failed");
}
