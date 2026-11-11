import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClientSessions, isClientSlot, parseSessionCapacity } from "./clients";

describe("session capacity configuration", () => {
  it("defaults to eight and accepts positive safe integer capacities", () => {
    expect(parseSessionCapacity({})).toBe(8);
    expect(parseSessionCapacity({ MIRROR_CLIENTS: "" })).toBe(8);
    for (const size of [1, 3, 12, 32, 128])
      expect(parseSessionCapacity({ MIRROR_CLIENTS: String(size) })).toBe(size);
  });

  it.each(["0", "-1", "1.5", "1e2", "NaN", "Infinity", "01", "9007199254740992"])(
    "rejects invalid capacity %s instead of falling back to a shared browser",
    (value) => {
      expect(() => parseSessionCapacity({ MIRROR_CLIENTS: value })).toThrow(
        "positive safe integer",
      );
    },
  );

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
  it.each([3, 12])(
    "honors a capacity of %i, restores a tab and rejects an extra session",
    async (maxSessions) => {
      const sessions = await createClientSessions({ maxSessions });
      expect(sessions.capacity()).toBe(maxSessions);
      expect([...sessions.slots()]).toHaveLength(maxSessions);
      const [a, b] = await Promise.all([
        sessions.acquire("device-a", "tab-a"),
        sessions.acquire("device-b", "tab-b"),
      ]);
      expect([a.sid, b.sid]).toEqual(["client-1", "client-2"]);
      expect(await sessions.acquire("device-a", "tab-a")).toBe(a);
      await Promise.all(
        Array.from({ length: maxSessions - 2 }, (_, i) =>
          sessions.acquire(`device-${i + 3}`, `tab-${i + 3}`),
        ),
      );
      expect(sessions.available()).toBe(0);
      expect(sessions.all()).toHaveLength(maxSessions);
      await expect(sessions.acquire("device-c", "tab-c")).rejects.toMatchObject({
        statusCode: 503,
        code: "CLIENT_CAPACITY",
      });
      expect(sessions.owns("device-b", a.sid)).toBe(false);
      await expect(sessions.acquire("device-b", "another", a.sid)).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(sessions.release("device-b", a.sid)).rejects.toMatchObject({ statusCode: 403 });
      await sessions.release("device-a", a.sid);
      expect((await sessions.acquire("device-c", "tab-c")).sid).toBe("client-1");
      expect(sessions.owns("device-b", b.sid)).toBe(true);
    },
  );
  it("keeps persisted sessions above a reduced limit and blocks admission until enough are released", async () => {
    const dir = await mkdtemp(join(tmpdir(), "client-capacity-test-"));
    try {
      const file = join(dir, "sessions.json");
      const original = await createClientSessions({ file, maxSessions: 3 });
      const records = await Promise.all(
        [1, 2, 3].map((n) => original.acquire("device", `tab-${n}`)),
      );
      const reduced = await createClientSessions({ file, maxSessions: 1 });
      expect(reduced.all()).toHaveLength(3);
      expect(reduced.available()).toBe(0);
      expect(await reduced.acquire("device", "return", "client-3")).toEqual(records[2]);
      expect(reduced.describe("client-3").label).toBe("独立会话 3");
      await expect(reduced.acquire("new", "new")).rejects.toMatchObject({
        code: "CLIENT_CAPACITY",
      });
      await reduced.release("device", "client-1");
      await reduced.release("device", "client-2");
      await expect(reduced.acquire("new", "new")).rejects.toMatchObject({
        code: "CLIENT_CAPACITY",
      });
      await reduced.release("device", "client-3");
      expect(reduced.available()).toBe(1);
      expect((await reduced.acquire("new", "new")).sid).toBe("client-1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("allocates again after automatic release when the page restores its old session hint", async () => {
    const sessions = await createClientSessions();
    const previous = await sessions.acquire("device-a", "tab-a");
    await sessions.release("device-a", previous.sid);
    const next = await sessions.acquire("device-a", "tab-a", previous.sid);
    expect(next).not.toBe(previous);
    expect(sessions.owns("device-a", next.sid)).toBe(true);
  });
  it("retains ownership and capacity when releasing cannot persist, and permits a later retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clients-release-failure-"));
    try {
      const file = join(dir, "sessions.json");
      const sessions = await createClientSessions({ file, maxSessions: 1 });
      const record = await sessions.acquire("device-a", "tab-a", undefined, true);
      await sessions.setProfile("device-a", record.sid, "p-0123456789");
      await rm(dir, { recursive: true, force: true });
      await writeFile(dir, "blocks the data directory");
      await expect(sessions.release("device-a", record.sid)).rejects.toThrow();
      expect(sessions.get(record.sid)).toBe(record);
      expect(sessions.owns("device-a", record.sid)).toBe(true);
      expect(sessions.available()).toBe(0);
      expect(sessions.profileOf(record.sid)).toBe("p-0123456789");
      await expect(sessions.acquire("device-b", "tab-b")).rejects.toMatchObject({
        code: "CLIENT_CAPACITY",
      });
      await rm(dir);
      await sessions.release("device-a", record.sid);
      expect(sessions.available()).toBe(1);
      expect((await createClientSessions({ file, maxSessions: 1 })).all()).toEqual([]);
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
