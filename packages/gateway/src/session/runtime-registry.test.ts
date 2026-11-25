import { describe, expect, it, vi } from "vitest";
import { createClientSessions, type ClientRecord } from "./clients";
import { createLifecycleLock } from "./lifecycle-lock";
import {
  createSessionRuntimeRegistry,
  SESSION_SLEEP_LIMIT_MS,
  type RegisteredRuntime,
  type RuntimeRegistryDeps,
  type RuntimeStart,
} from "./runtime-registry";

interface FakeRuntime extends RegisteredRuntime {
  sid: string;
  urls: string[];
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

async function fixture(overrides: Partial<RuntimeRegistryDeps<FakeRuntime>> = {}) {
  let now = 1_000_000;
  const sessions = await createClientSessions({ now: () => now });
  const events: string[] = [];
  const online = new Set<string>();
  const starts: { record: ClientRecord; start: RuntimeStart<FakeRuntime> }[] = [];
  const state = { stopping: false, mayRun: true };
  const deps: RuntimeRegistryDeps<FakeRuntime> = {
    lock: createLifecycleLock(),
    sessions,
    isStopping: () => state.stopping,
    isOnline: (sid) => online.has(sid),
    mayRun: () => state.mayRun,
    now: () => now,
    async start(record, start) {
      starts.push({ record, start });
      const runtime: FakeRuntime = {
        sid: record.sid,
        account: { id: sessions.profileOf(record.sid) },
        urls: start.sleeping?.urls ?? [],
        tabs: {
          size: 2,
          tabsMessage: async () => ({
            tabs: [
              { url: "https://a.test/", active: false },
              { url: "https://b.test/", active: true },
            ],
          }),
        },
        stop: vi.fn(async () => {}),
      };
      start.attach(runtime);
      return runtime;
    },
    async disconnect(sid, ended) {
      events.push(`disconnect ${sid}${ended ? " ended" : ""} closing=${registry.isClosing(sid)}`);
    },
    async closeWindows(sid, runtime) {
      events.push(`close ${sid} closing=${registry.isClosing(sid)}`);
      await runtime?.stop();
    },
    forget: (sid) => events.push(`forget ${sid}`),
    onChange: () => events.push("change"),
    ...overrides,
  };
  const registry = createSessionRuntimeRegistry(deps);
  const acquire = async (owner = "user-1/device-1", key = "key-1") => sessions.acquire(owner, key);
  return {
    registry,
    sessions,
    events,
    online,
    starts,
    state,
    acquire,
    advance: (ms: number) => (now += ms),
  };
}

describe("session runtime registry", () => {
  it("starts a session once however many ask, inside the lifecycle lock", async () => {
    const { registry, acquire, starts } = await fixture();
    const record = await acquire();
    const [first, second] = await Promise.all([
      registry.ensure(record.sid),
      registry.ensure(record.sid),
    ]);
    expect(first).toBe(second);
    expect(starts).toHaveLength(1);
    expect(registry.get(record.sid)).toBe(first);
    expect(registry.isLive(record.sid)).toBe(true);
    expect(registry.isStarted(record.sid)).toBe(true);
    expect(registry.profileInUse("default")).toBe(true);
  });

  it("refuses to start while stopping, for a forbidden owner, or for an unknown session", async () => {
    const { registry, acquire, state } = await fixture();
    const record = await acquire();
    state.mayRun = false;
    await expect(registry.ensure(record.sid)).rejects.toMatchObject({
      statusCode: 403,
      code: "CLIENT_FORBIDDEN",
    });
    await expect(registry.ensure("client-99")).rejects.toMatchObject({ statusCode: 403 });
    state.mayRun = true;
    state.stopping = true;
    await expect(registry.ensure(record.sid)).rejects.toMatchObject({
      statusCode: 503,
      code: "SERVICE_STOPPING",
    });
    expect(registry.has(record.sid)).toBe(false);
  });

  it("forgets a start that failed so the next request tries again", async () => {
    let fail = true;
    const { registry, acquire } = await fixture({
      async start(record, start) {
        const runtime = {
          sid: record.sid,
          account: { id: "default" },
          urls: [],
          tabs: { size: 0, tabsMessage: async () => ({ tabs: [] }) },
          stop: vi.fn(async () => {}),
        };
        start.attach(runtime);
        if (fail) {
          start.detach();
          throw new Error("chrome failed");
        }
        return runtime;
      },
    });
    const record = await acquire();
    await expect(registry.ensure(record.sid)).rejects.toThrow("chrome failed");
    expect(registry.has(record.sid)).toBe(false);
    expect(registry.isStarted(record.sid)).toBe(false);
    fail = false;
    await expect(registry.ensure(record.sid)).resolves.toMatchObject({ sid: record.sid });
  });

  it("tears down in order: closing first, windows, the caller's work, then forgotten", async () => {
    const { registry, acquire, events, sessions } = await fixture();
    const record = await acquire();
    const runtime = await registry.ensure(record.sid);
    let closingDuringAfter = false;
    await registry.teardown(record.sid, {
      afterStop: async () => {
        closingDuringAfter = registry.isClosing(record.sid);
        events.push("after");
      },
    });
    expect(events).toEqual([
      `disconnect ${record.sid} closing=true`,
      `close ${record.sid} closing=true`,
      "after",
      "change",
    ]);
    expect(closingDuringAfter).toBe(true);
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(registry.has(record.sid)).toBe(false);
    expect(registry.isClosing(record.sid)).toBe(false);
    expect(registry.isStarted(record.sid)).toBe(false);
    // Without release the record stays.
    expect(sessions.get(record.sid)).toBe(record);
  });

  it("refuses new starts and new teardowns of a session that is closing", async () => {
    const windows = deferred<void>();
    const { registry, acquire } = await fixture({ closeWindows: () => windows.promise });
    const record = await acquire();
    await registry.ensure(record.sid);
    const teardown = registry.teardown(record.sid);
    await vi.waitFor(() => expect(registry.isClosing(record.sid)).toBe(true));
    expect(registry.isLive(record.sid)).toBe(false);
    expect(registry.liveForProfile("default")).toEqual([]);
    await expect(registry.ensureLocked(record.sid)).rejects.toMatchObject({
      statusCode: 503,
      code: "CLIENT_CLOSING",
    });
    await expect(registry.releaseLocked(record.owner, record.sid)).rejects.toMatchObject({
      statusCode: 409,
      code: "CLIENT_CLOSING",
    });
    await expect(
      registry.switchProfileLocked(record.owner, record.sid, "p-0123456789"),
    ).rejects.toMatchObject({ statusCode: 409, code: "CLIENT_CLOSING" });
    windows.resolve();
    await teardown;
  });

  it("forgets the runtime and broadcasts even when closing the windows fails", async () => {
    const { registry, acquire, events } = await fixture({
      closeWindows: async () => {
        throw new Error("window stuck");
      },
    });
    const record = await acquire();
    await registry.ensure(record.sid);
    await expect(registry.teardown(record.sid)).rejects.toThrow("window stuck");
    expect(registry.has(record.sid)).toBe(false);
    expect(registry.isClosing(record.sid)).toBe(false);
    expect(events.at(-1)).toBe("change");
  });

  it("goes on to release the record after a reported stop failure", async () => {
    const reported: unknown[] = [];
    const { registry, acquire, events, sessions } = await fixture({
      closeWindows: async () => {
        throw new Error("window stuck");
      },
    });
    const record = await acquire();
    await registry.teardown(record.sid, {
      release: record.owner,
      onStopError: (error) => reported.push(error),
    });
    expect(reported).toHaveLength(1);
    expect(sessions.get(record.sid)).toBeUndefined();
    expect(events).toContain(`forget ${record.sid}`);
  });

  it("releases only the owner's session, with the terminal close code", async () => {
    const { registry, acquire, events, sessions } = await fixture();
    const record = await acquire();
    await expect(registry.release("user-2/device-1", record.sid)).rejects.toMatchObject({
      statusCode: 403,
      code: "CLIENT_FORBIDDEN",
    });
    await registry.release(record.owner, record.sid);
    expect(sessions.get(record.sid)).toBeUndefined();
    expect(events).toEqual([
      `disconnect ${record.sid} ended closing=true`,
      `close ${record.sid} closing=true`,
      `forget ${record.sid}`,
      "change",
    ]);
  });

  it("switches a session's profile by closing its windows, and not when it is already there", async () => {
    const { registry, acquire, sessions, events } = await fixture();
    const record = await acquire();
    await registry.ensure(record.sid);
    await registry.switchProfileLocked(record.owner, record.sid, "default");
    expect(events).toEqual([]);
    await registry.switchProfileLocked(record.owner, record.sid, "p-0123456789");
    expect(sessions.profileOf(record.sid)).toBe("p-0123456789");
    expect(registry.has(record.sid)).toBe(false);
  });

  it("puts an offline session to sleep with its windows and reopens them on the next start", async () => {
    const { registry, acquire, online, sessions, starts } = await fixture();
    const record = await acquire();
    await registry.ensure(record.sid);
    online.add(record.sid);
    await registry.sleep(record.sid, record);
    expect(registry.has(record.sid)).toBe(true);
    online.delete(record.sid);
    await registry.sleep(record.sid, { other: "token" });
    expect(registry.has(record.sid)).toBe(true);
    await registry.sleep(record.sid, record);
    expect(registry.has(record.sid)).toBe(false);
    expect(sessions.get(record.sid)?.sleepingSince).toBeDefined();
    const woken = await registry.ensure(record.sid);
    expect(starts.at(-1)!.start.sleeping).toMatchObject({
      token: record,
      profile: "default",
      urls: ["https://a.test/", "https://b.test/"],
      active: 1,
    });
    expect(woken.urls).toEqual(["https://a.test/", "https://b.test/"]);
    // Once started, the remembered windows are gone.
    await registry.teardown(record.sid);
    await registry.ensure(record.sid);
    expect(starts.at(-1)!.start.sleeping).toBeUndefined();
  });

  it("releases a session asleep for a day instead of starting it", async () => {
    const { registry, acquire, sessions, advance } = await fixture();
    const record = await acquire();
    await sessions.setSleeping(record, true);
    advance(SESSION_SLEEP_LIMIT_MS - 1);
    expect(await registry.expireSleepingLocked(record)).toBe(false);
    advance(1);
    await expect(registry.ensure(record.sid)).rejects.toMatchObject({ statusCode: 403 });
    expect(sessions.get(record.sid)).toBeUndefined();
  });

  it("runs teardowns one at a time with other lifecycle work", async () => {
    const order: string[] = [];
    const windows = deferred<void>();
    const { registry, acquire } = await fixture({
      closeWindows: async (sid) => {
        order.push(`close ${sid}`);
        await windows.promise;
      },
    });
    const record = await acquire();
    const releasing = registry.release(record.owner, record.sid);
    const starting = registry.ensure(record.sid).catch((error: { code?: string }) => {
      order.push(`start ${error.code}`);
    });
    await vi.waitFor(() => expect(order).toEqual([`close ${record.sid}`]));
    windows.resolve();
    await releasing;
    await starting;
    expect(order).toEqual([`close ${record.sid}`, "start CLIENT_FORBIDDEN"]);
  });

  it("stops every runtime at shutdown and reports failures", async () => {
    const { registry, acquire } = await fixture();
    const a = await registry.ensure((await acquire("u/d", "a")).sid);
    const b = await registry.ensure((await acquire("u/d", "b")).sid);
    a.stop.mockRejectedValueOnce(new Error("stuck"));
    const reported: unknown[] = [];
    await registry.stopAll((error) => reported.push(error));
    expect(b.stop).toHaveBeenCalledOnce();
    expect(reported).toHaveLength(1);
    expect(registry.size).toBe(0);
  });
});
