import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClientSessions } from "./clients";

describe("client ownership", () => {
  it("allocates sixteen independent slots, restores a tab and rejects an extra session", async () => {
    const sessions = await createClientSessions();
    const [a, b] = await Promise.all([
      sessions.acquire("device-a", "tab-a"),
      sessions.acquire("device-b", "tab-b"),
    ]);
    expect([a.sid, b.sid]).toEqual(["client-1", "client-2"]);
    expect(await sessions.acquire("device-a", "tab-a")).toBe(a);
    await Promise.all(
      Array.from({ length: 14 }, (_, i) => sessions.acquire(`device-${i + 3}`, `tab-${i + 3}`)),
    );
    expect(sessions.available()).toBe(0);
    expect(sessions.all()).toHaveLength(16);
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
  });
  it("allocates again after automatic release when the page restores its old session hint", async () => {
    const sessions = await createClientSessions();
    const previous = await sessions.acquire("device-a", "tab-a");
    await sessions.release("device-a", previous.sid);
    const next = await sessions.acquire("device-a", "tab-a", previous.sid);
    expect(next).not.toBe(previous);
    expect(sessions.owns("device-a", next.sid)).toBe(true);
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
