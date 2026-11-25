// @vitest-environment node
import Fastify, { type FastifyInstance } from "fastify";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { admitted, createOidc, oidcSettingsFromEnv, profileFrom, type OidcSettings } from "./oidc";
import { createUserGate, USER_COOKIE } from "./user-gate";
import { createUserStore } from "./users";

const PUBLIC_ORIGIN = "https://workspace.example";
const CLIENT_ID = "rcb-client";
const CLIENT_SECRET = "rcb-secret";
const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

interface Person {
  sub: string;
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  groups?: string[];
}

/** A minimal OIDC provider: discovery, JWKS, code exchange with PKCE and client auth, userinfo. */
async function provider() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<
    string,
    { person: Person; nonce: string; challenge: string; redirect: string }
  >();
  const tamper = { nonce: false, signature: false, audience: false };
  let issuer = "";
  const signToken = (claims: Record<string, unknown>, key: KeyObject = privateKey) => {
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }));
    const payload = b64url(JSON.stringify(claims));
    return `${header}.${payload}.${b64url(sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key))}`;
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.endsWith("/.well-known/openid-configuration"))
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}authorize/`,
        token_endpoint: `${issuer}token/`,
        userinfo_endpoint: `${issuer}userinfo/`,
        jwks_uri: `${issuer}jwks/`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      });
    if (url.pathname.endsWith("/jwks/")) return json(200, { keys: [jwk] });
    if (url.pathname.endsWith("/userinfo/")) {
      const person = [...codes.values()].find(
        (item) => `Bearer at-${item.person.sub}` === req.headers.authorization,
      );
      return person
        ? json(200, { sub: person.person.sub, groups: person.person.groups })
        : json(401, {});
    }
    if (url.pathname.endsWith("/token/")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        const header = String(req.headers.authorization ?? "");
        const [id, secret] = header.startsWith("Basic ")
          ? Buffer.from(header.slice(6), "base64").toString().split(":").map(decodeURIComponent)
          : [undefined, undefined];
        const grant = codes.get(form.get("code") ?? "");
        if (
          (id ?? form.get("client_id")) !== CLIENT_ID ||
          (secret ?? form.get("client_secret")) !== CLIENT_SECRET
        )
          return json(401, { error: "invalid_client" });
        if (!grant || form.get("redirect_uri") !== grant.redirect)
          return json(400, { error: "invalid_grant" });
        const verifier = form.get("code_verifier") ?? "";
        if (b64url(createHash("sha256").update(verifier).digest()) !== grant.challenge)
          return json(400, { error: "invalid_grant", error_description: "PKCE" });
        codes.delete(form.get("code")!);
        const now = Math.floor(Date.now() / 1000);
        const { groups: _groups, ...claims } = grant.person;
        const idToken = signToken(
          {
            iss: issuer,
            aud: tamper.audience ? "someone-else" : CLIENT_ID,
            iat: now,
            exp: now + 300,
            nonce: tamper.nonce ? "wrong" : grant.nonce,
            ...claims,
            ...(grant.person.groups ? { groups: grant.person.groups } : {}),
          },
          tamper.signature
            ? generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
            : privateKey,
        );
        json(200, {
          access_token: `at-${grant.person.sub}`,
          token_type: "Bearer",
          expires_in: 300,
          id_token: idToken,
        });
      });
      return;
    }
    json(404, {});
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/application/o/rcb/`;
  return {
    issuer,
    tamper,
    close: () => new Promise<void>((done) => server.close(() => done())),
    /** What the provider does after the user authenticates: a callback URL with a code. */
    authorize(authorizationUrl: string, person: Person) {
      const url = new URL(authorizationUrl);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
      const code = randomBytes(12).toString("hex");
      codes.set(code, {
        person,
        nonce: url.searchParams.get("nonce")!,
        challenge: url.searchParams.get("code_challenge")!,
        redirect: url.searchParams.get("redirect_uri")!,
      });
      return `/gate/oidc/callback?code=${code}&state=${url.searchParams.get("state")}`;
    },
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(overrides: Partial<OidcSettings> = {}) {
  const idp = await provider();
  cleanups.push(idp.close);
  const store = await createUserStore({ file: ":memory:", bootstrapPassword: "owner-password-1" });
  cleanups.push(() => store.close());
  const settings: OidcSettings = {
    ...oidcSettingsFromEnv(
      {
        MIRROR_OIDC_ISSUER: idp.issuer,
        MIRROR_OIDC_CLIENT_ID: CLIENT_ID,
        MIRROR_OIDC_CLIENT_SECRET: CLIENT_SECRET,
        MIRROR_OIDC_LABEL: "使用 SphereN 登录",
      },
      PUBLIC_ORIGIN,
    )!,
    ...overrides,
  };
  let clock = Date.now();
  const oidc = createOidc(settings, { store, insecure: true, now: () => clock });
  const app: FastifyInstance = Fastify();
  cleanups.push(() => app.close());
  const gate = createUserGate({ store, publicOrigin: PUBLIC_ORIGIN, oidc });
  app.addHook("preHandler", gate.preHandler);
  gate.registerRoutes(app);
  app.get("/api/me", async (request) => ({ user: gate.currentUser(request.raw) }));
  await app.ready();
  const cookieOf = (setCookie: string | string[] | undefined, name: string) =>
    ([] as string[])
      .concat(setCookie ?? [])
      .map((value) => value.split(";")[0]!)
      .find((value) => value.startsWith(`${name}=`));
  /** Runs a whole sign-in for person; returns the callback response. */
  const signIn = async (person: Person, extraCookie = "", path = "/gate/oidc/start") => {
    const start = await app.inject({
      url: path,
      headers: extraCookie ? { cookie: extraCookie } : {},
    });
    expect(start.statusCode).toBe(302);
    const state = cookieOf(start.headers["set-cookie"], "mirror-oidc-state")!;
    const callback = idp.authorize(String(start.headers.location), person);
    return app.inject({
      url: callback,
      headers: { cookie: [state, extraCookie].filter(Boolean).join("; ") },
    });
  };
  return {
    app,
    store,
    oidc,
    idp,
    signIn,
    cookieOf,
    advance: (ms: number) => (clock += ms),
  };
}

describe("OIDC settings and policy", () => {
  it("reads MIRROR_OIDC_* and derives the redirect URI from the public origin", () => {
    const settings = oidcSettingsFromEnv(
      {
        MIRROR_OIDC_ISSUER: "https://auth.spheren.ai/application/o/rcb/",
        MIRROR_OIDC_CLIENT_ID: "id",
        MIRROR_OIDC_CLIENT_SECRET: "secret",
        MIRROR_OIDC_ALLOWED_DOMAINS: "@Example.com, other.org",
        MIRROR_OIDC_ADMIN_GROUP: "rcb-admins",
      },
      "https://remote.adscn.dev/",
    )!;
    expect(settings.redirectUri).toBe("https://remote.adscn.dev/gate/oidc/callback");
    expect(settings.allowedDomains).toEqual(["example.com", "other.org"]);
    expect(settings.scopes).toBe("openid profile email");
    expect(settings.sessionTtlMs).toBe(7 * 86_400_000);
    expect(oidcSettingsFromEnv({}, "https://x")).toBeUndefined();
    // compose passes every unset variable as an empty string
    const blank = Object.fromEntries(
      [
        "LABEL",
        "SCOPES",
        "REDIRECT_URI",
        "ADMIN_GROUP",
        "ALLOWED_DOMAINS",
        "SESSION_DAYS",
        "REVALIDATE_DAYS",
      ].map((key) => [`MIRROR_OIDC_${key}`, ""]),
    );
    expect(oidcSettingsFromEnv({ ...blank, MIRROR_OIDC_ISSUER: "" }, "https://x")).toBeUndefined();
    expect(
      oidcSettingsFromEnv(
        {
          ...blank,
          MIRROR_OIDC_ISSUER: "https://i/",
          MIRROR_OIDC_CLIENT_ID: "a",
          MIRROR_OIDC_CLIENT_SECRET: "b",
        },
        "https://x",
      ),
    ).toMatchObject({ sessionTtlMs: 7 * 86_400_000, label: "使用单点登录", adminGroup: undefined });
    expect(() => oidcSettingsFromEnv({ MIRROR_OIDC_ISSUER: "https://i/" }, "https://x")).toThrow(
      /CLIENT_ID/,
    );
  });

  it("admits everyone the provider lets in, unless an allow-list is set", () => {
    const base = oidcSettingsFromEnv(
      {
        MIRROR_OIDC_ISSUER: "https://i/",
        MIRROR_OIDC_CLIENT_ID: "a",
        MIRROR_OIDC_CLIENT_SECRET: "b",
      },
      "https://x",
    )!;
    const person = profileFrom({
      iss: "https://i/",
      sub: "1",
      email: "a@corp.com",
      email_verified: false,
    });
    expect(admitted(base, person)).toBe(true);
    const domain = { ...base, allowedDomains: ["corp.com"] };
    expect(admitted(domain, person)).toBe(false); // unverified email never matches
    expect(admitted(domain, { ...person, emailVerified: true })).toBe(true);
    expect(admitted({ ...base, allowedGroups: ["rcb"] }, { ...person, groups: ["RCB"] })).toBe(
      true,
    );
  });
});

describe("OIDC sign-in", () => {
  it("creates an account on first sign-in, then signs the same person into it", async () => {
    const { app, store, signIn, cookieOf } = await fixture();
    const first = await signIn({
      sub: "u-1",
      email: "alice@corp.com",
      email_verified: true,
      preferred_username: "alice",
    });
    expect(first.statusCode).toBe(303);
    expect(first.headers.location).toBe("/?new=1");
    const session = cookieOf(first.headers["set-cookie"], USER_COOKIE)!;
    expect(String(first.headers["set-cookie"])).toMatch(/Max-Age=604800/); // 7-day sessions
    const me = await app.inject({ url: "/api/me", headers: { cookie: session } });
    expect(me.json().user).toMatchObject({ username: "alice", role: "user", enabled: true });
    const id = me.json().user.id;
    expect(store.hasPassword(id)).toBe(false);
    expect(await store.authenticate("alice", "anything-at-all")).toBeNull();
    const second = await signIn({
      sub: "u-1",
      email: "alice@new.com",
      preferred_username: "alice",
    });
    const again = await app.inject({
      url: "/api/me",
      headers: { cookie: cookieOf(second.headers["set-cookie"], USER_COOKIE)! },
    });
    expect(again.json().user.id).toBe(id);
    expect(store.identities(id)).toMatchObject([{ email: "alice@new.com", roleManaged: true }]);
    expect(store.listUsers()).toHaveLength(2); // bootstrap admin + alice
  });

  it("gives a second person with the same name a free username", async () => {
    const { store, signIn } = await fixture();
    await signIn({ sub: "u-1", preferred_username: "bob" });
    await signIn({ sub: "u-2", preferred_username: "bob" });
    await signIn({ sub: "u-3", email: "x y@corp.com" });
    expect(store.listUsers().map((user) => user.username)).toEqual([
      "admin",
      "bob",
      "bob-2",
      "x-y",
    ]);
  });

  it("refuses a callback without this browser's state, a wrong nonce, signature or audience", async () => {
    const { app, idp, signIn } = await fixture();
    const start = await app.inject({ url: "/gate/oidc/start" });
    const callback = idp.authorize(String(start.headers.location), { sub: "u-1" });
    const stolen = await app.inject({ url: callback }); // no state cookie: another browser
    expect(stolen.statusCode).toBe(400);
    expect(stolen.body).toContain("不是从这个浏览器发起的");
    for (const key of ["nonce", "signature", "audience"] as const) {
      idp.tamper[key] = true;
      const response = await signIn({ sub: `u-${key}` });
      expect(response.statusCode, key).toBe(400);
      expect(response.body).toContain("校验失败");
      idp.tamper[key] = false;
    }
  });

  it("applies the allow-list to first sign-ins only", async () => {
    const { signIn } = await fixture({ allowedDomains: ["corp.com"] });
    expect(
      (await signIn({ sub: "u-1", email: "a@corp.com", email_verified: false })).statusCode,
    ).toBe(403);
    expect(
      (await signIn({ sub: "u-1", email: "a@corp.com", email_verified: true })).statusCode,
    ).toBe(303);
    expect(
      (await signIn({ sub: "u-2", email: "b@else.com", email_verified: true })).statusCode,
    ).toBe(403);
  });

  it("follows the admin group for accounts it created, from the ID token or userinfo", async () => {
    const { store, signIn } = await fixture({ adminGroup: "rcb-admins" });
    await signIn({ sub: "u-1", preferred_username: "carol", groups: ["rcb-admins"] });
    const carol = store.listUsers().find((user) => user.username === "carol")!;
    expect(carol.role).toBe("admin");
    await signIn({ sub: "u-1", preferred_username: "carol", groups: [] });
    expect(store.getUser(carol.id)!.role).toBe("user");
  });

  it("refuses a disabled account and keeps the remote-cc code across the sign-in", async () => {
    const { store, signIn } = await fixture();
    await signIn({ sub: "u-1", preferred_username: "dave" });
    const dave = store.listUsers().find((user) => user.username === "dave")!;
    const code = await signIn({ sub: "u-1" }, "mirror-remote-cc=ABCD-EFGH");
    expect(code.headers.location).toBe("/?new=1&remote-cc=ABCD-EFGH");
    await store.updateUser(dave.id, { enabled: false });
    const refused = await signIn({ sub: "u-1" });
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain("已停用");
  });

  it("links an external account to a signed-in local user, once", async () => {
    const { app, store, signIn, cookieOf } = await fixture();
    const login = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: PUBLIC_ORIGIN },
      payload: "username=admin&password=owner-password-1",
    });
    const session = cookieOf(login.headers["set-cookie"], USER_COOKIE)!;
    const linked = await signIn(
      { sub: "u-9", email: "owner@corp.com" },
      session,
      "/gate/oidc/link",
    );
    expect(linked.headers.location).toBe("/?account=linked");
    const admin = store.bootstrapAdmin;
    expect(store.identities(admin.id)).toMatchObject([{ subject: "u-9", roleManaged: false }]);
    // The external account now signs into the admin; both ways work.
    const viaSso = await signIn({ sub: "u-9" });
    const me = await app.inject({
      url: "/api/me",
      headers: { cookie: cookieOf(viaSso.headers["set-cookie"], USER_COOKIE)! },
    });
    expect(me.json().user.id).toBe(admin.id);
    expect(store.hasPassword(admin.id)).toBe(true);
    // Someone else's account cannot take it over.
    await signIn({ sub: "u-10", preferred_username: "eve" });
    const eve = store.listUsers().find((user) => user.username === "eve")!;
    const issuer = store.identities(admin.id)[0]!.issuer;
    expect(() => store.linkIdentity(eve.id, issuer, "u-9", null)).toThrow(/另一个用户/);
  });

  it("lets external-only users keep remote-cc only while they keep signing in", async () => {
    const { store, oidc, signIn, advance } = await fixture();
    await signIn({ sub: "u-1", preferred_username: "frank" });
    const frank = store.listUsers().find((user) => user.username === "frank")!;
    expect(oidc.recentlySignedIn(frank.id)).toBe(true);
    advance(31 * 86_400_000);
    expect(oidc.recentlySignedIn(frank.id)).toBe(false);
    // Users with a local password are not tied to sign-in recency.
    expect(oidc.recentlySignedIn(store.bootstrapAdmin.id)).toBe(true);
  });

  it("shows the sign-in button only when OIDC is configured", async () => {
    const { app } = await fixture();
    const page = await app.inject({ url: "/gate" });
    expect(page.body).toContain('href="/gate/oidc/start"');
    expect(page.body).toContain("使用 SphereN 登录");
  });
});
