// Production authentication and real Chrome profiles, exercised serially against a loopback fixture.
// Run only via: bash scripts/limited-run.sh pnpm exec tsx scripts/multi-user-smoke.mts
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createRequire } from "node:module";
import { createServer as createPortReservation } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Down, TabMeta, Up } from "../packages/protocol/src/index";
import type { FrontendUser } from "../packages/gateway/src/auth/users";
import type { startClientGateway as GatewayStarter } from "../packages/gateway/src/clients-main";
import { assertProductionSafe } from "../packages/gateway/src/production-guard";
import { DEFAULT_SESSION_CAPACITY } from "../packages/gateway/src/session/clients";
import { createResourceSampler } from "../packages/gateway/src/monitor/resources";

if (process.env.CLAUDE_LIMITED_TASK !== "1")
  throw new Error("Run through scripts/limited-run.sh; this test starts real Chrome serially.");

const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
const WebSocket = require("ws") as typeof import("ws").WebSocket;
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const startedAt = new Date().toISOString();
const startedMs = Date.now();
const checks: Record<string, boolean> = {};
const viewers: Viewer[] = [];
const originalEnv = { ...process.env };
const accountsPassword = randomBytes(24).toString("base64url");
const adminPassword = randomBytes(24).toString("base64url");
const reports = new Map<string, FixtureReport>();
const requestCookies = new Map<string, string>();
let phase = "prepare";
let profile: string | undefined;
let origin = "";
let fixtureOrigin = "";
let fixture: Server | undefined;
let gateway: Awaited<ReturnType<typeof GatewayStarter>> | undefined;
let maxConcurrentBrowsers = 0;
let failure: { phase: string; code: string; admissionCode?: string } | undefined;

interface FixtureReport {
  requestCookie: string;
  documentCookie: string;
  localStorage: string | null;
}
interface Lease {
  sid: string;
  account: string;
  maxClients: number;
}
interface WorkspaceStatus {
  clientsAllocated: number;
  clientsMax: number;
}
interface AccountList {
  accounts: { id: string; running: boolean; sessions: number }[];
}
class SmokeFailure extends Error {
  constructor(
    readonly code: string,
    readonly admissionCode?: string,
  ) {
    super(code);
  }
}
function check(name: string, condition: unknown): asserts condition {
  checks[name] = Boolean(condition);
  if (!condition) throw new SmokeFailure(name);
}
async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  name: string,
  timeout = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(75);
  }
  throw new SmokeFailure(`TIMEOUT_${name}`);
}

/** Secure cookies are carried explicitly, so no second browser is needed for the front end. */
class Client {
  private readonly cookies = new Map<string, string>();
  cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  async request(path: string, method = "GET", body?: unknown, form = false) {
    const headers: Record<string, string> = { origin, cookie: this.cookieHeader() };
    if (body !== undefined)
      headers["content-type"] = form ? "application/x-www-form-urlencoded" : "application/json";
    const response = await fetch(origin + path, {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      ...(body === undefined ? {} : { body: form ? String(body) : JSON.stringify(body) }),
    });
    for (const header of response.headers.getSetCookie()) {
      check(
        "login_cookie_security",
        /;\s*Secure(?:;|$)/i.test(header) &&
          /;\s*HttpOnly(?:;|$)/i.test(header) &&
          /;\s*SameSite=Lax(?:;|$)/i.test(header),
      );
      const pair = header.split(";", 1)[0]!;
      const split = pair.indexOf("=");
      const name = pair.slice(0, split);
      const value = pair.slice(split + 1);
      if (value === "" || /;\s*Max-Age=0(?:;|$)/i.test(header)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
  async json<T>(path: string, method = "GET", body?: unknown, expected = 200): Promise<T> {
    const response = await this.request(path, method, body);
    if (response.status !== expected) {
      const value = (await response.json().catch(() => null)) as { code?: unknown } | null;
      if (value?.code === "CLIENT_RESOURCES" || value?.code === "PROFILE_RESOURCES")
        throw new SmokeFailure("MEMORY_ADMISSION_REJECTED", value.code);
      throw new SmokeFailure(`HTTP_${method}_${response.status}_EXPECTED_${expected}`);
    }
    return response.json() as Promise<T>;
  }
  async login(username: string, password: string) {
    const response = await this.request(
      "/gate",
      "POST",
      new URLSearchParams({ username, password }),
      true,
    );
    check("username_password_login", response.status === 303 && this.cookies.size >= 2);
    await response.arrayBuffer();
    return this;
  }
  async status() {
    return this.json<WorkspaceStatus>("/api/status");
  }
}

class Viewer {
  readonly socket: import("ws").WebSocket;
  tabs: TabMeta[] = [];
  assetPath: string | undefined;
  driver = false;
  closed = false;
  constructor(
    client: Client,
    readonly sid: string,
  ) {
    this.socket = new WebSocket(
      `${origin.replace("http:", "ws:")}/ws?sid=${encodeURIComponent(sid)}&connectionKey=${randomUUID()}`,
      {
        headers: { origin, cookie: client.cookieHeader() },
      },
    );
    this.socket.on("message", (raw, isBinary) => {
      if (isBinary) return; // The smoke never requests picture mode.
      const text = String(raw);
      const message = JSON.parse(text) as Down;
      if (message.t === "hello") this.driver = message.role === "driver";
      if (message.t === "tabs") {
        this.tabs = message.tabs;
        this.assetPath ??= message.tabs.find((tab) =>
          tab.favicon?.startsWith(`/s/${sid}/a/`),
        )?.favicon;
      }
      this.assetPath ??= text.match(/\/s\/client-[1-9][0-9]*\/a\/[A-Za-z0-9_-]+/)?.[0];
      if (message.t === "snapshot" && message.reason === "viewport")
        this.send({ t: "view-ack", tab: message.tab, epoch: message.epoch });
    });
    this.socket.on("close", () => {
      this.closed = true;
    });
    this.socket.on("error", () => {});
    viewers.push(this);
  }
  async ready() {
    await waitFor(() => (this.driver && this.tabs.length ? true : undefined), "WS_DRIVER_AND_TABS");
    return this;
  }
  send(message: Up) {
    if (this.socket.readyState !== WebSocket.OPEN) throw new SmokeFailure("VIEWER_CLOSED");
    this.socket.send(JSON.stringify(message));
  }
  async visit(name: string, seed?: "A" | "B") {
    const tab = this.tabs.find((candidate) => candidate.active) ?? this.tabs[0];
    if (!tab) throw new SmokeFailure("MISSING_TAB");
    const url = new URL("/page", fixtureOrigin);
    url.searchParams.set("visit", name);
    if (seed) url.searchParams.set("seed", seed);
    this.send({ t: "nav", tab: tab.id, action: "go", url: url.href });
    return waitFor(() => reports.get(name), `FIXTURE_REPORT_${name}`);
  }
}

/** Match only this test's main Chrome processes, never another service or its renderers. */
async function browserPids(): Promise<number[]> {
  if (!profile) return [];
  const entries = await readdir("/proc");
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const command = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
    const args = command.split("\0");
    if (
      args.some((arg) => arg.startsWith(`--user-data-dir=${profile}`)) &&
      !args.some((arg) => arg.startsWith("--type="))
    )
      pids.push(Number(entry));
  }
  maxConcurrentBrowsers = Math.max(maxConcurrentBrowsers, pids.length);
  check("chrome_never_parallel", pids.length <= 1);
  return pids;
}
async function expectChromeCount(count: number) {
  await waitFor(
    async () => ((await browserPids()).length === count ? true : undefined),
    `CHROME_COUNT_${count}`,
  );
}
async function websocketUpgradeStatus(client: Client, sid: string): Promise<number> {
  return new Promise((done, reject) => {
    const request = httpRequest(
      `${origin}/ws?sid=${encodeURIComponent(sid)}&connectionKey=${randomUUID()}`,
      {
        headers: {
          origin,
          cookie: client.cookieHeader(),
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": randomBytes(16).toString("base64"),
        },
      },
    );
    request.on("response", (response) => {
      response.resume();
      done(response.statusCode ?? 0);
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      done(response.statusCode ?? 101);
    });
    request.on("error", reject);
    request.setTimeout(15_000, () => request.destroy(new SmokeFailure("WS_UPGRADE_TIMEOUT")));
    request.end();
  });
}
async function lease(client: Client) {
  return client.json<Lease>("/api/client/session", "POST", { clientKey: randomUUID() });
}
async function disable(admin: Client, user: FrontendUser, viewer: Viewer) {
  await admin.json<FrontendUser>(`/api/users/${user.id}`, "PATCH", { enabled: false });
  await waitFor(() => (viewer.closed ? true : undefined), "DISABLED_USER_WS_CLOSED");
  check("disabled_user_session_released", (await admin.status()).clientsAllocated === 0);
  await expectChromeCount(0);
  check("disabled_user_chrome_closed", true);
}
async function expectDenied(client: Client, path: string, method = "GET", body?: unknown) {
  const response = await client.request(path, method, body);
  const status = response.status;
  await response.arrayBuffer();
  check(
    `cross_user_${method}_${
      path
        .split("/")
        .filter(Boolean)
        .filter((part) =>
          ["theme", "uploads", "prepare", "downloads", "a", "account"].includes(part),
        )
        .join("_") || "session"
    }`,
    status === 403,
  );
}

try {
  profile = await mkdtemp(join(tmpdir(), "multi-user-production-smoke-"));
  fixture = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/report" && request.method === "POST") {
      let text = "";
      for await (const chunk of request) {
        text += String(chunk);
        if (text.length > 8192) {
          response.writeHead(413).end();
          return;
        }
      }
      const visit = url.searchParams.get("visit") ?? "";
      try {
        const value = JSON.parse(text) as Omit<FixtureReport, "requestCookie">;
        reports.set(visit, {
          requestCookie: requestCookies.get(visit) ?? "",
          documentCookie: value.documentCookie,
          localStorage: value.localStorage,
        });
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(404).end();
      return;
    }
    if (url.pathname === "/fixture.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII=",
          "base64",
        ),
      );
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    if (url.pathname !== "/page") {
      response.end(
        '<!doctype html><title>Local startup fixture</title><link rel="icon" href="/fixture.png"><p>Local fixture</p>',
      );
      return;
    }
    const visit = url.searchParams.get("visit") ?? "";
    const seed = url.searchParams.get("seed");
    requestCookies.set(visit, request.headers.cookie ?? "");
    response.end(`<!doctype html><meta charset="utf-8"><title>Local storage fixture</title><link rel="icon" href="/fixture.png"><p>Isolated browser fixture</p><script>
      const seed=${JSON.stringify(seed)};
      if(seed==='A'||seed==='B') { document.cookie='fixture_owner='+seed+'; Path=/; Max-Age=3600; SameSite=Lax'; localStorage.setItem('fixture_owner',seed); }
      fetch('/report?visit='+encodeURIComponent(${JSON.stringify(visit)}), {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({documentCookie:document.cookie,localStorage:localStorage.getItem('fixture_owner')})});
    </script>`);
  });
  await new Promise<void>((done, reject) => {
    fixture!.once("error", reject);
    fixture!.listen(0, "127.0.0.1", done);
  });
  const fixtureAddress = fixture.address();
  assert(fixtureAddress && typeof fixtureAddress !== "string");
  fixtureOrigin = `http://127.0.0.1:${fixtureAddress.port}`;
  const reservation = createPortReservation();
  await new Promise<void>((done, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", done);
  });
  const gatewayAddress = reservation.address();
  assert(gatewayAddress && typeof gatewayAddress !== "string");
  await new Promise<void>((done, reject) =>
    reservation.close((error) => (error ? reject(error) : done())),
  );
  origin = `http://127.0.0.1:${gatewayAddress.port}`;
  Object.assign(process.env, {
    NODE_ENV: "production",
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_PORT: String(gatewayAddress.port),
    MIRROR_ACCESS_PASSWORD: adminPassword,
    MIRROR_ADMIN_USERNAME: "admin",
    MIRROR_ACCESS_SECRET: randomBytes(32).toString("hex"),
    MIRROR_AUTH_SECRET: randomBytes(32).toString("hex"),
    MIRROR_PUBLIC_ORIGIN: origin,
    MIRROR_CLIENTS: String(DEFAULT_SESSION_CAPACITY),
    MIRROR_DISABLE_RTC: "1",
    MIRROR_START_URL: fixtureOrigin + "/blank",
    MIRROR_USERS_DB: join(profile, "users.sqlite"),
    MIRROR_ACCOUNTS_DIR: join(profile, "browsers"),
    CHROME_USER_DATA_DIR: profile,
    CHROME_PATH: originalEnv.CHROME_PATH ?? "/opt/claude-test-chrome/chrome",
    CHROME_HEADFUL: "0",
    MIRROR_SCREEN_GRAB: "0",
    VIEWER_DIST_ROOT: resolve("packages/viewer/dist"),
    MIRROR_TRUSTED_PROXIES: "",
  });
  delete process.env.MIRROR_E2E;
  delete process.env.BROWSER_CDP_URL;
  assertProductionSafe();
  await access(process.env.CHROME_PATH!);
  const { startClientGateway } = await import("../packages/gateway/src/clients-main");
  gateway = await startClientGateway({
    listen: true,
    signals: false,
    // The maintenance cgroup is a local test budget, not the browser server's production quota.
    // Keep actual host-availability admission and the enforced limited-run cgroup constraints.
    resourceSampler: createResourceSampler({ cgroupMemoryPath: null }),
  });
  const admin = await new Client().login("admin", adminPassword);
  const adminInfo = await admin.json<{ user: FrontendUser }>("/api/me");
  check(
    "bootstrap_administrator",
    adminInfo.user.username === "admin" && adminInfo.user.role === "admin",
  );
  check("configured_capacity", (await admin.status()).clientsMax === DEFAULT_SESSION_CAPACITY);
  const userA = await admin.json<FrontendUser>(
    "/api/users",
    "POST",
    { username: "smoke-a", password: accountsPassword, role: "user" },
    201,
  );
  const userB = await admin.json<FrontendUser>(
    "/api/users",
    "POST",
    { username: "smoke-b", password: accountsPassword, role: "user" },
    201,
  );
  await expectChromeCount(0);
  check("user_creation_does_not_start_chrome", true);

  phase = "seed_user_a";
  const clientA = await new Client().login(userA.username, accountsPassword);
  const leaseA = await lease(clientA);
  const viewerA = await new Viewer(clientA, leaseA.sid).ready();
  await expectChromeCount(1);
  const seededA = await viewerA.visit("a_seed", "A");
  check(
    "a_cookie_and_localstorage_seeded",
    seededA.documentCookie === "fixture_owner=A" && seededA.localStorage === "A",
  );
  await disable(admin, userA, viewerA);
  check("disabled_a_login_revoked", (await clientA.request("/api/me")).status === 401);

  phase = "isolate_user_b";
  const clientB = await new Client().login(userB.username, accountsPassword);
  const leaseB = await lease(clientB);
  check("released_sid_reused", leaseB.sid === leaseA.sid);
  const viewerB = await new Viewer(clientB, leaseB.sid).ready();
  await expectChromeCount(1);
  const freshB = await viewerB.visit("b_empty");
  check(
    "b_cookie_empty_after_sid_reuse",
    freshB.requestCookie === "" && freshB.documentCookie === "",
  );
  check("b_localstorage_empty_after_sid_reuse", freshB.localStorage === null);
  const seededB = await viewerB.visit("b_seed", "B");
  check(
    "b_cookie_and_localstorage_seeded",
    seededB.documentCookie === "fixture_owner=B" && seededB.localStorage === "B",
  );

  phase = "foreign_session_authorization";
  await admin.json<FrontendUser>(`/api/users/${userA.id}`, "PATCH", { enabled: true });
  const freshA = await new Client().login(userA.username, accountsPassword);
  const ownA = await freshA.json<AccountList>("/api/accounts");
  check(
    "reenabling_a_does_not_start_chrome",
    ownA.accounts.every((account) => !account.running) && (await browserPids()).length === 1,
  );
  await expectDenied(freshA, `/s/${leaseB.sid}/theme`);
  await expectDenied(freshA, `/s/${leaseB.sid}/theme`, "POST", { theme: "dark" });
  await expectDenied(freshA, `/s/${leaseB.sid}/downloads`);
  const tabB = viewerB.tabs.find((tab) => tab.active) ?? viewerB.tabs[0]!;
  await expectDenied(freshA, `/s/${leaseB.sid}/uploads/prepare`, "POST", { tab: tabB.id });
  const assetB = await waitFor(() => viewerB.assetPath, "REAL_ASSET_TOKEN");
  await expectDenied(freshA, assetB);
  await expectDenied(freshA, `/api/client/session/${leaseB.sid}`, "DELETE");
  await expectDenied(freshA, "/api/client/session", "POST", {
    clientKey: randomUUID(),
    sid: leaseB.sid,
  });
  check("cross_user_websocket_denied", (await websocketUpgradeStatus(freshA, leaseB.sid)) === 401);
  check(
    "foreign_requests_keep_b_session",
    (await admin.status()).clientsAllocated === 1 && !viewerB.closed,
  );
  await disable(admin, userB, viewerB);

  phase = "restore_user_a";
  const restoredLease = await lease(freshA);
  check(
    "a_owns_same_browser_profile",
    restoredLease.account === leaseA.account && restoredLease.account !== leaseB.account,
  );
  const restoredViewer = await new Viewer(freshA, restoredLease.sid).ready();
  await expectChromeCount(1);
  const restoredA = await restoredViewer.visit("a_restored");
  check(
    "a_own_cookie_persisted_without_b",
    restoredA.requestCookie === "fixture_owner=A" && restoredA.documentCookie === "fixture_owner=A",
  );
  check("a_own_localstorage_persisted_without_b", restoredA.localStorage === "A");

  phase = "logout";
  const logout = await freshA.request("/logout", "POST");
  check("logout_succeeds", logout.status === 204);
  await logout.arrayBuffer();
  await waitFor(() => (restoredViewer.closed ? true : undefined), "LOGOUT_WS_CLOSED");
  check("logout_releases_sessions", (await admin.status()).clientsAllocated === 0);
  check("logout_revokes_token", (await freshA.request("/api/me")).status === 401);
  phase = "complete";
} catch (error) {
  failure = {
    phase,
    code: error instanceof SmokeFailure ? error.code : "UNEXPECTED_FAILURE",
    ...(error instanceof SmokeFailure && error.admissionCode
      ? { admissionCode: error.admissionCode }
      : {}),
  };
  process.exitCode = 1;
} finally {
  for (const viewer of viewers) viewer.socket.terminate();
  try {
    await gateway?.stop();
    await expectChromeCount(0);
    checks.cleanup_no_chrome = true;
  } catch {
    failure ??= { phase: "cleanup", code: "GATEWAY_CLEANUP_FAILED" };
    process.exitCode = 1;
  }
  fixture?.closeAllConnections();
  if (fixture?.listening) await new Promise<void>((done) => fixture!.close(() => done()));
  if (profile) await rm(profile, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  const summary = {
    ok: !failure,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    mode: "production-auth-local-fixture",
    memoryAdmission: "host-availability-only-local-fixture",
    maxConcurrentBrowsers,
    checks,
    ...(failure ? { failure } : {}),
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/multi-user-smoke.json", JSON.stringify(summary, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify(summary));
}
