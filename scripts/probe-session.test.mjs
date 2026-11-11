import assert from "node:assert/strict";
import { test } from "node:test";
import { createProbeSession, readProbeCredentials } from "./probe-session.mjs";

test("probe credentials honor overrides and retain complete file passwords", async () => {
  const read = async () =>
    "# comment\nMIRROR_ADMIN_USERNAME=bootstrap\nMIRROR_ACCESS_PASSWORD=file=password=with=equals\n";
  assert.deepEqual(await readProbeCredentials({ env: {}, read }), {
    username: "bootstrap",
    password: "file=password=with=equals",
  });
  assert.deepEqual(
    await readProbeCredentials({
      env: { MIRROR_PROBE_USERNAME: "probe", MIRROR_PROBE_PASSWORD: "override" },
      read,
    }),
    { username: "probe", password: "override" },
  );
  await assert.rejects(
    readProbeCredentials({ env: {}, read: async () => "" }),
    /Set MIRROR_PROBE_USERNAME/,
  );
});

test("a probe logs in with username, uses only its newly allocated sid and cleans up once", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith("/gate"))
      return new Response(null, {
        status: 303,
        headers: { "set-cookie": "fixture-session=test; Secure; HttpOnly" },
      });
    if (url.endsWith("/api/client/session")) return Response.json({ sid: "client-29" });
    return new Response(null, { status: 204 });
  };
  const probe = await createProbeSession("https://fixture.test", {
    fetcher,
    env: {},
    credentials: { username: "alice", password: "fixture-only" },
  });
  assert.equal(calls[0].body.get("username"), "alice");
  assert.equal(calls[0].body.get("password"), "fixture-only");
  assert.deepEqual(Object.keys(JSON.parse(calls[1].body)), ["clientKey"]);
  const socketUrl = new URL(probe.socketUrl);
  assert.equal(socketUrl.protocol, "wss:");
  assert.equal(socketUrl.searchParams.get("sid"), "client-29");
  assert.match(socketUrl.searchParams.get("connectionKey"), /^[0-9a-f-]{36}$/);
  assert.equal(probe.headers.Cookie, "fixture-session=test");
  let terminated = 0;
  probe.attach({
    terminate() {
      terminated++;
    },
    close() {},
  });
  await probe.close();
  await probe.close();
  assert.equal(terminated, 1);
  assert.deepEqual(
    calls.slice(2).map(({ url, method }) => [url, method]),
    [
      ["https://fixture.test/api/client/session/client-29", "DELETE"],
      ["https://fixture.test/logout", "POST"],
    ],
  );
});

test("cleanup still revokes the login when workspace release fails", async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith("/gate"))
      return new Response(null, { status: 303, headers: { "set-cookie": "fixture-session=test" } });
    if (url.endsWith("/api/client/session")) return Response.json({ sid: "client-1" });
    return new Response(null, { status: url.endsWith("/logout") ? 204 : 500 });
  };
  const probe = await createProbeSession("http://fixture.test", {
    fetcher,
    env: {},
    credentials: { username: "alice", password: "fixture-only" },
  });
  await assert.rejects(probe.close(), /Probe cleanup failed/);
  assert.equal(calls.at(-1), "http://fixture.test/logout");
});

test("a failed admission revokes its new login without touching any existing session", async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith("/gate"))
      return new Response(null, { status: 303, headers: { "set-cookie": "fixture-session=test" } });
    return new Response(null, { status: url.endsWith("/logout") ? 204 : 503 });
  };
  await assert.rejects(
    createProbeSession("https://fixture.test", {
      fetcher,
      env: {},
      credentials: { username: "alice", password: "fixture-only" },
    }),
    /admission failed \(503\)/,
  );
  assert.deepEqual(
    calls.map((url) => new URL(url).pathname),
    ["/gate", "/api/client/session", "/logout"],
  );
});
