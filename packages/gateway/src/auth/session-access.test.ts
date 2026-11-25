import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { createClientSessions } from "../session/clients";
import { mintInvite, verifyInvite } from "./invite";
import { SESSION_COOKIE } from "./middleware";
import { createSessionAccess, type SessionAccessDeps } from "./session-access";
import type { FrontendUser } from "./users";

const KEY = Buffer.from("session-access-test-key");
const user = (id: string, role: "admin" | "user" = "user") =>
  ({ id, username: id, role, enabled: true }) as FrontendUser;
const ALICE = user("alice");
const BOB = user("bob");
const ADMIN = user("admin", "admin");

/** A request signed in as `login` on device `device`. */
const request = (login?: string, device?: string, url = "/", headers = {}) =>
  ({
    url,
    headers: {
      ...headers,
      cookie: [
        login && `login=${login}`,
        device && `${SESSION_COOKIE}=${mintInvite({ sid: device, role: "driver", exp: 2e9 }, KEY)}`,
      ]
        .filter(Boolean)
        .join("; "),
    },
  }) as unknown as IncomingMessage;

async function fixture(overrides: Partial<SessionAccessDeps<{ name: string }>> = {}) {
  const sessions = await createClientSessions();
  const profiles = new Map([
    ["default", "alice"],
    ["p-0000000001", "bob"],
  ]);
  const closing = new Set<string>();
  const runtimes = new Map<string, { name: string }>();
  const state = { stopping: false };
  const users = new Map([
    ["alice", ALICE],
    ["bob", BOB],
  ]);
  const access = createSessionAccess<{ name: string }>({
    e2e: false,
    key: KEY,
    bootstrapAdmin: () => ADMIN,
    signedInUser: (incoming) => {
      const login = /login=(\w+)/.exec(incoming.headers.cookie ?? "")?.[1];
      return (login && users.get(login)) || null;
    },
    deviceSession: (incoming) => {
      const token = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(incoming.headers.cookie ?? "");
      return token ? verifyInvite(token[1]!, KEY, 1) : null;
    },
    sessions,
    profileOwner: (id) => profiles.get(id),
    isStopping: () => state.stopping,
    isClosing: (sid) => closing.has(sid),
    runtimeOf: (sid) => runtimes.get(sid),
    ...overrides,
  });
  const alicesSession = await sessions.acquire("alice/device-1", "key");
  return { access, sessions, profiles, closing, runtimes, state, users, alicesSession };
}

describe("session access", () => {
  it("keys the owner by user and device", async () => {
    const { access } = await fixture();
    expect(access.currentOwner(request("alice", "device-1"))).toBe("alice/device-1");
    expect(access.currentOwner(request("alice"))).toBeUndefined();
    expect(access.currentOwner(request(undefined, "device-1"))).toBeUndefined();
    expect(access.currentOwner(request("alice", "not-a-device"))).toBeUndefined();
    expect(access.userIdForOwner("alice/device-1")).toBe("alice");
    expect(access.userIdForOwner("device-1")).toBeUndefined();
  });

  it("grants the owner's own workspace with its runtime", async () => {
    const { access, alicesSession, runtimes } = await fixture();
    const sid = alicesSession.sid;
    expect(access.authorizeSession(request("alice", "device-1"), sid)).toEqual({
      user: ALICE,
      owner: "alice/device-1",
      runtime: undefined,
    });
    runtimes.set(sid, { name: "running" });
    expect(access.authorizeSession(request("alice", "device-1"), sid).runtime).toEqual({
      name: "running",
    });
  });

  it("refuses another device, another user, a signed-out request and an unknown session", async () => {
    const { access, alicesSession } = await fixture();
    const sid = alicesSession.sid;
    for (const asking of [
      request("alice", "device-2"),
      request("bob", "device-1"),
      request(undefined, "device-1"),
    ]) {
      expect(access.sessionGrant(asking, sid)).toBeUndefined();
      expect(access.ownsSession(asking, sid)).toBe(false);
      expect(() => access.authorizeSession(asking, sid)).toThrow(
        expect.objectContaining({ statusCode: 403, code: "CLIENT_FORBIDDEN" }),
      );
    }
    expect(access.sessionGrant(request("alice", "device-1"), "client-9")).toBeUndefined();
  });

  it("refuses a workspace whose profile is no longer the user's", async () => {
    const { access, alicesSession, profiles } = await fixture();
    profiles.set("default", "bob");
    expect(access.sessionGrant(request("alice", "device-1"), alicesSession.sid)).toBeUndefined();
    expect(access.ownsSession(request("alice", "device-1"), alicesSession.sid)).toBe(false);
  });

  it("does not grant a closing workspace, though the owner still owns it", async () => {
    const { access, alicesSession, closing } = await fixture();
    closing.add(alicesSession.sid);
    expect(access.sessionGrant(request("alice", "device-1"), alicesSession.sid)).toBeUndefined();
    expect(access.ownsSession(request("alice", "device-1"), alicesSession.sid)).toBe(true);
  });

  it("requires the same live owner, and none while the service stops", async () => {
    const { access, state } = await fixture();
    expect(access.requireLiveOwner(request("alice", "device-1"), "alice/device-1")).toBe(ALICE);
    expect(() => access.requireLiveOwner(request("alice", "device-2"), "alice/device-1")).toThrow(
      expect.objectContaining({ statusCode: 401, code: "LOGIN_REQUIRED" }),
    );
    state.stopping = true;
    expect(() => access.requireLiveOwner(request("alice", "device-1"), "alice/device-1")).toThrow(
      expect.objectContaining({ statusCode: 401 }),
    );
  });

  it("checks browser profile ownership", async () => {
    const { access } = await fixture();
    expect(access.ownsProfile("alice", "default")).toBe(true);
    expect(access.ownsProfile("alice", "p-0000000001")).toBe(false);
    expect(() => access.requireOwnProfile("alice", "default")).not.toThrow();
    for (const [userId, profile] of [
      ["alice", "p-0000000001"],
      ["alice", "p-missing"],
      [undefined, "default"],
    ] as const)
      expect(() => access.requireOwnProfile(userId, profile)).toThrow(
        expect.objectContaining({ statusCode: 403, code: "PROFILE_FORBIDDEN" }),
      );
  });

  it("keeps a device's identity when it mints a fresh device cookie", async () => {
    const { access } = await fixture();
    const cookie = access.deviceCookie(request("alice", "device-7"));
    const token = cookie.slice(`${SESSION_COOKIE}=`.length, cookie.indexOf(";"));
    expect(verifyInvite(token, KEY, 1)).toMatchObject({ sid: "device-7", role: "driver" });
    expect(cookie).toMatch(/; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=\d+$/);
    const fresh = access.deviceCookie(request("alice"));
    const freshToken = fresh.slice(`${SESSION_COOKIE}=`.length, fresh.indexOf(";"));
    expect(verifyInvite(freshToken, KEY, 1)?.sid).toMatch(/^device-[0-9a-f-]{36}$/);
  });

  it("lets end-to-end fixtures name their owner and act as the administrator", async () => {
    const { access, sessions } = await fixture({ e2e: true });
    const asking = request(undefined, undefined, "/?e2e-owner=tester");
    expect(access.currentOwner(asking)).toBe("test-tester");
    expect(
      access.currentOwner(request(undefined, undefined, "/", { "x-mirror-e2e-owner": "x" })),
    ).toBe("test-x");
    expect(access.currentOwner(request(undefined, undefined, "/?e2e-owner=bad owner"))).toBe(
      undefined,
    );
    expect(access.currentUser(asking)).toBe(ADMIN);
    expect(access.userIdForOwner("test-tester")).toBe("admin");
    const record = await sessions.acquire("test-tester", "key-2");
    expect(access.sessionGrant(asking, record.sid)).toBeUndefined();
  });
});
