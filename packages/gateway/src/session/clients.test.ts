import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClientSessions, isClientSlot } from "./clients";

describe("session identifiers", () => {
  it("rejects malformed and unsafe slot identifiers", () => {
    for (const value of [
      "client-0",
      "client-01",
      "client--1",
      "client-1.5",
      "client-9007199254740992",
      null,
    ])
      expect(isClientSlot(value)).toBe(false);
    expect(isClientSlot("client-128")).toBe(true);
  });
});

describe("client ownership", () => {
  it("allocates beyond the old limit, restores ownership and reuses released identifiers", async () => {
    const sessions = await createClientSessions();
    const records = await Promise.all(
      Array.from({ length: 32 }, (_, i) => sessions.acquire(`device-${i}`, `tab-${i}`)),
    );
    expect(sessions.all()).toHaveLength(32);
    expect(new Set(records.map((record) => record.sid)).size).toBe(32);
    expect(await sessions.acquire("device-0", "tab-0")).toBe(records[0]);
    await expect(sessions.acquire("device-1", "another", records[0]!.sid)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(sessions.release("device-1", records[0]!.sid)).rejects.toMatchObject({
      statusCode: 403,
    });
    await sessions.release("device-0", records[0]!.sid);
    expect((await sessions.acquire("new-device", "new-tab")).sid).toBe(records[0]!.sid);
    expect(sessions.owns("device-1", records[1]!.sid)).toBe(true);
  });
  it("allocates again after automatic release when the page restores its old session hint", async () => {
    const sessions = await createClientSessions();
    const previous = await sessions.acquire("device-a", "tab-a");
    await sessions.release("device-a", previous.sid);
    const next = await sessions.acquire("device-a", "tab-a", previous.sid);
    expect(next).not.toBe(previous);
    expect(sessions.owns("device-a", next.sid)).toBe(true);
  });
  it("retains ownership when releasing cannot persist, and permits a later retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clients-release-failure-"));
    try {
      const file = join(dir, "sessions.json");
      const sessions = await createClientSessions({ file });
      const record = await sessions.acquire("device-a", "tab-a", undefined, true);
      await sessions.setProfile("device-a", record.sid, "p-0123456789");
      await rm(dir, { recursive: true, force: true });
      await writeFile(dir, "blocks the data directory");
      await expect(sessions.release("device-a", record.sid)).rejects.toThrow();
      expect(sessions.get(record.sid)).toBe(record);
      expect(sessions.owns("device-a", record.sid)).toBe(true);
      expect(sessions.profileOf(record.sid)).toBe("p-0123456789");
      await rm(dir);
      await sessions.release("device-a", record.sid);
      expect((await createClientSessions({ file })).all()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("separates two tabs in the same authenticated browser without changing its identity", async () => {
    const sessions = await createClientSessions();
    const a = await sessions.acquire("device", "tab-a"),
      b = await sessions.acquire("device", "tab-b");
    expect(a.sid).not.toBe(b.sid);
    expect(await sessions.acquire("device", "chat-return", a.sid)).toBe(a);
  });
  it("persists both concurrent allocations across a gateway restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "client-record-test-"));
    try {
      const file = join(dir, "sessions.json"),
        sessions = await createClientSessions({ file });
      await Promise.all([sessions.acquire("a", "one"), sessions.acquire("b", "two")]);
      const loaded = await createClientSessions({ file });
      expect(loaded.owns("a", "client-1")).toBe(true);
      expect(loaded.owns("b", "client-2")).toBe(true);
      expect((await loaded.acquire("a", "one")).sid).toBe("client-1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("migrates device ownership without dropping sessions or repeating the user prefix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clients-owner-migration-"));
    try {
      const file = join(dir, "sessions.json");
      const sessions = await createClientSessions({ file });
      const record = await sessions.acquire("device-old", "tab-old");
      const mapper = (owner: string) =>
        owner.startsWith("device-") ? `user-admin/${owner}` : owner;
      await sessions.migrateOwners(mapper);
      await sessions.migrateOwners(mapper);
      expect(sessions.owns("device-old", record.sid)).toBe(false);
      expect(sessions.owns("user-admin/device-old", record.sid)).toBe(true);
      expect((await createClientSessions({ file })).get(record.sid)?.owner).toBe(
        "user-admin/device-old",
      );
      expect(sessions.all()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rolls ownership back if the migrated store cannot be persisted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clients-owner-failure-"));
    try {
      const sessions = await createClientSessions({ file: join(dir, "sessions.json") });
      const record = await sessions.acquire("device-old", "tab-old");
      await rm(dir, { recursive: true, force: true });
      await writeFile(dir, "blocks the data directory");
      await expect(sessions.migrateOwners((owner) => `user-admin/${owner}`)).rejects.toThrow();
      expect(sessions.owns("device-old", record.sid)).toBe(true);
      expect(sessions.owns("user-admin/device-old", record.sid)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("remembers that a session was opened from a phone, across a later request", async () => {
    const sessions = await createClientSessions();
    const phone = await sessions.acquire("device-a", "tab-a", undefined, true);
    expect(phone.phone).toBe(true);
    expect(await sessions.acquire("device-a", "tab-a")).toBe(phone);
    expect((await sessions.acquire("device-b", "tab-b")).phone).toBeUndefined();
  });

  it("keeps the account a session uses, across restarts, and starts on the default one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clients-profile-"));
    try {
      const file = join(dir, "sessions.json");
      const sessions = await createClientSessions({ file });
      const record = await sessions.acquire("device-a", "key-a");
      expect(sessions.profileOf(record.sid)).toBe("default");
      await sessions.setProfile("device-a", record.sid, "p-0123456789");
      expect((await createClientSessions({ file })).profileOf(record.sid)).toBe("p-0123456789");
      await expect(sessions.setProfile("device-b", record.sid, "default")).rejects.toMatchObject({
        code: "CLIENT_FORBIDDEN",
      });
      await expect(sessions.setProfile("device-a", record.sid, "../x")).rejects.toMatchObject({
        code: "PROFILE_UNKNOWN",
      });
      await sessions.setProfile("device-a", record.sid, "default");
      expect(sessions.get(record.sid)?.profile).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
