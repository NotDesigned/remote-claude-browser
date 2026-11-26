/**
 * Which sessions have a running browser, and the rules for starting and ending one. Every start
 * and end runs inside the account lifecycle lock; a session being ended is marked closing first,
 * so input, page sync and new connections stop reaching it before its windows close.
 */
import { ClientSessionError, type ClientRecord, type createClientSessions } from "./clients";
import type { createLifecycleLock } from "./lifecycle-lock";

/** A session asleep this long is released: its record goes, and its windows are not restored. */
export const SESSION_SLEEP_LIMIT_MS = 24 * 60 * 60 * 1000;

/** What the registry needs to know of a running session's browser. */
export interface RegisteredRuntime {
  readonly account: { readonly id: string };
  readonly tabs: {
    readonly size: number;
    tabsMessage(): Promise<{ tabs: readonly { url: string; active: boolean }[] }>;
  };
  stop(): Promise<void>;
}

/** The windows of a session put to sleep, reopened when it starts again on the same profile. */
export interface SleepingWindows {
  /** The session record they belong to; a reassigned slot does not get them. */
  token: ClientRecord;
  profile: string;
  urls: string[];
  active: number;
}

/** What starting a runtime is given besides the record. */
export interface RuntimeStart<R> {
  /** Windows to reopen, if the session went to sleep with some. */
  sleeping: SleepingWindows | undefined;
  /** The runtime is reachable from here on (its first pages publish while they open). */
  attach(runtime: R): void;
  /** Starting failed after attach: it is not reachable any more. */
  detach(): void;
}

export type ClientSessions = Awaited<ReturnType<typeof createClientSessions>>;

export interface RuntimeRegistryDeps<R extends RegisteredRuntime> {
  lock: ReturnType<typeof createLifecycleLock>;
  sessions: Pick<
    ClientSessions,
    "get" | "all" | "owns" | "profileOf" | "release" | "setSleeping" | "setProfile"
  >;
  isStopping(): boolean;
  /** Whether a viewer is connected to the session; such a session is never put to sleep. */
  isOnline(sid: string): boolean;
  /** Whether the record's owner may still run it: an enabled user who owns its profile. */
  mayRun(record: ClientRecord): boolean;
  now(): number;
  start(record: ClientRecord, start: RuntimeStart<R>): Promise<R>;
  /** Cut the session's viewers and fetches off before its windows close. */
  disconnect(sid: string, ended: boolean): Promise<void>;
  /** Close the session's windows (its runtime's, when it got that far) and wait until they are. */
  closeWindows(sid: string, runtime: R | undefined): Promise<void>;
  /** The session record is gone for good: forget its connection ordering. */
  forget(sid: string): void;
  /** Which sessions run, or how, changed. */
  onChange(): void;
}

export interface TeardownOptions {
  /** The session is over for good: its viewers get the terminal close code. */
  ended?: boolean;
  /** Also release the session record, which this owner holds. */
  release?: string;
  /** Runs once the session is marked closing, before its windows close. */
  beforeStop?: () => Promise<void>;
  /** Runs after the windows closed (and the record was released), still marked closing. */
  afterStop?: () => Promise<void>;
  /** Reports a failure to close the windows and goes on instead of failing the teardown. */
  onStopError?: (error: unknown) => void;
}

export type SessionRuntimeRegistry<R extends RegisteredRuntime> = ReturnType<
  typeof createSessionRuntimeRegistry<R>
>;

export function createSessionRuntimeRegistry<R extends RegisteredRuntime>(
  deps: RuntimeRegistryDeps<R>,
) {
  const runtimes = new Map<string, R>();
  const pending = new Map<string, Promise<R>>();
  const closing = new Set<string>();
  const sleepingWindows = new Map<string, SleepingWindows>();

  /** Closes a session's windows. Only teardown calls it, with the session marked closing. */
  async function stopRuntime(sid: string, ended: boolean): Promise<void> {
    sleepingWindows.delete(sid);
    await deps.disconnect(sid, ended);
    const runtime = await pending.get(sid)?.catch(() => undefined);
    await deps.closeWindows(sid, runtime);
  }

  /**
   * The one way a session's browser goes away: mark it closing (so nothing new reaches it), close
   * its windows, do what the caller needs while it is still closing, then forget its runtime and
   * tell every other session the new totals.
   *
   * Its viewers are cut off and its windows closed even when the caller's `beforeStop` fails (that
   * failure is rethrown afterwards). When closing the windows fails and the caller does not take
   * the failure (`onStopError`), the runtime stays registered: its windows may still be open, so
   * the next start reuses it instead of opening a second set on the same scope, and the idle reaper
   * or shutdown tries to close it again.
   */
  async function teardown(sid: string, options: TeardownOptions = {}): Promise<void> {
    closing.add(sid);
    let stopped = false;
    try {
      let beforeStopFailure: { error: unknown } | undefined;
      try {
        await options.beforeStop?.();
      } catch (error) {
        beforeStopFailure = { error };
      }
      try {
        await stopRuntime(sid, options.ended === true);
      } catch (error) {
        if (!options.onStopError) throw error;
        options.onStopError(error);
      }
      stopped = true;
      if (beforeStopFailure) throw beforeStopFailure.error;
      if (options.release !== undefined) {
        await deps.sessions.release(options.release, sid);
        deps.forget(sid);
      }
      await options.afterStop?.();
    } finally {
      if (stopped) {
        runtimes.delete(sid);
        pending.delete(sid);
      }
      closing.delete(sid);
      deps.onChange();
    }
  }

  async function releaseLocked(owner: string, sid: string): Promise<void> {
    if (!deps.sessions.owns(owner, sid))
      throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个会话已结束");
    if (closing.has(sid)) throw new ClientSessionError(409, "CLIENT_CLOSING", "会话正在结束");
    await teardown(sid, { ended: true, release: owner });
  }

  /** Releases a session asleep for too long. Whether it did. */
  async function expireSleepingLocked(record: ClientRecord): Promise<boolean> {
    if (
      record.sleepingSince === undefined ||
      deps.now() - record.sleepingSince < SESSION_SLEEP_LIMIT_MS
    )
      return false;
    await releaseLocked(record.owner, record.sid);
    return true;
  }

  async function ensureLocked(sid: string): Promise<R> {
    if (deps.isStopping()) throw new ClientSessionError(503, "SERVICE_STOPPING", "服务正在重启");
    if (closing.has(sid))
      throw new ClientSessionError(503, "CLIENT_CLOSING", "会话正在结束，请稍后重试");
    const record = deps.sessions.get(sid);
    if (!record || !deps.mayRun(record) || (await expireSleepingLocked(record)))
      throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个会话不属于当前用户");
    let started = pending.get(sid);
    if (!started) {
      started = deps
        .start(record, {
          sleeping: sleepingWindows.get(sid),
          attach: (runtime) => runtimes.set(sid, runtime),
          detach: () => runtimes.delete(sid),
        })
        .then((runtime) => {
          sleepingWindows.delete(sid);
          return runtime;
        });
      const current = started;
      pending.set(sid, current);
      void current.catch(() => {
        if (pending.get(sid) === current) pending.delete(sid);
      });
    }
    return started;
  }

  return {
    get: (sid: string) => runtimes.get(sid),
    has: (sid: string) => runtimes.has(sid),
    isClosing: (sid: string) => closing.has(sid),
    /** Running and not being ended. */
    isLive: (sid: string) => runtimes.has(sid) && !closing.has(sid),
    /** Started or starting: the idle reaper watches these. */
    isStarted: (sid: string) => pending.has(sid),
    get size() {
      return runtimes.size;
    },
    sids: () => runtimes.keys(),
    values: () => runtimes.values(),
    /** The profile's live browsers, by session. */
    liveForProfile(profileId: string): [string, R][] {
      return [...runtimes].filter(
        ([sid, runtime]) => runtime.account.id === profileId && !closing.has(sid),
      );
    },
    /** Whether any session is using the profile's browser, or about to. */
    profileInUse(profileId: string): boolean {
      return (
        [...runtimes.values()].some((runtime) => runtime.account.id === profileId) ||
        [...pending.keys()].some((sid) => deps.sessions.profileOf(sid) === profileId)
      );
    },
    ensure: (sid: string) => deps.lock.run(() => ensureLocked(sid)),
    ensureLocked,
    teardown,
    release: (owner: string, sid: string) => deps.lock.run(() => releaseLocked(owner, sid)),
    releaseLocked,
    expireSleepingLocked,
    /** Moves a session to another profile. Its windows close; its viewers reconnect to new ones. */
    async switchProfileLocked(owner: string, sid: string, profileId: string): Promise<void> {
      if (closing.has(sid)) throw new ClientSessionError(409, "CLIENT_CLOSING", "会话正在结束");
      if (deps.sessions.profileOf(sid) === profileId) return;
      await teardown(sid, { afterStop: () => deps.sessions.setProfile(owner, sid, profileId) });
    },
    /**
     * The idle reaper's release: an offline session's windows close, and are remembered so that
     * it opens them again when its viewer comes back.
     */
    sleep: (sid: string, token: unknown) =>
      deps.lock.run(async () => {
        const current = deps.sessions.get(sid);
        if (!current || current !== token || deps.isOnline(sid)) return;
        let tabs: Awaited<ReturnType<RegisteredRuntime["tabs"]["tabsMessage"]>> | null = null;
        await teardown(sid, {
          async beforeStop() {
            const runtime = runtimes.get(sid);
            tabs = runtime && runtime.tabs.size > 0 ? await runtime.tabs.tabsMessage() : null;
          },
          async afterStop() {
            if (tabs)
              sleepingWindows.set(sid, {
                token: current,
                profile: deps.sessions.profileOf(sid),
                urls: tabs.tabs.map((tab) => tab.url),
                active: tabs.tabs.findIndex((tab) => tab.active),
              });
            await deps.sessions.setSleeping(current, true);
          },
        });
      }),
    /** Shutdown: stop every runtime and forget them all. */
    async stopAll(report: (error: unknown) => void): Promise<void> {
      for (const runtime of runtimes.values()) await runtime.stop().catch(report);
      runtimes.clear();
      pending.clear();
    },
  };
}
