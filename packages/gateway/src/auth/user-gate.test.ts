// @vitest-environment node
import Fastify, { type FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderGatePage } from "./gate-page";
import { SESSION_COOKIE } from "./middleware";
import { createUserGate, USER_COOKIE, userSessionToken } from "./user-gate";
import { createUserStore, USER_SESSION_TTL_MS, type FrontendUser, type UserStore } from "./users";
import { registerSecurityHeaders } from "../security-headers";

const PASSWORD = "initial-owner-password";
const PUBLIC_ORIGIN = "https://workspace.example";
const apps: FastifyInstance[] = [];
const stores: UserStore[] = [];

async function fixture(options: Omit<Parameters<typeof createUserGate>[0], "store" | "now"> = {}) {
  const clock = { now: 1_800_000_000_000 };
  const store = await createUserStore({
    file: ":memory:",
    bootstrapPassword: PASSWORD,
    now: () => clock.now,
  });
  stores.push(store);
  const app = Fastify();
  registerSecurityHeaders(app);
  apps.push(app);
  const gate = createUserGate({
    store,
    publicOrigin: PUBLIC_ORIGIN,
    now: () => clock.now,
    ...options,
  });
  app.addHook("preHandler", gate.preHandler);
  gate.registerRoutes(app);
  app.get("/", async (request) => ({ user: gate.currentUser(request.raw) }));
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/api/private", async (request) => ({ user: gate.currentUser(request.raw) }));
  app.post("/api/action", async () => ({ ok: true }));
  app.get("/s/client-1/theme", async () => ({ theme: "light" }));
  await app.ready();
  const login = (
    username: string = "admin",
    password: string = PASSWORD,
    remoteAddress: string = "203.0.113.1",
  ) =>
    app.inject({
      method: "POST",
      url: "/gate",
      remoteAddress,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: PUBLIC_ORIGIN,
      },
      payload: new URLSearchParams({ username, password }).toString(),
    });
  return { app, gate, store, clock, login };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
});

describe("persisted front-end user gate", () => {
  it("keeps health and login public, redirects documents, and denies anonymous APIs and upgrades", async () => {
    const { app, gate } = await fixture();
    const page = await app.inject({ url: "/gate" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    expect(page.body).toContain('name="username"');
    expect(page.body).toContain('autocomplete="username"');
    expect(page.body).toContain('name="password"');
    expect(page.body).not.toContain(PASSWORD);
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);

    for (const method of ["GET", "HEAD"] as const) {
      const response = await app.inject({ method, url: "/" });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("/gate");
    }
    for (const url of ["/api/private", "/s/client-1/theme"]) {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ gate: "/gate" });
    }
    expect((await app.inject({ method: "POST", url: "/api/action" })).statusCode).toBe(401);
    expect(gate.currentUser(request())).toBeNull();
    expect(gate.authorizeUpgrade(request())).toBe(false);
    expect(gate.hasValidDevice(request(`${SESSION_COOKIE}=remembered-device`))).toBe(false);
    expect(gate.authorizeUpgrade(request(`${USER_COOKIE}=forged`))).toBe(false);
  });

  it("logs in with username and password, issues secure cookies, and remembers the correct identity", async () => {
    const { app, store, gate, login } = await fixture({
      cookiesOnSuccess: () => ["additional=session; Path=/; Secure; HttpOnly; SameSite=Lax"],
    });
    const response = await login("ADMIN");
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/");
    expect(response.headers["cache-control"]).toBe("no-store");
    const cookies = cookieHeaders(response.headers["set-cookie"]);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(
      new RegExp(
        `^${USER_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${USER_SESSION_TTL_MS / 1000}$`,
      ),
    );
    expect(cookies.join(";")).not.toContain(PASSWORD);
    const cookie = userCookie(response.headers["set-cookie"]);
    expect(gate.currentUser(request(cookie))).toEqual(store.bootstrapAdmin);
    expect(gate.hasValidDevice(request(cookie))).toBe(true);
    expect(gate.authorizeUpgrade(request(cookie))).toBe(true);
    const privateResponse = await app.inject({ url: "/api/private", headers: { cookie } });
    expect(privateResponse.statusCode).toBe(200);
    expect(privateResponse.json()).toEqual({ user: store.bootstrapAdmin });
    const remembered = await app.inject({ url: "/gate", headers: { cookie } });
    expect(remembered.statusCode).toBe(302);
    expect(remembered.headers.location).toBe("/");
  });

  it("never reuses one user's identity for another user's login", async () => {
    const { app, store, login } = await fixture();
    const second = await store.createUser({ username: "second", password: "second-user-password" });
    const firstLogin = await login();
    const secondLogin = await login(second.username, "second-user-password");
    const firstCookie = userCookie(firstLogin.headers["set-cookie"]);
    const secondCookie = userCookie(secondLogin.headers["set-cookie"]);
    expect(firstCookie).not.toBe(secondCookie);
    for (const [cookie, user] of [
      [firstCookie, store.bootstrapAdmin],
      [secondCookie, second],
    ] as const) {
      const response = await app.inject({ url: "/api/private", headers: { cookie } });
      expect(response.json()).toEqual({ user });
    }
  });

  it("denies expired, revoked, disabled and tampered remembered logins", async () => {
    const { app, store, clock, login } = await fixture();
    const user = await store.createUser({ username: "second", password: "second-user-password" });
    const short = store.issueSession(user.id, 100);
    const revoked = store.issueSession(user.id);
    const disabled = store.issueSession(user.id);
    store.revokeSession(revoked.token);
    clock.now += 100;
    for (const token of [short.token, revoked.token, `${disabled.token.slice(0, -1)}!`]) {
      const response = await app.inject({
        url: "/api/private",
        headers: { cookie: `${USER_COOKIE}=${token}` },
      });
      expect(response.statusCode).toBe(401);
    }
    await store.updateUser(user.id, { enabled: false });
    expect(
      (
        await app.inject({
          url: "/api/private",
          headers: { cookie: `${USER_COOKIE}=${disabled.token}` },
        })
      ).statusCode,
    ).toBe(401);
    const denied = await login(user.username, "second-user-password");
    expect(denied.statusCode).toBe(401);
    expect(denied.headers["set-cookie"]).toBeUndefined();
    expect(denied.body).toContain("用户名或密码不正确。");
  });

  it("honors username changes and invalidates old credentials and cookies after a password reset", async () => {
    const { app, store, clock, login } = await fixture();
    const first = await login();
    const oldCookie = userCookie(first.headers["set-cookie"]);
    const ownerId = store.bootstrapAdmin.id;
    await store.updateUser(ownerId, { username: "renamed-owner" });
    expect((await login("admin")).statusCode).toBe(401);
    clock.now += 500;
    const renamedLogin = await login("renamed-owner");
    expect(renamedLogin.statusCode).toBe(303);
    const renamedCookie = userCookie(renamedLogin.headers["set-cookie"]);
    await store.updateUser(ownerId, { password: "replacement-owner-password" });
    for (const cookie of [oldCookie, renamedCookie]) {
      expect((await app.inject({ url: "/api/private", headers: { cookie } })).statusCode).toBe(401);
    }
    expect((await login("renamed-owner", PASSWORD)).statusCode).toBe(401);
    clock.now += 500;
    const replacementLogin = await login("renamed-owner", "replacement-owner-password");
    expect(replacementLogin.statusCode).toBe(303);
    const response = await app.inject({
      url: "/api/private",
      headers: { cookie: userCookie(replacementLogin.headers["set-cookie"]) },
    });
    expect(response.json().user).toMatchObject({ id: ownerId, username: "renamed-owner" });
  });

  it("logs out only the presented token and clears both service cookie names", async () => {
    const onLogout = vi.fn();
    const { app, store, gate, login } = await fixture({ onLogout });
    const first = await login();
    const second = await login();
    const firstCookie = userCookie(first.headers["set-cookie"]);
    const secondCookie = userCookie(second.headers["set-cookie"]);
    const response = await app.inject({
      method: "POST",
      url: "/logout",
      headers: { cookie: firstCookie, origin: PUBLIC_ORIGIN },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(cookieHeaders(response.headers["set-cookie"])).toEqual(
      [USER_COOKIE, SESSION_COOKIE].map(
        (name) => `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      ),
    );
    expect(onLogout).toHaveBeenCalledWith(expect.anything(), store.bootstrapAdmin);
    expect(gate.currentUser(request(firstCookie))).toBeNull();
    expect(gate.currentUser(request(secondCookie))).toEqual(store.bootstrapAdmin);
    expect((await app.inject({ method: "POST", url: "/logout" })).statusCode).toBe(204);
    expect(onLogout).toHaveBeenLastCalledWith(expect.anything(), null);
  });

  it("rejects cross-origin login and authenticated mutations before checking credentials", async () => {
    const { app, store, login } = await fixture();
    const authenticate = vi.spyOn(store, "authenticate");
    for (const headers of [
      { origin: "https://attacker.example" },
      { origin: PUBLIC_ORIGIN, "sec-fetch-site": "cross-site" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/gate",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        payload: new URLSearchParams({ username: "admin", password: PASSWORD }).toString(),
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    expect(authenticate).not.toHaveBeenCalled();
    const loggedIn = await login();
    const cookie = userCookie(loggedIn.headers["set-cookie"]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/action",
          headers: { cookie, origin: "https://attacker.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/action",
          headers: { cookie, origin: PUBLIC_ORIGIN, "sec-fetch-site": "same-origin" },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("backs off failed passwords per IP without blocking a different client", async () => {
    const { store, clock, login } = await fixture();
    const authenticate = vi.spyOn(store, "authenticate");
    const denied = await login("admin", "incorrect-password");
    expect(denied.statusCode).toBe(401);
    expect(denied.headers["set-cookie"]).toBeUndefined();
    const blocked = await login();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("2");
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect((await login("admin", PASSWORD, "203.0.113.2")).statusCode).toBe(303);
    clock.now += 500;
    expect((await login("admin", "incorrect-password")).statusCode).toBe(401);
    clock.now += 500;
    expect((await login()).statusCode).toBe(429);
    clock.now += 500;
    expect((await login()).statusCode).toBe(303);
  });

  it("bounds pending expensive password checks globally and per IP, then releases capacity", async () => {
    const { store, login } = await fixture();
    const pending = Array.from({ length: 4 }, () => ({
      entered: deferred<void>(),
      result: deferred<FrontendUser | null>(),
    }));
    let calls = 0;
    const authenticate = vi.spyOn(store, "authenticate").mockImplementation(() => {
      const entry = pending[calls++];
      if (!entry) throw new Error("password verification concurrency exceeded its limit");
      entry.entered.resolve();
      return entry.result.promise;
    });
    const requests = [];
    try {
      for (const [index, entry] of pending.entries()) {
        requests.push(login("admin", PASSWORD, `203.0.113.${index + 1}`));
        await entry.entered.promise;
      }
      const sameClient = await login();
      expect(sameClient.statusCode).toBe(429);
      const fifthClient = await login("admin", PASSWORD, "203.0.113.5");
      expect(fifthClient.statusCode).toBe(429);
      expect(fifthClient.headers["retry-after"]).toBe("2");
      expect(authenticate).toHaveBeenCalledTimes(4);
    } finally {
      for (const entry of pending) entry.result.resolve(null);
      const responses = await Promise.all(requests);
      expect(responses.map((response) => response.statusCode)).toEqual([401, 401, 401, 401]);
    }
    authenticate.mockResolvedValue(store.bootstrapAdmin);
    expect((await login("admin", PASSWORD, "203.0.113.5")).statusCode).toBe(303);
  });

  it("escapes every HTML metacharacter in errors and bounds login request bodies", async () => {
    const error = `<script>alert("x" & 'y')</script>`;
    const html = renderGatePage(error, { users: true });
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;");
    expect(html).not.toContain(error);
    expect(html).toContain('aria-describedby="login-error"');
    const { app, store } = await fixture();
    const authenticate = vi.spyOn(store, "authenticate");
    const response = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `username=admin&password=${"x".repeat(8192)}`,
    });
    expect(response.statusCode).toBe(413);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("extracts the exact named cookie and ignores other cookie values", () => {
    expect(userSessionToken(request())).toBeUndefined();
    expect(
      userSessionToken(request(`${USER_COOKIE}-other=wrong; unrelated=value`)),
    ).toBeUndefined();
    expect(userSessionToken(request(`unrelated=wrong; ${USER_COOKIE}=correct; tail=value`))).toBe(
      "correct",
    );
  });
});

function cookieHeaders(value: string | string[] | undefined): string[] {
  if (!value) throw new Error("expected a Set-Cookie header");
  return Array.isArray(value) ? value : [value];
}

function userCookie(value: string | string[] | undefined): string {
  const header = cookieHeaders(value).find((cookie) => cookie.startsWith(`${USER_COOKIE}=`));
  if (!header) throw new Error("expected a user cookie");
  return header.split(";", 1)[0]!;
}

function request(cookie?: string): IncomingMessage {
  return { headers: cookie === undefined ? {} : { cookie } } as IncomingMessage;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
