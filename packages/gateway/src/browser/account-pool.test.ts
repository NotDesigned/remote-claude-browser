import { describe, expect, it } from "vitest";
import type { FrontendUser } from "../auth/users";
import type { ProfileRecord } from "../session/profiles";
import { likelyExitZone, type AccountPoolDeps } from "./account-pool";

const user = (id: string): FrontendUser => ({
  id,
  username: id,
  role: "user",
  enabled: true,
  createdAt: 0,
});

function deps(
  records: Array<Partial<ProfileRecord> & { id: string; owner: string }>,
  checked?: { timeZone: string; checkedAt: number },
) {
  const byId = new Map(records.map((record) => [record.id, record as ProfileRecord]));
  return {
    profiles: {
      get: (id: string) => byId.get(id),
      all: () => [...byId.values()],
    } as unknown as AccountPoolDeps["profiles"],
    profileUser: (id: string) => {
      const owner = records.find((record) => record.id === id)?.owner;
      return owner === undefined ? undefined : user(owner);
    },
    checkedExitZone: (userId: string, proxyId: string) =>
      userId === "u1" && proxyId === "n1" ? checked : undefined,
  };
}

describe("the zone a profile's browser starts on before the exit lookup answers", () => {
  it("is the profile's own zone from last time", () => {
    const pool = deps(
      [
        { id: "a", owner: "u1", proxyId: "n1", timeZone: "Asia/Tokyo", checkedAt: 1 },
        { id: "b", owner: "u1", proxyId: "n1", timeZone: "Europe/Paris", checkedAt: 9 },
      ],
      { timeZone: "America/New_York", checkedAt: 10 },
    );
    expect(likelyExitZone(pool, "a", "u1", "n1")).toBe("Asia/Tokyo");
  });

  it("for a new profile, is the newest zone the same user found for the node", () => {
    const records = [
      { id: "new", owner: "u1", proxyId: "n1" },
      { id: "old", owner: "u1", proxyId: "n1", timeZone: "Asia/Tokyo", checkedAt: 5 },
      { id: "other-node", owner: "u1", proxyId: "n2", timeZone: "Europe/Paris", checkedAt: 50 },
      { id: "other-user", owner: "u2", proxyId: "n1", timeZone: "Europe/Berlin", checkedAt: 60 },
    ];
    // The picker's check of the node before it created the profile is newer.
    const newer = deps(records, { timeZone: "America/New_York", checkedAt: 7 });
    expect(likelyExitZone(newer, "new", "u1", "n1")).toBe("America/New_York");
    const older = deps(records, { timeZone: "America/New_York", checkedAt: 3 });
    expect(likelyExitZone(older, "new", "u1", "n1")).toBe("Asia/Tokyo");
    expect(likelyExitZone(deps(records), "new", "u1", "n1")).toBe("Asia/Tokyo");
  });

  it("is unknown for a node the user has not looked up", () => {
    const pool = deps([
      { id: "new", owner: "u1", proxyId: "n3" },
      { id: "other-user", owner: "u2", proxyId: "n3", timeZone: "Europe/Berlin", checkedAt: 60 },
    ]);
    expect(likelyExitZone(pool, "new", "u1", "n3")).toBeUndefined();
  });
});
