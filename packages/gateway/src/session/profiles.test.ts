// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProfileStore, DEFAULT_PROFILE, isProfileId, MAX_PROFILES } from "./profiles";
import { browserIdentity } from "../browser/identity";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("accounts", () => {
  it("saves every legacy identity before opening a browser and keeps it after key rotation", async () => {
    dir = await mkdtemp(join(tmpdir(), "profile-identity-migration-"));
    const file = join(dir, "accounts.json");
    const legacy = [
      { id: DEFAULT_PROFILE, name: "默认账号", createdAt: 0 },
      { id: "p-0123456789", name: "未打开的账号", createdAt: 1, proxyId: "proxy-123" },
    ];
    await writeFile(file, JSON.stringify(legacy));
    const store = await createProfileStore({
      file,
      legacyIdentitySecret: "original-secret",
      browserEngine: "aliasmode",
    });
    const expected = legacy.map((record) => ({
      ...record,
      identity: browserIdentity("original-secret", record.id),
    }));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(expected);
    expect(store.all()).toEqual(legacy);

    await store.rename(DEFAULT_PROFILE, "重命名后");
    const reopened = await createProfileStore({
      file,
      legacyIdentitySecret: "rotated-secret",
      browserEngine: "aliasmode",
    });
    for (const record of expected) expect(reopened.identity(record.id)).toEqual(record.identity);
    expect(reopened.get(DEFAULT_PROFILE)?.name).toBe("重命名后");
  });

  it("saves new profiles' independent identities without adding them to API records", async () => {
    dir = await mkdtemp(join(tmpdir(), "profile-random-identity-"));
    const file = join(dir, "accounts.json");
    const store = await createProfileStore({ file, legacyIdentitySecret: "old-key" });
    const first = await store.create("第一个");
    const second = await store.create("第二个");
    expect(first).not.toHaveProperty("identity");
    expect(store.identity(first.id)).not.toEqual(store.identity(second.id));
    await store.setProxy(first.id, "proxy-123");

    const reopened = await createProfileStore({
      file,
      legacyIdentitySecret: "new-key",
      browserEngine: "aliasmode",
    });
    expect(reopened.identity(first.id)).toEqual(store.identity(first.id));
    expect(reopened.identity(second.id)).toEqual(store.identity(second.id));
    expect(reopened.get(first.id)).toEqual({ ...first, proxyId: "proxy-123" });
    expect(reopened.identity(first.id).fingerprint).toBeUndefined();
  });

  it("persists independent AliasMode seeds through renaming, proxy changes and key rotation", async () => {
    dir = await mkdtemp(join(tmpdir(), "profile-aliasmode-"));
    const file = join(dir, "accounts.json");
    const store = await createProfileStore({
      file,
      browserEngine: "aliasmode",
      legacyIdentitySecret: "old-key",
    });
    const originalDefault = structuredClone(store.identity(DEFAULT_PROFILE));
    expect(originalDefault.fingerprint).toBeUndefined();
    const first = await store.create("第一个");
    const second = await store.create("第二个");
    const expected = [first, second].map((profile) => structuredClone(store.identity(profile.id)));
    for (const identity of expected)
      expect(identity.fingerprint).toEqual({
        engine: "aliasmode",
        seed: expect.stringMatching(/^[0-9a-f]{32}$/),
        platform: "linux",
      });
    expect(expected[0]!.fingerprint!.seed).not.toBe(expected[1]!.fingerprint!.seed);
    await store.rename(first.id, "重命名后");
    await store.setProxy(first.id, "proxy-first");
    await store.setProxy(first.id, "proxy-second");

    const reopened = await createProfileStore({
      file,
      browserEngine: "chromium",
      legacyIdentitySecret: "rotated-key",
    });
    expect(reopened.identity(first.id)).toEqual(expected[0]);
    expect(reopened.identity(second.id)).toEqual(expected[1]);
    expect(reopened.identity(DEFAULT_PROFILE)).toEqual(originalDefault);
    const native = await reopened.create("原生浏览器");
    expect(reopened.identity(native.id).fingerprint).toBeUndefined();
  });

  it("keeps each profile's selected exit across restarts and can return to the deployment default", async () => {
    dir = await mkdtemp(join(tmpdir(), "profile-proxy-"));
    const file = join(dir, "accounts.json");
    const store = await createProfileStore({ file });
    const privateProfile = await store.create("私有出口");
    await store.setProxy(privateProfile.id, "proxy-123");
    await store.setExitMetadata(privateProfile.id, {
      timeZone: "Asia/Tokyo",
      exitCity: "Osaka",
      exitCountry: "Japan",
    });
    const kyc = { status: "not_required", organizationId: "org-a", checkedAt: 123 };
    await store.setLogin(privateProfile.id, { email: "work@example.com", signedIn: true, kyc });
    const reopened = await createProfileStore({ file });
    expect(reopened.get(privateProfile.id)?.proxyId).toBe("proxy-123");
    expect(reopened.get(privateProfile.id)?.timeZone).toBe("Asia/Tokyo");
    expect(reopened.get(privateProfile.id)?.exitCity).toBe("Osaka");
    expect(reopened.get(privateProfile.id)?.exitCountry).toBe("Japan");
    expect(reopened.get(privateProfile.id)?.kyc).toEqual(kyc);
    expect(reopened.get(DEFAULT_PROFILE)?.proxyId).toBeUndefined();
    await reopened.setProxy(privateProfile.id, null);
    expect(reopened.get(privateProfile.id)?.kyc).toBeUndefined();
    expect((await createProfileStore({ file })).get(privateProfile.id)?.kyc).toBeUndefined();
    expect(reopened.get(privateProfile.id)?.timeZone).toBeUndefined();
    expect(reopened.get(privateProfile.id)?.exitCity).toBeUndefined();
    expect(reopened.get(privateProfile.id)?.exitCountry).toBeUndefined();
    expect((await createProfileStore({ file })).get(privateProfile.id)?.exitCity).toBeUndefined();
    expect((await createProfileStore({ file })).get(privateProfile.id)?.proxyId ?? null).toBeNull();
  });

  it("persists distinct cities for profiles in the same zone and clears invalidated geography", async () => {
    dir = await mkdtemp(join(tmpdir(), "profile-exit-location-"));
    const file = join(dir, "accounts.json");
    const store = await createProfileStore({ file });
    const second = await store.create("第二个城市");
    await store.setExitMetadata(DEFAULT_PROFILE, {
      timeZone: "Asia/Taipei",
      exitCity: "高雄",
      exitCountry: "台湾",
    });
    await store.setExitMetadata(second.id, {
      timeZone: "Asia/Taipei",
      exitCity: "台北",
      exitCountry: "台湾",
    });

    const reopened = await createProfileStore({ file });
    expect(reopened.get(DEFAULT_PROFILE)).toMatchObject({
      timeZone: "Asia/Taipei",
      exitCity: "高雄",
      exitCountry: "台湾",
    });
    expect(reopened.get(second.id)).toMatchObject({
      timeZone: "Asia/Taipei",
      exitCity: "台北",
      exitCountry: "台湾",
    });

    await reopened.setExitMetadata(second.id, { timeZone: "Asia/Taipei" });
    expect((await createProfileStore({ file })).get(second.id)).toEqual({
      id: second.id,
      name: "第二个城市",
      createdAt: second.createdAt,
      timeZone: "Asia/Taipei",
    });
    await reopened.setTimeZone(DEFAULT_PROFILE, undefined);
    expect((await createProfileStore({ file })).get(DEFAULT_PROFILE)).toEqual({
      id: DEFAULT_PROFILE,
      name: "默认账号",
      createdAt: 0,
    });
  });
  it("starts with the legacy account and normalizes its display name", async () => {
    const store = await createProfileStore();
    expect(store.all().map((record) => record.id)).toEqual([DEFAULT_PROFILE]);
    await store.rename(DEFAULT_PROFILE, "  工作  号 ");
    expect(store.get(DEFAULT_PROFILE)?.name).toBe("工作 号");
  });

  it("does not recreate a deleted legacy account when reopening an existing store", async () => {
    dir = await mkdtemp(join(tmpdir(), "removed-legacy-profile-"));
    const file = join(dir, "accounts.json");
    const store = await createProfileStore({ file });
    const replacement = await store.create("新的默认浏览器");
    await store.remove(DEFAULT_PROFILE);

    expect((await createProfileStore({ file })).all()).toEqual([replacement]);
    await store.remove(replacement.id);
    expect((await createProfileStore({ file })).all()).toEqual([]);
  });

  it("creates accounts with ids of their own, and keeps them across restarts", async () => {
    dir = await mkdtemp(join(tmpdir(), "profiles-"));
    const file = join(dir, "accounts.json");
    const store = await createProfileStore({ file, now: () => 42 });
    const second = await store.create("第二个");
    expect(isProfileId(second.id)).toBe(true);
    expect(second.id).not.toBe(DEFAULT_PROFILE);

    const reopened = await createProfileStore({ file });
    expect(reopened.get(second.id)).toEqual({ id: second.id, name: "第二个", createdAt: 42 });
    await reopened.remove(second.id);
    expect((await createProfileStore({ file })).has(second.id)).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(1);
  });

  it("refuses names that are empty or too long, and more accounts than the limit", async () => {
    const store = await createProfileStore();
    await expect(store.create("   ")).rejects.toMatchObject({ code: "PROFILE_NAME" });
    await expect(store.create("x".repeat(41))).rejects.toMatchObject({ code: "PROFILE_NAME" });
    for (let i = 1; i < MAX_PROFILES; i++) await store.create(`账号 ${i}`);
    await expect(store.create("one too many")).rejects.toMatchObject({ code: "PROFILE_LIMIT" });
  });

  it("only knows ids it made, so a request cannot name a path", async () => {
    const store = await createProfileStore();
    expect(store.has("../profile")).toBe(false);
    expect(isProfileId("p-0123456789")).toBe(true);
    expect(isProfileId("p-../../etc")).toBe(false);
    await expect(store.rename("p-0123456789", "x")).rejects.toMatchObject({
      code: "PROFILE_UNKNOWN",
    });
  });

  it("remembers a signed-in email and an unavailable account across restarts, and clears them on logout", async () => {
    dir = await mkdtemp(join(tmpdir(), "profile-login-"));
    const file = join(dir, "accounts.json");
    const store = await createProfileStore({ file });
    const kyc = { status: "not_required", organizationId: "org-a", checkedAt: 123 };
    await store.setLogin(DEFAULT_PROFILE, { email: "work@example.com", signedIn: true, kyc });
    expect((await createProfileStore({ file })).get(DEFAULT_PROFILE)?.email).toBe(
      "work@example.com",
    );
    expect((await createProfileStore({ file })).get(DEFAULT_PROFILE)?.kyc).toEqual(kyc);
    await store.setLogin(DEFAULT_PROFILE, {
      email: "work@example.com",
      signedIn: true,
      kyc: { ...kyc, status: "pending", checkedAt: 456 },
    });
    expect((await createProfileStore({ file })).get(DEFAULT_PROFILE)?.kyc?.status).toBe("pending");
    await store.setLogin(DEFAULT_PROFILE, { email: null, signedIn: false, unavailable: true });
    expect((await createProfileStore({ file })).get(DEFAULT_PROFILE)).toMatchObject({
      email: null,
      unavailable: true,
    });
    expect((await createProfileStore({ file })).get(DEFAULT_PROFILE)?.kyc).toBeUndefined();
    await store.setLogin(DEFAULT_PROFILE, { email: null, signedIn: false });
    expect((await createProfileStore({ file })).get(DEFAULT_PROFILE)).toMatchObject({
      email: null,
      signedIn: false,
    });
    expect((await createProfileStore({ file })).get(DEFAULT_PROFILE)?.unavailable).not.toBe(true);
  });
});
