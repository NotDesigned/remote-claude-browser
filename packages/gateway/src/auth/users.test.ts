// @vitest-environment node
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createUserStore, USER_SESSION_TTL_MS, UserStoreError, type UserStore } from "./users";

const PASSWORD = "initial-owner-password";
const stores: UserStore[] = [];
const directories: string[] = [];

async function memoryStore(now?: () => number) {
  const store = await createUserStore({
    file: ":memory:",
    bootstrapPassword: PASSWORD,
    ...(now ? { now } : {}),
  });
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("front-end users", () => {
  it("bootstraps admin and returns only public user fields", async () => {
    const store = await memoryStore(() => 42);
    expect(store.bootstrapAdmin).toEqual({
      id: expect.stringMatching(/^user-[0-9a-f-]+$/),
      username: "admin",
      role: "admin",
      enabled: true,
      createdAt: 42,
    });
    expect(await store.authenticate("ADMIN", PASSWORD)).toEqual(store.bootstrapAdmin);
    expect(await store.authenticate("admin", "incorrect-password")).toBeNull();
    expect(await store.authenticate("unknown", PASSWORD)).toBeNull();
    expect(await store.authenticate(null, PASSWORD)).toBeNull();
    expect(await store.authenticate("admin", "short")).toBeNull();
    expect(store.listUsers()).toEqual([store.bootstrapAdmin]);
  });

  it("persists users and logins without storing passwords or raw login tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frontend-users-"));
    directories.push(dir);
    const file = join(dir, "private", "users.sqlite");
    const store = await createUserStore({ file, bootstrapPassword: PASSWORD });
    stores.push(store);
    const user = await store.createUser({ username: "Alice", password: "alice-long-password" });
    const login = store.issueSession(user.id);
    const another = store.issueSession(store.bootstrapAdmin.id);
    expect(store.session(login.token)).toEqual(user);
    expect(store.session(another.token)?.id).toBe(store.bootstrapAdmin.id);
    expect(login.token).not.toBe(another.token);

    const inspect = new DatabaseSync(file, { readOnly: true });
    const rows = inspect.prepare("SELECT password_hash FROM users").all();
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row.password_hash).toMatch(/^scrypt-v1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    const tokens = inspect.prepare("SELECT token_hash FROM auth_sessions").all();
    expect(tokens).toHaveLength(2);
    for (const row of tokens) {
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.token_hash).not.toBe(login.token);
    }
    inspect.close();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "private"))).mode & 0o777).toBe(0o700);
    expect((await stat(`${file}-wal`)).mode & 0o777).toBe(0o600);
    expect((await stat(`${file}-shm`)).mode & 0o777).toBe(0o600);
    store.close();

    const reopened = await createUserStore({
      file,
      bootstrapUsername: "different",
      bootstrapPassword: "new-env-password",
    });
    stores.push(reopened);
    expect(reopened.session(login.token)).toEqual(user);
    expect(await reopened.authenticate("alice", "alice-long-password")).toEqual(user);
    expect(await reopened.authenticate("admin", PASSWORD)).toEqual(reopened.bootstrapAdmin);
    expect(await reopened.authenticate("admin", "new-env-password")).toBeNull();
    expect(reopened.listUsers()).toHaveLength(2);
  });

  it("expires, revokes and validates individual sessions independently", async () => {
    let now = 1000;
    const store = await memoryStore(() => now);
    const first = store.issueSession(store.bootstrapAdmin.id, 100);
    const second = store.issueSession(store.bootstrapAdmin.id, 200);
    expect(first.expiresAt).toBe(1100);
    expect(store.session(first.token)?.id).toBe(store.bootstrapAdmin.id);
    now = 1100;
    expect(store.session(first.token)).toBeNull();
    expect(store.session(second.token)?.id).toBe(store.bootstrapAdmin.id);
    store.revokeSession(second.token);
    expect(store.session(second.token)).toBeNull();
    expect(store.session("invalid")).toBeNull();
    expect(store.session(null)).toBeNull();
    expect(store.session("a".repeat(43))).toBeNull();
    expect(() => store.issueSession(store.bootstrapAdmin.id, USER_SESSION_TTL_MS + 1)).toThrow(
      UserStoreError,
    );
    expect(() => store.issueSession(store.bootstrapAdmin.id, 0)).toThrow(UserStoreError);
  });

  it("resets passwords and disables users while revoking their sessions", async () => {
    const store = await memoryStore();
    const user = await store.createUser({
      username: "第二个用户",
      password: "second-user-password",
    });
    const first = store.issueSession(user.id);
    const second = store.issueSession(user.id);
    const adminLogin = store.issueSession(store.bootstrapAdmin.id);
    await store.updateUser(user.id, { password: "replacement-password" });
    expect(store.session(first.token)).toBeNull();
    expect(store.session(second.token)).toBeNull();
    expect(store.session(adminLogin.token)?.id).toBe(store.bootstrapAdmin.id);
    expect(await store.authenticate(user.username, "second-user-password")).toBeNull();
    expect(await store.authenticate(user.username, "replacement-password")).toEqual(user);

    const replacement = store.issueSession(user.id);
    await store.updateUser(user.id, { enabled: false });
    expect(store.session(replacement.token)).toBeNull();
    expect(await store.authenticate(user.username, "replacement-password")).toBeNull();
    expect(() => store.issueSession(user.id)).toThrowError(
      expect.objectContaining({ code: "USER_DISABLED" }),
    );
    await store.updateUser(user.id, { enabled: true });
    expect(await store.authenticate(user.username, "replacement-password")).toEqual(user);
  });

  it("rejects a login whose user was disabled while scrypt was running", async () => {
    const store = await memoryStore();
    const user = await store.createUser({ username: "racing", password: "racing-old-password" });
    const pending = store.authenticate(user.username, "racing-old-password");
    await store.updateUser(user.id, { enabled: false });
    expect(await pending).toBeNull();
  });

  it("rejects a login whose username changed while scrypt was running", async () => {
    const store = await memoryStore();
    const user = await store.createUser({ username: "before", password: "racing-user-password" });
    // authenticate yields to native async scrypt; a name-only update commits synchronously.
    const pending = store.authenticate("before", "racing-user-password");
    const renamed = await store.updateUser(user.id, { username: "after" });
    expect(await pending).toBeNull();
    expect(await store.authenticate("before", "racing-user-password")).toBeNull();
    expect(await store.authenticate("after", "racing-user-password")).toEqual(renamed);
  });

  it("always retains an enabled administrator, including concurrent updates", async () => {
    const store = await memoryStore();
    const admin = store.bootstrapAdmin;
    await expect(store.updateUser(admin.id, { role: "user" })).rejects.toMatchObject({
      code: "USER_LAST_ADMIN",
    });
    await expect(store.updateUser(admin.id, { enabled: false })).rejects.toMatchObject({
      code: "USER_LAST_ADMIN",
    });
    expect(() => store.deleteUser(admin.id)).toThrowError(
      expect.objectContaining({ code: "USER_LAST_ADMIN" }),
    );
    const second = await store.createUser({
      username: "second-admin",
      password: "second-admin-password",
      role: "admin",
    });
    const results = await Promise.allSettled([
      store.updateUser(admin.id, { password: "admin-changed-password", role: "user" }),
      store.updateUser(second.id, { password: "second-changed-password", enabled: false }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(store.listUsers().filter((user) => user.role === "admin" && user.enabled)).toHaveLength(
      1,
    );
    expect(store.bootstrapAdmin.role).toBe("admin");
    expect(store.bootstrapAdmin.enabled).toBe(true);
  });

  it("keeps ownership exclusive and imports legacy profiles only once", async () => {
    const store = await memoryStore();
    const admin = store.bootstrapAdmin;
    const user = await store.createUser({ username: "other", password: "other-user-password" });
    store.claimLegacyProfiles(["default", "p-0123456789"], admin.id);
    expect(store.listOwnedProfiles(admin.id)).toEqual(["default", "p-0123456789"]);
    expect(store.listOwnedProfiles(user.id)).toEqual([]);
    store.assignProfile("p-aaaaaaaaaa", user.id);
    store.assignProfile("p-aaaaaaaaaa", user.id);
    expect(store.profileOwner("p-aaaaaaaaaa")).toBe(user.id);
    expect(() => store.assignProfile("default", user.id)).toThrowError(
      expect.objectContaining({ code: "PROFILE_OWNED" }),
    );
    expect(() => store.assignProfile("../profile", user.id)).toThrowError(
      expect.objectContaining({ code: "PROFILE_ID" }),
    );
    expect(() => store.assignProfile("p-bbbbbbbbbb", "unknown")).toThrowError(
      expect.objectContaining({ code: "USER_UNKNOWN" }),
    );
    const login = store.issueSession(user.id);
    store.deleteUser(user.id);
    expect(store.session(login.token)).toBeNull();
    expect(store.profileOwner("p-aaaaaaaaaa")).toBeUndefined();
    store.claimLegacyProfiles(["default", "p-aaaaaaaaaa"], admin.id);
    expect(store.profileOwner("p-aaaaaaaaaa")).toBeUndefined();
    store.unassignProfile("p-0123456789");
    expect(store.listOwnedProfiles(admin.id)).toEqual(["default"]);
  });

  it("keeps each user's default among their own profiles", async () => {
    const store = await memoryStore();
    const admin = store.bootstrapAdmin;
    const user = await store.createUser({ username: "other", password: "other-user-password" });
    store.claimLegacyProfiles(["p-0123456789", "default"], admin.id);
    expect(store.defaultProfile(admin.id)).toBe("default");
    expect(store.defaultProfile(user.id)).toBeUndefined();

    store.assignProfile("p-bbbbbbbbbb", user.id);
    store.assignProfile("p-aaaaaaaaaa", user.id);
    expect(store.defaultProfile(user.id)).toBe("p-bbbbbbbbbb");
    store.setDefaultProfile(user.id, "p-aaaaaaaaaa");
    expect(store.defaultProfile(user.id)).toBe("p-aaaaaaaaaa");
    expect(store.defaultProfile(admin.id)).toBe("default");
    expect(() => store.setDefaultProfile(admin.id, "p-aaaaaaaaaa")).toThrowError(
      expect.objectContaining({ statusCode: 403, code: "PROFILE_FORBIDDEN" }),
    );
    expect(store.defaultProfile(user.id)).toBe("p-aaaaaaaaaa");
    expect(store.defaultProfile(admin.id)).toBe("default");
  });

  it("persists chosen defaults and migrates existing ownership without overwriting a choice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "user-default-profiles-"));
    directories.push(dir);
    const file = join(dir, "users.sqlite");
    const store = await createUserStore({ file, bootstrapPassword: PASSWORD });
    stores.push(store);
    const adminId = store.bootstrapAdmin.id;
    store.claimLegacyProfiles(["default", "p-0123456789"], adminId);
    store.setDefaultProfile(adminId, "p-0123456789");
    store.close();

    const reopened = await createUserStore({ file });
    stores.push(reopened);
    expect(reopened.defaultProfile(adminId)).toBe("p-0123456789");
    reopened.close();

    const legacy = new DatabaseSync(file);
    legacy.exec("DROP TABLE user_default_profiles");
    legacy.close();
    const migrated = await createUserStore({ file });
    stores.push(migrated);
    expect(migrated.defaultProfile(adminId)).toBe("default");
  });

  it("removes defaults when their ownership or user is removed", async () => {
    const store = await memoryStore();
    const user = await store.createUser({ username: "other", password: "other-user-password" });
    store.assignProfile("p-aaaaaaaaaa", user.id);
    expect(store.defaultProfile(user.id)).toBe("p-aaaaaaaaaa");
    store.unassignProfile("p-aaaaaaaaaa");
    expect(store.defaultProfile(user.id)).toBeUndefined();
    store.assignProfile("p-bbbbbbbbbb", user.id);
    expect(store.defaultProfile(user.id)).toBe("p-bbbbbbbbbb");
    store.deleteUser(user.id);
    expect(store.defaultProfile(user.id)).toBeUndefined();
    expect(store.profileOwner("p-bbbbbbbbbb")).toBeUndefined();
  });

  it("validates and normalizes usernames without exposing their password hashes", async () => {
    const store = await memoryStore();
    const user = await store.createUser({
      username: "  Ａlice  ",
      password: "valid-user-password",
    });
    expect(user.username).toBe("Alice");
    expect(await store.authenticate("ALICE", "valid-user-password")).toEqual(user);
    await expect(
      store.createUser({ username: "alice", password: "another-valid-password" }),
    ).rejects.toMatchObject({ code: "USER_EXISTS" });
    await expect(store.updateUser(user.id, { username: "admin" })).rejects.toMatchObject({
      code: "USER_EXISTS",
    });
    await expect(
      store.createUser({ username: "bad name", password: "valid-user-password" }),
    ).rejects.toMatchObject({ code: "USER_NAME" });
    await expect(
      store.createUser({ username: "long".repeat(20), password: "valid-user-password" }),
    ).rejects.toMatchObject({ code: "USER_NAME" });
    await expect(store.createUser({ username: "valid", password: "short" })).rejects.toMatchObject({
      code: "USER_PASSWORD",
    });
    await expect(
      store.createUser({ username: "valid", password: "x".repeat(1025) }),
    ).rejects.toMatchObject({ code: "USER_PASSWORD" });
    await expect(
      store.createUser({ username: "valid", password: PASSWORD, role: "owner" }),
    ).rejects.toMatchObject({ code: "USER_ROLE" });
    await expect(store.updateUser(user.id, { enabled: "yes" })).rejects.toMatchObject({
      code: "USER_ENABLED",
    });
    await expect(store.updateUser("unknown", { enabled: false })).rejects.toMatchObject({
      code: "USER_UNKNOWN",
    });
    expect(() => store.deleteUser("unknown")).toThrowError(
      expect.objectContaining({ code: "USER_UNKNOWN" }),
    );
    expect(store.getUser(user.id)).toEqual(user);
    expect(store.getUser("unknown")).toBeUndefined();
    expect(
      store
        .listUsers()
        .every((row) => !Object.keys(row).some((key) => /hash|password|token/.test(key))),
    ).toBe(true);
  });
});
