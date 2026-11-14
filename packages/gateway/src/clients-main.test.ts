// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintInvite } from "./auth/invite";
import { SESSION_COOKIE } from "./auth/middleware";
import { createUserStore, type FrontendUser, type UpdateUserInput } from "./auth/users";
import { startClientGateway } from "./clients-main";
import { createProfileStore } from "./session/profiles";

const hooks = vi.hoisted(() => ({
  beforeCreate: undefined as ((name: unknown) => Promise<void>) | undefined,
  beforeRemove: undefined as ((id: unknown) => Promise<void>) | undefined,
  beforeUserUpdate: undefined as
    ((id: string, input: UpdateUserInput) => Promise<void>) | undefined,
  launch: vi.fn(async () => {
    throw new Error("management and forbidden-session requests must never start Chrome");
  }),
}));

vi.mock("./browser/launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser/launch")>()),
  launchBrowser: hooks.launch,
}));
vi.mock("./session/profiles", async (importOriginal) => {
  const original = await importOriginal<typeof import("./session/profiles")>();
  return {
    ...original,
    async createProfileStore(...args: Parameters<typeof original.createProfileStore>) {
      const store = await original.createProfileStore(...args);
      return {
        ...store,
        async create(name: unknown) {
          await hooks.beforeCreate?.(name);
          return store.create(name);
        },
        async remove(id: unknown) {
          await hooks.beforeRemove?.(id);
          return store.remove(id);
        },
      };
    },
  };
});
vi.mock("./auth/users", async (importOriginal) => {
  const original = await importOriginal<typeof import("./auth/users")>();
  return {
    ...original,
    async createUserStore(...args: Parameters<typeof original.createUserStore>) {
      const store = await original.createUserStore(...args);
      const update = store.updateUser;
      store.updateUser = async (id, input) => {
        await hooks.beforeUserUpdate?.(id, input);
        return update(id, input);
      };
      return store;
    },
  };
});
vi.mock("./monitor/resources", () => ({
  createResourceSampler: () => ({
    sample: async () => ({
      sampledAt: Date.now(),
      cpuPercent: 0,
      cpuCount: 1,
      memoryUsedBytes: 128 * 1048576,
      memoryTotalBytes: 4096 * 1048576,
      browserMemoryBytes: 64 * 1048576,
      browserMemoryLimitBytes: 3584 * 1048576,
    }),
  }),
}));

const PASSWORD = "initial-admin-password";
const BOB_PASSWORD = "independent-bob-password";
const ORIGIN = "https://workspace.example";
const SECRET = "test-only-durable-device-secret";
const directories: string[] = [];
const gateways: Awaited<ReturnType<typeof startClientGateway>>[] = [];

interface Paths {
  profile: string;
  accounts: string;
  users: string;
  sessions: string;
}

beforeEach(() => {
  hooks.beforeCreate = undefined;
  hooks.beforeRemove = undefined;
  hooks.beforeUserUpdate = undefined;
  hooks.launch.mockClear();
  vi.stubEnv("MIRROR_E2E", undefined);
  vi.stubEnv("MIRROR_ACCESS_PASSWORD", PASSWORD);
  vi.stubEnv("MIRROR_ADMIN_USERNAME", "admin");
  vi.stubEnv("MIRROR_AUTH_SECRET", SECRET);
  vi.stubEnv("MIRROR_PUBLIC_ORIGIN", ORIGIN);
  vi.stubEnv("MIRROR_CLIENTS", undefined);
  vi.stubEnv("BROWSER_CDP_URL", undefined);
  vi.stubEnv("MIRROR_RUNTIME_SOCKET", undefined);
  vi.stubEnv("CPA_BROKER_SOCKET", undefined);
  vi.stubEnv("GATEWAY_PORT", "3000");
});

afterEach(async () => {
  hooks.beforeCreate = undefined;
  hooks.beforeRemove = undefined;
  hooks.beforeUserUpdate = undefined;
  for (const gateway of gateways.splice(0)) await gateway.stop();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function fixture(prepare?: (paths: Paths) => Promise<void>) {
  const profile = await mkdtemp(join(tmpdir(), "tenant-routes-"));
  directories.push(profile);
  const paths = {
    profile,
    accounts: join(profile, "accounts.json"),
    users: join(profile, "users.sqlite"),
    sessions: join(profile, "client-sessions.json"),
  };
  vi.stubEnv("CHROME_USER_DATA_DIR", profile);
  vi.stubEnv("MIRROR_ACCOUNTS_DIR", join(profile, "browsers"));
  vi.stubEnv("MIRROR_USERS_DB", paths.users);
  await prepare?.(paths);
  const gateway = await startClientGateway({ listen: false, signals: false });
  gateways.push(gateway);
  return { ...gateway, paths };
}

function api(
  app: FastifyInstance,
  cookie: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: { cookie, origin: ORIGIN },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function login(app: FastifyInstance, username = "admin", password = PASSWORD) {
  const response = await app.inject({
    method: "POST",
    url: "/gate",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    payload: new URLSearchParams({ username, password }).toString(),
  });
  expect(response.statusCode).toBe(303);
  const headers = response.headers["set-cookie"];
  if (!headers) throw new Error("missing remembered login");
  return (Array.isArray(headers) ? headers : [headers])
    .map((header) => header.split(";", 1)[0]!)
    .join("; ");
}

function withDevice(cookie: string, device: string) {
  const token = mintInvite(
    { sid: device, role: "driver", exp: Math.floor(Date.now() / 1000) + 3600 },
    Buffer.from(SECRET),
  );
  return `${cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => !part.startsWith(`${SESSION_COOKIE}=`))
    .join("; ")}; ${SESSION_COOKIE}=${token}`;
}

async function createBob(app: FastifyInstance, admin: string, role = "user") {
  const response = await api(app, admin, "POST", "/api/users", {
    username: "bob",
    password: BOB_PASSWORD,
    role,
  });
  expect(response.statusCode).toBe(201);
  return response.json<FrontendUser>();
}

describe("multi-user management routes", () => {
  it("binds only visible nodes to an owned profile, redacts secrets and preserves the exit on restart", async () => {
    const gateway = await fixture();
    vi.stubEnv("MIRROR_RUNTIME_SOCKET", "/unused-for-management.sock");
    const admin = await login(gateway.app);
    await createBob(gateway.app, admin);
    const bob = await login(gateway.app, "bob", BOB_PASSWORD);
    const source = async (cookie: string, name: string, visibility: string) =>
      api(gateway.app, cookie, "POST", "/api/proxy-sources", {
        name,
        visibility,
        content: `http://fixture-user:fixture-secret@${name}.invalid:8080`,
      });
    expect((await source(bob, "forbidden", "shared")).statusCode).toBe(403);
    expect((await source(admin, "admin-private", "private")).statusCode).toBe(200);
    expect((await source(admin, "shared", "shared")).statusCode).toBe(200);
    expect((await source(bob, "bob-private", "private")).statusCode).toBe(200);
    const all = await api(gateway.app, admin, "GET", "/api/proxies");
    expect(all.body).not.toContain("fixture-secret");
    const nodes = all.json().proxies as { id: string; name: string }[];
    const adminNode = nodes.find((node) => node.name === "admin-private.invalid")!;
    const privateNode = nodes.find((node) => node.name === "bob-private.invalid")!;
    const visible = (await api(gateway.app, bob, "GET", "/api/proxies")).json().proxies;
    expect(visible.map((node: { id: string }) => node.id)).not.toContain(adminNode.id);
    const profiles = (await api(gateway.app, bob, "GET", "/api/accounts")).json();
    const profileId = profiles.default;
    expect(
      (
        await api(gateway.app, bob, "PATCH", "/api/accounts/default/proxy", {
          proxyId: privateNode.id,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await api(gateway.app, bob, "PATCH", `/api/accounts/${profileId}/proxy`, {
          proxyId: adminNode.id,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await api(gateway.app, bob, "PATCH", `/api/accounts/${profileId}/proxy`, {
          proxyId: privateNode.id,
        })
      ).statusCode,
    ).toBe(200);
    await gateway.stop();
    const restarted = await startClientGateway({ listen: false, signals: false });
    gateways.push(restarted);
    const fresh = await login(restarted.app, "bob", BOB_PASSWORD);
    expect(
      (await api(restarted.app, fresh, "GET", "/api/accounts")).json().accounts[0],
    ).toMatchObject({ proxyId: privateNode.id, proxyName: privateNode.name });
    expect(
      (
        await api(restarted.app, fresh, "PATCH", `/api/accounts/${profileId}/proxy`, {
          proxyId: null,
        })
      ).statusCode,
    ).toBe(200);
    expect(hooks.launch).not.toHaveBeenCalled();
  });
  it("persists independent user defaults and renames, and protects the selected default", async () => {
    const gateway = await fixture();
    const { app } = gateway;
    const admin = await login(app);
    await createBob(app, admin);
    const bob = await login(app, "bob", BOB_PASSWORD);
    const initialAdmin = (await api(app, admin, "GET", "/api/accounts")).json();
    const initialBob = (await api(app, bob, "GET", "/api/accounts")).json();
    expect(initialAdmin.default).toBe("default");
    expect(initialBob.default).toBe(initialBob.accounts[0].id);

    const adminChoice = (
      await api(app, admin, "POST", "/api/accounts", { name: "管理工作" })
    ).json();
    const bobChoice = (await api(app, bob, "POST", "/api/accounts", { name: "个人工作" })).json();
    expect(
      (await api(app, admin, "POST", `/api/accounts/${adminChoice.id}/default`)).json(),
    ).toEqual({ account: adminChoice.id });
    expect((await api(app, bob, "POST", `/api/accounts/${bobChoice.id}/default`)).json()).toEqual({
      account: bobChoice.id,
    });
    expect(
      (await api(app, bob, "POST", `/api/accounts/${adminChoice.id}/default`)).statusCode,
    ).toBe(403);
    expect(
      (await api(app, admin, "POST", `/api/accounts/${bobChoice.id}/default`)).statusCode,
    ).toBe(403);
    const protectedChoice = await api(app, admin, "DELETE", `/api/accounts/${adminChoice.id}`);
    expect(protectedChoice.statusCode).toBe(409);
    expect(protectedChoice.json().code).toBe("PROFILE_DEFAULT");
    const renamed = await api(app, admin, "PATCH", `/api/accounts/${adminChoice.id}`, {
      name: "  工作  浏览器  ",
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("工作 浏览器");
    expect(
      (await api(app, bob, "PATCH", `/api/accounts/${adminChoice.id}`, { name: "foreign" }))
        .statusCode,
    ).toBe(403);

    await gateway.stop();
    const restarted = await startClientGateway({ listen: false, signals: false });
    gateways.push(restarted);
    const freshAdmin = await login(restarted.app);
    const freshBob = await login(restarted.app, "bob", BOB_PASSWORD);
    const adminList = (await api(restarted.app, freshAdmin, "GET", "/api/accounts")).json();
    const bobList = (await api(restarted.app, freshBob, "GET", "/api/accounts")).json();
    expect(adminList.default).toBe(adminChoice.id);
    expect(
      adminList.accounts.find((account: { id: string }) => account.id === adminChoice.id).name,
    ).toBe("工作 浏览器");
    expect(bobList.default).toBe(bobChoice.id);
    expect(hooks.launch).not.toHaveBeenCalled();
  });

  it("deletes the legacy Chrome state without deleting service metadata or recreating its account", async () => {
    const gateway = await fixture(async (paths) => {
      await mkdir(join(paths.profile, "Default"));
      await writeFile(join(paths.profile, "Default", "Cookies"), "private-browser-state");
      await writeFile(join(paths.profile, "Local State"), "private-browser-key");
      await writeFile(paths.sessions, "[]");
    });
    const { app, paths } = gateway;
    const admin = await login(app);
    const selected = (
      await api(app, admin, "POST", "/api/accounts", { name: "保留的配置" })
    ).json();
    expect((await api(app, admin, "POST", `/api/accounts/${selected.id}/default`)).statusCode).toBe(
      200,
    );
    expect((await api(app, admin, "DELETE", "/api/accounts/default")).statusCode).toBe(204);
    await expect(stat(join(paths.profile, "Default"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(paths.profile, "Local State"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await stat(paths.users)).isFile()).toBe(true);
    expect(JSON.parse(await readFile(paths.sessions, "utf8"))).toEqual([]);
    expect(
      JSON.parse(await readFile(paths.accounts, "utf8")).map(
        (account: { id: string }) => account.id,
      ),
    ).toEqual([selected.id]);
    expect((await api(app, admin, "GET", "/api/me")).statusCode).toBe(200);

    await gateway.stop();
    const restarted = await startClientGateway({ listen: false, signals: false });
    gateways.push(restarted);
    const freshAdmin = await login(restarted.app);
    const list = (await api(restarted.app, freshAdmin, "GET", "/api/accounts")).json();
    expect(list.default).toBe(selected.id);
    expect(list.accounts.map((account: { id: string }) => account.id)).toEqual([selected.id]);
    expect(hooks.launch).not.toHaveBeenCalled();
  });

  it("blocks deleting a configuration used on another device, then moves this device's session to its chosen default", async () => {
    let selectedId = "";
    let removedId = "";
    const { app, paths } = await fixture(async (paths) => {
      const profiles = await createProfileStore({ file: paths.accounts });
      selectedId = (await profiles.create("默认目的地")).id;
      removedId = (await profiles.create("准备删除")).id;
      const removedDir = join(paths.profile, "browsers", removedId);
      await mkdir(removedDir, { recursive: true });
      await writeFile(join(removedDir, "browser-state"), "must-be-removed");
      await writeFile(
        paths.sessions,
        JSON.stringify([
          {
            sid: "client-1",
            owner: "device-here",
            clientKey: "here-key",
            profile: removedId,
            createdAt: 1,
          },
          {
            sid: "client-2",
            owner: "device-away",
            clientKey: "away-key",
            profile: removedId,
            createdAt: 2,
          },
        ]),
      );
    });
    const admin = withDevice(await login(app), "device-here");
    const away = withDevice(await login(app), "device-away");
    expect((await api(app, admin, "POST", `/api/accounts/${selectedId}/default`)).statusCode).toBe(
      200,
    );
    const refused = await api(app, admin, "DELETE", `/api/accounts/${removedId}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("PROFILE_IN_USE");
    expect((await api(app, admin, "GET", "/api/accounts?sid=client-1")).json().current).toBe(
      removedId,
    );
    expect((await stat(join(paths.profile, "browsers", removedId))).isDirectory()).toBe(true);

    expect((await api(app, away, "DELETE", "/api/client/session/client-2")).statusCode).toBe(204);
    expect((await api(app, admin, "DELETE", `/api/accounts/${removedId}`)).statusCode).toBe(204);
    const sessions = JSON.parse(await readFile(paths.sessions, "utf8"));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sid: "client-1", profile: selectedId });
    const list = (await api(app, admin, "GET", "/api/accounts?sid=client-1")).json();
    expect(list.default).toBe(selectedId);
    expect(list.current).toBe(selectedId);
    expect(list.accounts.some((account: { id: string }) => account.id === removedId)).toBe(false);
    await expect(stat(join(paths.profile, "browsers", removedId))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(hooks.launch).not.toHaveBeenCalled();
  });

  it("starts without Chrome and separates each user's browser configurations and administration", async () => {
    const { app } = await fixture();
    const anonymous = await app.inject({ url: "/api/accounts" });
    expect(anonymous.statusCode).toBe(401);
    const admin = await login(app);
    const me = (await api(app, admin, "GET", "/api/me")).json().user;
    expect(me).toMatchObject({ username: "admin", role: "admin" });
    const bob = await createBob(app, admin);
    expect(Object.keys(bob).sort()).toEqual(["createdAt", "enabled", "id", "role", "username"]);
    const bobCookie = await login(app, "bob", BOB_PASSWORD);
    const adminAccounts = (await api(app, admin, "GET", "/api/accounts")).json().accounts;
    const bobAccounts = (await api(app, bobCookie, "GET", "/api/accounts")).json().accounts;
    expect(adminAccounts).toEqual([
      expect.objectContaining({ id: "default", running: false, sessions: 0 }),
    ]);
    expect(bobAccounts).toHaveLength(1);
    expect(bobAccounts[0].id).not.toBe("default");
    expect(bobAccounts[0].running).toBe(false);
    expect((await api(app, bobCookie, "GET", "/api/users")).statusCode).toBe(403);
    expect(
      (
        await api(app, bobCookie, "POST", "/api/users", {
          username: "intruder",
          password: PASSWORD,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await api(app, bobCookie, "PATCH", `/api/users/${me.id}`, { role: "user" })).statusCode,
    ).toBe(403);
    expect((await api(app, bobCookie, "DELETE", `/api/users/${me.id}`)).statusCode).toBe(403);
    expect(
      (await api(app, bobCookie, "PATCH", "/api/accounts/default", { name: "foreign" })).statusCode,
    ).toBe(403);
    expect((await api(app, admin, "DELETE", `/api/accounts/${bobAccounts[0].id}`)).statusCode).toBe(
      403,
    );
    expect(
      (await api(app, bobCookie, "DELETE", `/api/accounts/${bobAccounts[0].id}`)).json(),
    ).toMatchObject({ code: "PROFILE_LAST" });
    const renamed = await api(app, bobCookie, "PATCH", `/api/accounts/${bobAccounts[0].id}`, {
      name: "Bob's own Chrome",
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("Bob's own Chrome");
    expect((await api(app, admin, "GET", "/api/accounts")).json().accounts).toEqual(adminAccounts);
    expect(hooks.launch).not.toHaveBeenCalled();
  });

  it("preserves an enabled administrator and revokes existing logins on password and role changes", async () => {
    const { app } = await fixture();
    const admin = await login(app);
    const owner = (await api(app, admin, "GET", "/api/me")).json().user;
    for (const payload of [{ role: "user" }, { enabled: false }]) {
      const response = await api(app, admin, "PATCH", `/api/users/${owner.id}`, payload);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("USER_LAST_ADMIN");
    }
    expect((await api(app, admin, "DELETE", `/api/users/${owner.id}`)).json().code).toBe(
      "USER_SELF_DELETE",
    );
    const bob = await createBob(app, admin);
    const oldBobCookie = await login(app, "bob", BOB_PASSWORD);
    const reset = await api(app, admin, "PATCH", `/api/users/${bob.id}`, {
      username: "robert",
      password: "replacement-bob-password",
    });
    expect(reset.statusCode).toBe(200);
    expect((await api(app, oldBobCookie, "GET", "/api/me")).statusCode).toBe(401);
    const changedBobCookie = await login(app, "robert", "replacement-bob-password");
    expect((await api(app, changedBobCookie, "GET", "/api/me")).json().user.username).toBe(
      "robert",
    );
    const promoted = await api(app, admin, "PATCH", `/api/users/${bob.id}`, { role: "admin" });
    expect(promoted.statusCode).toBe(200);
    expect((await api(app, changedBobCookie, "GET", "/api/me")).statusCode).toBe(401);
    const bobAdmin = await login(app, "robert", "replacement-bob-password");
    expect(
      (await api(app, bobAdmin, "PATCH", `/api/users/${owner.id}`, { role: "user" })).statusCode,
    ).toBe(200);
    expect((await api(app, admin, "GET", "/api/users")).statusCode).toBe(401);
    expect((await api(app, bobAdmin, "GET", "/api/users")).json().users).toHaveLength(2);
    expect(hooks.launch).not.toHaveBeenCalled();
  });

  it("migrates legacy ownership and denies another user every scoped HTTP and WS entry", async () => {
    let bob!: FrontendUser;
    let bobProfile = "";
    const { app, paths } = await fixture(async (paths) => {
      const profiles = await createProfileStore({ file: paths.accounts });
      bobProfile = (await profiles.create("Bob browser")).id;
      const users = await createUserStore({ file: paths.users, bootstrapPassword: PASSWORD });
      bob = await users.createUser({ username: "bob", password: BOB_PASSWORD });
      users.assignProfile(bobProfile, bob.id);
      users.close();
      await writeFile(
        paths.sessions,
        JSON.stringify([
          { sid: "client-1", owner: "device-legacy", clientKey: "legacy-key", createdAt: 1 },
          {
            sid: "client-2",
            owner: `${bob.id}/device-bob`,
            clientKey: "bob-key",
            profile: bobProfile,
            createdAt: 2,
          },
        ]),
      );
    });
    const admin = withDevice(await login(app), "device-legacy");
    const bobCookie = withDevice(await login(app, "bob", BOB_PASSWORD), "device-bob");
    const owner = (await api(app, admin, "GET", "/api/me")).json().user;
    const migrated = JSON.parse(await readFile(paths.sessions, "utf8"));
    expect(migrated.map((record: { owner: string }) => record.owner)).toEqual([
      `${owner.id}/device-legacy`,
      `${bob.id}/device-bob`,
    ]);
    expect((await api(app, admin, "GET", "/s/client-1/theme")).statusCode).toBe(200);
    expect((await api(app, bobCookie, "GET", "/s/client-2/theme")).statusCode).toBe(200);
    for (const [method, url, payload] of [
      ["GET", "/s/client-1/theme"],
      ["POST", "/s/client-1/theme", { theme: "dark" }],
      ["GET", "/s/client-1/downloads"],
      ["GET", "/s/client-1/d/foreign-link"],
      ["GET", "/s/client-1/a/foreign-token"],
      ["POST", "/s/client-1/uploads/prepare", { tab: "foreign-target" }],
      ["DELETE", "/s/client-1/u/foreign-key"],
      ["DELETE", "/api/client/session/client-1"],
      ["POST", "/api/client/session/client-1/account", { account: bobProfile }],
      ["POST", "/api/client/session/client-2/account", { account: "default" }],
      ["POST", "/api/client/session", { clientKey: "bob-key", sid: "client-1" }],
      ["POST", "/api/client/session", { clientKey: "new-bob-key", account: "default" }],
      ["POST", "/api/client/session", { clientKey: "new-bob-key", account: "p-0000000000" }],
    ] as const) {
      const response = await api(app, bobCookie, method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    const accounts = (await api(app, bobCookie, "GET", "/api/accounts?sid=client-1")).json();
    expect(accounts.current).toBeNull();
    expect(accounts.accounts.map((record: { id: string }) => record.id)).toEqual([bobProfile]);
    const status = (await api(app, admin, "GET", "/api/status")).json();
    expect(status.clientsAllocated).toBe(2);
    expect(status.clientsMax).toBe(8);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    expect(await upgradeStatus(address.port, bobCookie, "client-1")).toBe(401);
    expect(hooks.launch).not.toHaveBeenCalled();
  });

  it("uses configured capacity, revokes disabled users, and never reassigns a deleted user's profiles after restart", async () => {
    vi.stubEnv("MIRROR_CLIENTS", "3");
    const gateway = await fixture();
    const { app } = gateway;
    const admin = await login(app);
    const bob = await createBob(app, admin);
    const bobCookie = await login(app, "bob", BOB_PASSWORD);
    const bobProfile = (await api(app, bobCookie, "GET", "/api/accounts")).json().accounts[0].id;
    expect((await api(app, admin, "GET", "/api/status")).json().clientsMax).toBe(3);
    expect((await app.inject({ url: "/healthz" })).json().maxClients).toBe(3);
    expect(
      (await api(app, admin, "PATCH", `/api/users/${bob.id}`, { enabled: false })).statusCode,
    ).toBe(200);
    expect((await api(app, bobCookie, "GET", "/api/accounts")).statusCode).toBe(401);
    expect(
      (await api(app, admin, "PATCH", `/api/users/${bob.id}`, { enabled: true })).statusCode,
    ).toBe(200);
    const reenabled = await login(app, "bob", BOB_PASSWORD);
    expect((await api(app, reenabled, "GET", "/api/accounts")).json().accounts[0].id).toBe(
      bobProfile,
    );
    expect((await api(app, admin, "DELETE", `/api/users/${bob.id}`)).statusCode).toBe(204);
    expect((await api(app, reenabled, "GET", "/api/me")).statusCode).toBe(401);
    await gateway.stop();
    const restarted = await startClientGateway({ listen: false, signals: false });
    gateways.push(restarted);
    const freshAdmin = await login(restarted.app);
    expect(
      (await api(restarted.app, freshAdmin, "GET", "/api/accounts"))
        .json()
        .accounts.map((record: { id: string }) => record.id),
    ).toEqual(["default"]);
    const charlie = await api(restarted.app, freshAdmin, "POST", "/api/users", {
      username: "charlie",
      password: "independent-charlie-password",
    });
    expect(charlie.statusCode).toBe(201);
    const charlieCookie = await login(restarted.app, "charlie", "independent-charlie-password");
    const charlieProfiles = (await api(restarted.app, charlieCookie, "GET", "/api/accounts")).json()
      .accounts;
    expect(charlieProfiles).toHaveLength(1);
    expect(charlieProfiles[0].id).not.toBe(bobProfile);
    expect(
      (
        await api(restarted.app, charlieCookie, "PATCH", `/api/accounts/${bobProfile}`, {
          name: "reclaim",
        })
      ).statusCode,
    ).toBe(403);
    expect(hooks.launch).not.toHaveBeenCalled();
  });

  it("rechecks a queued request's login after an administrator disables that user", async () => {
    const { app } = await fixture();
    const admin = await login(app);
    const bob = await createBob(app, admin);
    const bobCookie = await login(app, "bob", BOB_PASSWORD);
    const entered = deferred<void>();
    const proceed = deferred<void>();
    hooks.beforeUserUpdate = async (id, input) => {
      if (id !== bob.id || input.enabled !== false) return;
      entered.resolve();
      await proceed.promise;
    };
    const disable = api(app, admin, "PATCH", `/api/users/${bob.id}`, { enabled: false });
    await entered.promise;
    const stale = api(app, bobCookie, "POST", "/api/accounts", { name: "must-not-create" });
    await nextTurn();
    proceed.resolve();
    expect((await disable).statusCode).toBe(200);
    expect((await stale).statusCode).toBe(401);
    const enabled = await api(app, admin, "PATCH", `/api/users/${bob.id}`, { enabled: true });
    expect(enabled.statusCode).toBe(200);
    const fresh = await login(app, "bob", BOB_PASSWORD);
    const profiles = (await api(app, fresh, "GET", "/api/accounts")).json().accounts;
    expect(profiles).toHaveLength(1);
    expect(profiles.some((profile: { name: string }) => profile.name === "must-not-create")).toBe(
      false,
    );
    expect(hooks.launch).not.toHaveBeenCalled();
  });

  it("serializes profile deletion before a concurrent session switch to that profile", async () => {
    const { app, paths } = await fixture(async (paths) => {
      await writeFile(
        paths.sessions,
        JSON.stringify([
          { sid: "client-1", owner: "device-legacy", clientKey: "legacy-key", createdAt: 1 },
        ]),
      );
    });
    const admin = withDevice(await login(app), "device-legacy");
    const created = await api(app, admin, "POST", "/api/accounts", { name: "deleting-browser" });
    expect(created.statusCode).toBe(200);
    const profileId = created.json().id;
    const entered = deferred<void>();
    const proceed = deferred<void>();
    hooks.beforeRemove = async (id) => {
      if (id !== profileId) return;
      entered.resolve();
      await proceed.promise;
    };
    const deleting = api(app, admin, "DELETE", `/api/accounts/${profileId}`);
    await entered.promise;
    const switching = api(app, admin, "POST", "/api/client/session/client-1/account", {
      account: profileId,
    });
    await nextTurn();
    proceed.resolve();
    expect((await deleting).statusCode).toBe(204);
    const refused = await switching;
    expect(refused.statusCode).toBe(404);
    expect(refused.json().code).toBe("PROFILE_UNKNOWN");
    const sessions = JSON.parse(await readFile(paths.sessions, "utf8"));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sid).toBe("client-1");
    expect(sessions[0].profile ?? "default").toBe("default");
    const profiles = JSON.parse(await readFile(paths.accounts, "utf8"));
    expect(profiles.some((profile: { id: string }) => profile.id === profileId)).toBe(false);
    expect((await api(app, admin, "GET", "/api/accounts?sid=client-1")).json().current).toBe(
      "default",
    );
    expect(hooks.launch).not.toHaveBeenCalled();
  });

  it("refuses queued release and profile-switch requests after their login token is revoked", async () => {
    const { app, paths } = await fixture(async (paths) => {
      await writeFile(
        paths.sessions,
        JSON.stringify([
          { sid: "client-1", owner: "device-legacy", clientKey: "legacy-key", createdAt: 1 },
        ]),
      );
    });
    const admin = withDevice(await login(app), "device-legacy");
    const owner = (await api(app, admin, "GET", "/api/me")).json().user;
    const target = await api(app, admin, "POST", "/api/accounts", { name: "switch-destination" });
    expect(target.statusCode).toBe(200);
    const entered = deferred<void>();
    const proceed = deferred<void>();
    hooks.beforeUserUpdate = async (id, input) => {
      if (id !== owner.id || input.password === undefined) return;
      entered.resolve();
      await proceed.promise;
    };
    const reset = api(app, admin, "PATCH", `/api/users/${owner.id}`, {
      password: "new-password-after-revocation",
    });
    await entered.promise;
    const releasing = api(app, admin, "DELETE", "/api/client/session/client-1");
    const switching = api(app, admin, "POST", "/api/client/session/client-1/account", {
      account: target.json().id,
    });
    await nextTurn();
    proceed.resolve();
    expect((await reset).statusCode).toBe(200);
    expect((await releasing).statusCode).toBe(401);
    expect((await switching).statusCode).toBe(401);
    const sessions = JSON.parse(await readFile(paths.sessions, "utf8"));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sid).toBe("client-1");
    expect(sessions[0].profile ?? "default").toBe("default");
    const fresh = withDevice(
      await login(app, "admin", "new-password-after-revocation"),
      "device-legacy",
    );
    expect((await api(app, fresh, "GET", "/api/accounts?sid=client-1")).json().current).toBe(
      "default",
    );
    expect(hooks.launch).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function upgradeStatus(port: number, cookie: string, sid: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: `/ws?sid=${encodeURIComponent(sid)}&connection=forbidden-upgrade`,
      headers: {
        cookie,
        origin: ORIGIN,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.alloc(16, 1).toString("base64"),
      },
    });
    request.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("another user's workspace accepted a WebSocket upgrade"));
    });
    request.once("error", reject);
    request.setTimeout(2000, () => request.destroy(new Error("upgrade timed out")));
    request.end();
  });
}
