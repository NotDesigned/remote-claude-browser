import Fastify from "fastify";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FrontendUser } from "../auth/users";
import type { MihomoProxy } from "../egress/mihomo";
import type { ExitMetadata } from "../egress/timezone";
import type { ProfileRecord } from "../session/profiles";
import {
  callbackCode,
  codeInText,
  createDeviceFlows,
  createGrants,
  createLogins,
  MAX_PENDING_DEVICES_PER_IP,
  normalizeUserCode,
  parseAuthorizeUrl,
} from "./flows";
import { accountChangeRevokesRemoteCc, registerRemoteCcRoutes } from "./routes";
import { createRemoteCcStore, MAX_TOKENS, type RemoteCcStore } from "./store";

const alice: FrontendUser = {
  id: "alice",
  username: "alice",
  role: "user",
  enabled: true,
  createdAt: 1,
};
const bob: FrontendUser = { ...alice, id: "bob", username: "bob" };
const admin: FrontendUser = { ...alice, id: "admin", username: "admin", role: "admin" };
const stores: RemoteCcStore[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const store of stores.splice(0)) store.close();
});
const memoryStore = async (now?: () => number) => {
  const store = await createRemoteCcStore({ file: ":memory:", now });
  stores.push(store);
  return store;
};
const LOGIN_URL =
  "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code" +
  "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference" +
  "&code_challenge=abc&code_challenge_method=S256&state=st4te";

describe("remote-cc token store", () => {
  it("keeps only digests and resolves a token only for its own kind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "remote-cc-store-"));
    try {
      const store = await createRemoteCcStore({ file: join(dir, "remote-cc.sqlite") });
      stores.push(store);
      const client = store.issue("alice", "client", " Laptop ");
      const host = store.issue("admin", "host", "server-la");
      expect(client.token).toMatch(/^rcck_[\w-]{43}$/);
      expect(host.token).toMatch(/^rcch_[\w-]{43}$/);
      expect(client.name).toBe("Laptop");
      const raw = await readFile(join(dir, "remote-cc.sqlite"));
      expect(raw.includes(Buffer.from(client.token))).toBe(false);
      expect(store.resolve(client.token, "client")?.id).toBe(client.id);
      expect(store.resolve(client.token, "host")).toBeUndefined();
      expect(store.resolve(`${client.token}x`, "client")).toBeUndefined();
      expect(JSON.stringify(store.list("alice"))).not.toContain(client.token);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("limits tokens, records host nodes and removes a deleted user's data", async () => {
    let time = 1_000;
    const store = await memoryStore(() => time);
    for (let i = 0; i < MAX_TOKENS; i++) store.issue("alice", "client", `c${i}`);
    expect(() => store.issue("alice", "client", "one more")).toThrow(/最多/);
    const host = store.issue("admin", "host", "egress");
    store.recordHostNode(host.id, "proxy-a", "alice");
    time += 1;
    store.recordHostNode(host.id, "proxy-a", "bob");
    expect(store.hostNodeUsers(host.id, "proxy-a")).toEqual(["bob", "alice"]);
    store.removeUser("bob");
    expect(store.hostNodeUsers(host.id, "proxy-a")).toEqual(["alice"]);
    expect(store.revoke("admin", host.id)).toBe(true);
    expect(store.hostNodeUsers(host.id, "proxy-a")).toEqual([]);
  });
});

describe("remote-cc flows", () => {
  it("hands an approved device token out once; host tokens need an administrator", () => {
    let time = 0;
    const flows = createDeviceFlows({ now: () => time });
    const issue = (userId: string) => ({ token: `tok-${userId}` });
    const client = flows.start("client", "laptop");
    expect(normalizeUserCode(client.userCode.toLowerCase().replace(/(.{4})/, "$1 "))).toBe(
      client.userCode,
    );
    expect(flows.lookup(client.userCode)).toMatchObject({ kind: "client", name: "laptop" });
    expect(flows.poll(client.deviceCode)).toEqual({ status: "pending" });
    flows.approve(client.userCode, alice, issue);
    expect(flows.poll(client.deviceCode)).toEqual({ status: "approved", token: "tok-alice" });
    expect(() => flows.poll(client.deviceCode)).toThrow(/过期/);
    const host = flows.start("host", "server-la");
    expect(() => flows.approve(host.userCode, alice, issue)).toThrow(/管理员/);
    expect(() => flows.deny(host.userCode, alice)).toThrow(/管理员/);
    expect(flows.poll(host.deviceCode)).toEqual({ status: "pending" });
    flows.deny(host.userCode, admin);
    expect(() => flows.poll(host.deviceCode)).toThrow(/拒绝/);
    const late = flows.start("client", "x");
    time += 11 * 60_000;
    expect(() => flows.lookup(late.userCode)).toThrow(/过期/);
    expect(() => flows.poll(late.deviceCode)).toThrow(/过期/);
  });

  it("records who asked and caps pending requests per address and overall", () => {
    const flows = createDeviceFlows();
    const first = flows.start("client", "laptop", { ip: "198.51.100.1", userAgent: "rcc/1.0" });
    expect(flows.lookup(first.userCode)).toMatchObject({
      ip: "198.51.100.1",
      userAgent: "rcc/1.0",
    });
    expect(flows.lookup(flows.start("client", "x").userCode)).toMatchObject({
      ip: null,
      userAgent: null,
    });
    for (let i = 1; i < MAX_PENDING_DEVICES_PER_IP; i++)
      flows.start("client", "laptop", { ip: "198.51.100.1" });
    expect(() => flows.start("client", "laptop", { ip: "198.51.100.1" })).toThrow(/过多/);
    flows.start("client", "laptop", { ip: "198.51.100.2" });
    // An answered request no longer holds a slot, even before its machine polls.
    flows.deny(first.userCode, alice);
    flows.start("client", "laptop", { ip: "198.51.100.1" });
    expect(() => flows.start("client", "laptop", { ip: "198.51.100.1" })).toThrow(/过多/);
    // Many addresses still meet the overall cap (7 pending so far).
    for (let i = 0; i < 193; i++) flows.start("client", "m", { ip: `10.0.${i >> 2}.${i & 3}` });
    expect(() => flows.start("client", "m", { ip: "192.0.2.1" })).toThrow(/过多/);
  });

  it("opens a login once at a time, reopens it when its browser goes, and cancels it", async () => {
    const logins = createLogins();
    const login = logins.create("alice", "p-1", LOGIN_URL, "Laptop");
    expect(login.tokenName).toBe("Laptop");
    let release!: (sid: string) => void;
    let calls = 0;
    const opener = () => {
      calls++;
      return new Promise<string>((resolve) => (release = resolve));
    };
    const both = Promise.all([logins.open(login.id, opener), logins.open(login.id, opener)]);
    release("s-1");
    await both;
    expect(calls).toBe(1);
    expect(login).toMatchObject({ status: "opened", openedIn: "s-1" });
    logins.reopen(login.id);
    expect(login.status).toBe("waiting");
    expect(login.openedIn).toBeUndefined();
    // A failed open leaves it waiting for the next try.
    await logins.open(login.id, async () => {
      throw new Error("tab");
    });
    await logins.open(login.id, async () => undefined);
    expect(login.status).toBe("waiting");
    expect(logins.cancel("bob", login.id)).toBe(false);
    expect(logins.cancel("alice", login.id)).toBe(true);
    expect(() => logins.take("alice", login.id)).toThrow();
  });

  it("revokes remote-cc tokens on a new password or role, or when disabled", () => {
    const user = { role: "user", enabled: true } as const;
    expect(accountChangeRevokesRemoteCc(user, user, false)).toBe(false);
    expect(accountChangeRevokesRemoteCc(user, user, true)).toBe(true);
    expect(accountChangeRevokesRemoteCc(user, { ...user, role: "admin" }, false)).toBe(true);
    expect(accountChangeRevokesRemoteCc({ ...user, role: "admin" }, user, false)).toBe(true);
    expect(accountChangeRevokesRemoteCc(user, { ...user, enabled: false }, false)).toBe(true);
    expect(accountChangeRevokesRemoteCc({ ...user, enabled: false }, user, false)).toBe(false);
  });

  it("signs grants that cannot be altered and expire", () => {
    let time = 0;
    const grants = createGrants(Buffer.from("secret"), { now: () => time });
    const { grant } = grants.issue("alice", "p-1", "proxy-a");
    expect(grants.verify(grant)).toMatchObject({ u: "alice", p: "p-1", n: "proxy-a" });
    const [v, payload, sig] = grant.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), n: "x" }),
    ).toString("base64url");
    expect(() => grants.verify(`${v}.${forged}.${sig}`)).toThrow();
    expect(() => createGrants(Buffer.from("other")).verify(grant)).toThrow();
    time += 11 * 60_000;
    expect(() => grants.verify(grant)).toThrow(/过期/);
  });

  it("accepts only Claude sign-in links and recognizes their callback", () => {
    const parsed = parseAuthorizeUrl(LOGIN_URL);
    expect(parsed).toMatchObject({
      redirect: "https://platform.claude.com/oauth/code/callback",
      state: "st4te",
    });
    for (const bad of [
      "https://evil.example/oauth/authorize?client_id=x&code_challenge=y&state=z&redirect_uri=https://claude.ai/cb",
      LOGIN_URL.replace("platform.claude.com", "evil.example"),
      LOGIN_URL.replace("&state=st4te", ""),
      LOGIN_URL.replace("https://claude.ai", "http://claude.ai"),
      "not a url",
    ])
      expect(() => parseAuthorizeUrl(bad)).toThrow(/登录链接/);
    expect(
      callbackCode(
        parsed.redirect,
        parsed.state,
        "https://platform.claude.com/oauth/code/callback?code=C0DE&state=st4te",
      ),
    ).toBe("C0DE#st4te");
    expect(
      callbackCode(
        parsed.redirect,
        parsed.state,
        "https://platform.claude.com/oauth/code/callback?code=C0DE&state=other",
      ),
    ).toBeUndefined();
    const logins = createLogins();
    const first = logins.create("alice", "p-1", LOGIN_URL);
    const second = logins.create("alice", "p-1", LOGIN_URL);
    expect(logins.forUser("alice").map((login) => login.id)).toEqual([second.id]);
    expect(() => logins.take("bob", second.id)).toThrow();
    expect(() => logins.take("alice", first.id)).toThrow();
  });
});

describe("remote-cc routes", () => {
  const node: MihomoProxy = {
    name: "LA",
    type: "vless",
    server: "node.example.com",
    port: 443,
    uuid: "secret-uuid",
  };
  const setup = async () => {
    const store = await memoryStore();
    const users = new Map([alice, bob, admin].map((user) => [user.id, { ...user }]));
    const profiles: Record<string, ProfileRecord[]> = {
      alice: [
        {
          id: "p-0000000001",
          name: "Work",
          createdAt: 1,
          email: "alice@example.com",
          signedIn: true,
          proxyId: "proxy-a",
          timeZone: "America/Los_Angeles",
          exitIp: "203.0.113.7",
          exitCity: "Los Angeles",
          exitCountry: "United States",
          checkedAt: 5,
        } as ProfileRecord,
        { id: "p-0000000002", name: "Unbound", createdAt: 2 } as ProfileRecord,
      ],
      bob: [{ id: "p-0000000003", name: "Bob", createdAt: 3, proxyId: "proxy-a" } as ProfileRecord],
    };
    const saved: [string, ExitMetadata][] = [];
    /** sid: the session the next open() uses; live: sessions still running. */
    const browser = {
      sid: undefined as string | undefined,
      live: new Set<string>(),
      opened: [] as string[],
      pages: [] as string[],
      delay: undefined as Promise<void> | undefined,
    };
    const app = Fastify();
    const routes = registerRemoteCcRoutes(app, {
      autoOpen: true,
      store,
      secret: Buffer.from("test-secret"),
      publicOrigin: () => "https://rcb.example",
      currentUser: (request) => users.get(String(request.headers["x-test-user"])),
      getUser: (id) => users.get(id),
      profilesFor: (user) => profiles[user.id] ?? [],
      nodesFor: (user) =>
        user.id === "alice" || user.id === "bob"
          ? [{ id: "proxy-a", name: "LA", proxy: node }]
          : [],
      checkExit: async () => ({
        status: "healthy",
        exitIp: "198.51.100.9",
        timeZone: "America/Los_Angeles",
        exitCity: "Los Angeles",
        exitCountry: "United States",
        checkedAt: 9,
      }),
      saveExit: async (id, metadata) => {
        saved.push([id, metadata]);
      },
      browser: {
        open: async (_profile, url) => {
          await browser.delay;
          if (browser.sid) browser.opened.push(url);
          return browser.sid;
        },
        pageUrls: () => browser.pages,
        isLive: (sid) => browser.live.has(sid),
      },
    });
    closers.push(routes.close);
    await app.ready();
    const call = (
      method: "GET" | "POST" | "DELETE",
      url: string,
      auth: { user?: string; token?: string; ip?: string; agent?: string } = {},
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url,
        payload: payload as never,
        ...(auth.ip ? { remoteAddress: auth.ip } : {}),
        headers: {
          ...(auth.agent ? { "user-agent": auth.agent } : {}),
          ...(auth.user ? { "x-test-user": auth.user } : {}),
          ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
        },
      });
    /** Runs the device flow: the machine asks, the user approves, the machine gets its token. */
    const connect = async (kind: "client" | "host", approver: string) => {
      const started = (
        await call("POST", "/api/remote-cc/v1/devices", {}, { kind, name: "m" })
      ).json();
      expect(started.verifyUrl).toBe(`https://rcb.example/?remote-cc=${started.userCode}`);
      const waiting = await call(
        "POST",
        "/api/remote-cc/v1/devices/token",
        {},
        {
          deviceCode: started.deviceCode,
        },
      );
      expect(waiting.statusCode).toBe(202);
      const approved = await call("POST", `/api/remote-cc/devices/${started.userCode}/approve`, {
        user: approver,
      });
      if (approved.statusCode !== 200) return { approved };
      const done = await call(
        "POST",
        "/api/remote-cc/v1/devices/token",
        {},
        {
          deviceCode: started.deviceCode,
        },
      );
      return { approved, token: done.json().token as string };
    };
    return { app, call, connect, store, users, profiles, saved, browser, routes };
  };

  it("connects a computer by device approval and lists only the owner's profiles", async () => {
    const { call, connect, users } = await setup();
    const { token } = await connect("client", "alice");
    expect(token).toMatch(/^rcck_/);
    const response = await call("GET", "/api/remote-cc/v1/profiles", { token });
    expect(response.statusCode).toBe(200);
    const listed = response.json().profiles;
    expect(listed.map((p: { id: string }) => p.id)).toEqual(["p-0000000001", "p-0000000002"]);
    expect(listed[0]).toMatchObject({
      email: "alice@example.com",
      node: { id: "proxy-a", name: "LA" },
      exit: { ip: "203.0.113.7", timeZone: "America/Los_Angeles" },
    });
    expect(response.body).not.toContain("secret-uuid");
    expect(
      (await call("GET", "/api/remote-cc/tokens", { user: "alice" })).json().tokens,
    ).toHaveLength(1);
    users.get("alice")!.enabled = false;
    expect((await call("GET", "/api/remote-cc/v1/profiles", { token })).statusCode).toBe(401);
  });

  it("gives node credentials only to an admin-approved host, on a user's grant", async () => {
    const { call, connect, profiles } = await setup();
    const { token: client } = await connect("client", "alice");
    expect((await connect("host", "alice")).approved.statusCode).toBe(403);
    const { token: host } = await connect("host", "admin");
    const grant = (
      await call("POST", "/api/remote-cc/v1/profiles/p-0000000001/grant", { token: client! })
    ).json();
    expect(grant).toMatchObject({ node: { id: "proxy-a", name: "LA" } });
    expect(grant.grant).toMatch(/^g1\./);
    // A grant alone, or with a client token, does not reveal the node.
    expect(
      (
        await call(
          "POST",
          "/api/remote-cc/v1/egress/redeem",
          { token: client! },
          { grant: grant.grant },
        )
      ).statusCode,
    ).toBe(401);
    const redeemed = await call(
      "POST",
      "/api/remote-cc/v1/egress/redeem",
      { token: host! },
      { grant: grant.grant },
    );
    expect(redeemed.json()).toEqual({
      node: { id: "proxy-a", name: "LA", proxy: node },
      userId: "alice",
    });
    expect(
      (await call("GET", "/api/remote-cc/v1/egress/nodes/proxy-a", { token: host! })).statusCode,
    ).toBe(200);
    // Unbound profile: no grant. Another user's profile: not found.
    expect(
      (await call("POST", "/api/remote-cc/v1/profiles/p-0000000002/grant", { token: client! }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call("POST", "/api/remote-cc/v1/profiles/p-0000000003/grant", { token: client! }))
        .statusCode,
    ).toBe(404);
    // Rebinding the profile invalidates its grant and the host's refresh.
    profiles.alice![0]!.proxyId = "proxy-b";
    expect(
      (
        await call(
          "POST",
          "/api/remote-cc/v1/egress/redeem",
          { token: host! },
          { grant: grant.grant },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await call("GET", "/api/remote-cc/v1/egress/nodes/proxy-a", { token: host! })).statusCode,
    ).toBe(404);
  });

  it("re-checks a profile's exit through its node and records it", async () => {
    const { call, connect, saved } = await setup();
    const { token } = await connect("client", "alice");
    const response = await call("POST", "/api/remote-cc/v1/profiles/p-0000000001/check", { token });
    expect(response.json().exit).toMatchObject({
      ip: "198.51.100.9",
      timeZone: "America/Los_Angeles",
    });
    expect(saved).toEqual([
      [
        "p-0000000001",
        {
          exitIp: "198.51.100.9",
          timeZone: "America/Los_Angeles",
          exitCity: "Los Angeles",
          exitCountry: "United States",
          checkedAt: 9,
        },
      ],
    ]);
    expect(response.json().exit.checkedAt).toBe(9);
  });

  it("opens a Claude sign-in in the profile's browser and returns its code once", async () => {
    const { call, connect, browser, routes } = await setup();
    const { token } = await connect("client", "alice");
    expect(
      (
        await call(
          "POST",
          "/api/remote-cc/v1/profiles/p-0000000001/logins",
          { token },
          { url: "https://evil.example/" },
        )
      ).statusCode,
    ).toBe(400);
    const created = (
      await call(
        "POST",
        "/api/remote-cc/v1/profiles/p-0000000001/logins",
        { token },
        { url: LOGIN_URL },
      )
    ).json();
    expect(created.status).toBe("waiting"); // browser not open yet
    expect(
      (await call("GET", "/api/remote-cc/logins", { user: "alice" })).json().logins,
    ).toMatchObject([
      { profileId: "p-0000000001", profileName: "Work", status: "waiting", tokenName: "m" },
    ]);
    browser.sid = "s-1";
    browser.live.add("s-1");
    await routes.scan();
    expect(browser.opened).toEqual([parseAuthorizeUrl(LOGIN_URL).url]);
    expect((await call("GET", `/api/remote-cc/v1/logins/${created.id}`, { token })).json()).toEqual(
      {
        status: "opened",
      },
    );
    browser.pages = ["https://platform.claude.com/oauth/code/callback?code=C0DE&state=st4te"];
    await routes.scan();
    expect((await call("GET", `/api/remote-cc/v1/logins/${created.id}`, { token })).json()).toEqual(
      {
        status: "done",
        code: "C0DE#st4te",
      },
    );
    expect(
      (await call("GET", `/api/remote-cc/v1/logins/${created.id}`, { token })).statusCode,
    ).toBe(404);
  });
  it("shows the approver where a device request came from and caps one address", async () => {
    const { call } = await setup();
    const from = { ip: "198.51.100.4", agent: "remote-cc/0.3 (linux)" };
    const started = (
      await call("POST", "/api/remote-cc/v1/devices", from, { kind: "client", name: "laptop" })
    ).json();
    const shown = await call("GET", `/api/remote-cc/devices/${started.userCode}`, {
      user: "alice",
    });
    expect(shown.json().request).toMatchObject({
      userCode: started.userCode,
      kind: "client",
      name: "laptop",
      ip: "198.51.100.4",
      userAgent: "remote-cc/0.3 (linux)",
    });
    expect(shown.json().request.createdAt).toEqual(expect.any(Number));
    for (let i = 1; i < 5; i++)
      expect(
        (await call("POST", "/api/remote-cc/v1/devices", from, { kind: "client", name: "x" }))
          .statusCode,
      ).toBe(200);
    expect(
      (await call("POST", "/api/remote-cc/v1/devices", from, { kind: "client", name: "x" }))
        .statusCode,
    ).toBe(429);
    expect(
      (
        await call(
          "POST",
          "/api/remote-cc/v1/devices",
          { ip: "198.51.100.5" },
          { kind: "client", name: "x" },
        )
      ).statusCode,
    ).toBe(200);
  });

  it("lets the user cancel their own sign-in, after which remote-cc gets 404", async () => {
    const { call, connect } = await setup();
    const { token } = await connect("client", "alice");
    const created = (
      await call(
        "POST",
        "/api/remote-cc/v1/profiles/p-0000000001/logins",
        { token },
        { url: LOGIN_URL },
      )
    ).json();
    expect(
      (await call("DELETE", `/api/remote-cc/logins/${created.id}`, { user: "bob" })).statusCode,
    ).toBe(404);
    expect((await call("DELETE", `/api/remote-cc/logins/${created.id}`, {})).statusCode).toBe(401);
    expect(
      (await call("DELETE", `/api/remote-cc/logins/${created.id}`, { user: "alice" })).statusCode,
    ).toBe(204);
    expect((await call("GET", "/api/remote-cc/logins", { user: "alice" })).json().logins).toEqual(
      [],
    );
    expect(
      (await call("GET", `/api/remote-cc/v1/logins/${created.id}`, { token })).statusCode,
    ).toBe(404);
  });

  it("opens a sign-in tab once even when the scan races the request", async () => {
    const { call, connect, browser, routes } = await setup();
    const { token } = await connect("client", "alice");
    browser.sid = "s-1";
    browser.live.add("s-1");
    let release!: () => void;
    browser.delay = new Promise((resolve) => (release = resolve));
    const creating = call(
      "POST",
      "/api/remote-cc/v1/profiles/p-0000000001/logins",
      { token },
      { url: LOGIN_URL },
    );
    // Let the request reach its open() before scanning.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const scanning = routes.scan();
    release();
    const [created] = await Promise.all([creating, scanning]);
    await routes.scan();
    expect(created.json().status).toBe("opened");
    expect(browser.opened).toHaveLength(1);
  });

  it("reopens a sign-in whose browser went away", async () => {
    const { call, connect, browser, routes } = await setup();
    const { token } = await connect("client", "alice");
    browser.sid = "s-1";
    browser.live.add("s-1");
    const created = (
      await call(
        "POST",
        "/api/remote-cc/v1/profiles/p-0000000001/logins",
        { token },
        { url: LOGIN_URL },
      )
    ).json();
    expect(created.status).toBe("opened");
    await routes.scan();
    expect(browser.opened).toHaveLength(1);
    // s-1 closes, nobody has the profile open: back to waiting.
    browser.live.delete("s-1");
    browser.sid = undefined;
    await routes.scan();
    expect((await call("GET", `/api/remote-cc/v1/logins/${created.id}`, { token })).json()).toEqual(
      { status: "waiting" },
    );
    // A new session opens it again, and its callback is picked up.
    browser.sid = "s-2";
    browser.live.add("s-2");
    await routes.scan();
    expect(browser.opened).toHaveLength(2);
    browser.pages = ["https://platform.claude.com/oauth/code/callback?code=C0DE&state=st4te"];
    await routes.scan();
    expect((await call("GET", `/api/remote-cc/v1/logins/${created.id}`, { token })).json()).toEqual(
      { status: "done", code: "C0DE#st4te" },
    );
  });

  it("tells a host whose grant it redeemed and re-checks just that user", async () => {
    const { call, connect, profiles } = await setup();
    const { token: aliceClient } = await connect("client", "alice");
    const { token: bobClient } = await connect("client", "bob");
    const { token: host } = await connect("host", "admin");
    const redeem = async (client: string, profile: string) => {
      const { grant } = (
        await call("POST", `/api/remote-cc/v1/profiles/${profile}/grant`, { token: client })
      ).json();
      return call("POST", "/api/remote-cc/v1/egress/redeem", { token: host! }, { grant });
    };
    expect((await redeem(aliceClient!, "p-0000000001")).json()).toMatchObject({
      userId: "alice",
      node: { id: "proxy-a" },
    });
    expect((await redeem(bobClient!, "p-0000000003")).json().userId).toBe("bob");
    const nodeFor = async (user?: string) =>
      (
        await call(
          "GET",
          `/api/remote-cc/v1/egress/nodes/proxy-a${user === undefined ? "" : `?user=${user}`}`,
          { token: host! },
        )
      ).statusCode;
    expect(await nodeFor("alice")).toBe(200);
    profiles.alice![0]!.proxyId = "proxy-b";
    expect(await nodeFor("alice")).toBe(404);
    expect(await nodeFor("bob")).toBe(200);
    expect(await nodeFor()).toBe(200);
    // Only users whose grant this host redeemed, even if they could use the node.
    expect(await nodeFor("carol")).toBe(404);
    profiles.alice![0]!.proxyId = "proxy-a";
    expect(await nodeFor("alice")).toBe(404); // forgotten until redeemed again
  });

  it("accepts a host token only while its owner is an enabled administrator", async () => {
    const { call, connect, users, store } = await setup();
    const { token: host } = await connect("host", "admin");
    const refresh = async () =>
      (await call("GET", "/api/remote-cc/v1/egress/nodes/proxy-a", { token: host! })).statusCode;
    expect(await refresh()).toBe(404); // valid token, no node yet
    users.get("admin")!.role = "user";
    expect(await refresh()).toBe(401);
    users.get("admin")!.role = "admin";
    expect(await refresh()).toBe(404);
    store.removeUser("admin");
    expect(await refresh()).toBe(401);
  });
});

describe("opening a sign-in in the browser the user chose", () => {
  it("opens only the user's own login, only in a browser of its profile", async () => {
    const logins = createLogins();
    const login = logins.create("alice", "p-1", LOGIN_URL, "laptop");
    const opened: string[] = [];
    const open = async (value: { url: string }) => {
      opened.push(value.url);
    };
    await expect(logins.openIn("bob", login.id, "p-1", "client-1", open)).rejects.toThrow(/过期/);
    await expect(logins.openIn("alice", login.id, "p-2", "client-1", open)).rejects.toThrow(/配置/);
    expect(opened).toEqual([]);
    await logins.openIn("alice", login.id, "p-1", "client-1", open);
    expect(opened).toEqual([parseAuthorizeUrl(LOGIN_URL).url]);
    expect(logins.forUser("alice")).toMatchObject([{ status: "opened", openedIn: "client-1" }]);
    // Asking again (e.g. the tab was closed) opens it again.
    await logins.openIn("alice", login.id, "p-1", "client-2", open);
    expect(opened).toHaveLength(2);
    logins.observe(login.id, "https://platform.claude.com/oauth/code/callback?code=C&state=st4te");
    await expect(logins.openIn("alice", login.id, "p-1", "client-2", open)).rejects.toThrow(/完成/);
  });
});

describe("reading the code from the callback page", () => {
  const state = "9E9OyZ1a4O1cR-uZPwHiCLZpE5kJwE9PKX2YNiyP-UE";
  // What platform.claude.com/oauth/code/callback shows after it strips its address.
  const page = `Authentication code\nPaste this into Claude Code:\nyGgsxtRKfEGYOFmV8jphDylEbYDUv1qWtj7NOfZLBHTpTgY\nF#9E9OyZ1a4O1cR-uZPwHiCLZpE5kJwE9PKX2YNiyP-UE\nCopy code`;
  it("finds this login's code#state, also when wrapped, and nothing for another state", () => {
    expect(codeInText(state, page)).toBe(
      `yGgsxtRKfEGYOFmV8jphDylEbYDUv1qWtj7NOfZLBHTpTgYF#${state}`,
    );
    expect(codeInText("otherstate", page)).toBeUndefined();
    expect(codeInText("eAqh9lxXWr61Ub1TA-EyM27Gzj91s_qQ80r2KYjiP94", page)).toBeUndefined();
  });
  it("completes an opened login from page text once", async () => {
    const logins = createLogins();
    const url = LOGIN_URL.replace("state=st4te", `state=${state}`);
    const login = logins.create("alice", "p-1", url, "laptop");
    await logins.openIn("alice", login.id, "p-1", "client-1", async () => {});
    expect(logins.observeText(login.id, "unrelated page")).toBe(false);
    expect(logins.observeText(login.id, page)).toBe(true);
    expect(logins.take("alice", login.id)).toMatchObject({ status: "done" });
  });
});
