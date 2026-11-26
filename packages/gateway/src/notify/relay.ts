/**
 * Website notifications between a session's pages and its viewers.
 *
 * A page's agent (agent/src/notifications.ts) says hello for each top document, asks for
 * permission, and sends or closes notifications. The session's viewers report their device's
 * policy (NotifyPolicy), answer permission requests and report what happened to each
 * notification. This keeps, per session, the latest policy, the documents that said hello, the
 * open notifications and the pending requests, and sends each side only what belongs to it:
 * a viewer names notifications by the gateway's ids, never a page's own, and a page hears only
 * about its own notifications and its own origin's permission.
 *
 * Viewers receive these on a notification feed (routes.ts), which stays open while the workbench
 * is in the background, when the WebSocket does not. Every feed of the session gets every
 * notification; the device's own tag (origin and the page's tag) replaces an earlier one.
 *
 * Each open workbench names itself with a random device id, on its feed and its policy. A page's
 * permission merges them (mergedNotifyPermission): granted when any device can show its
 * notifications, denied only when all refuse. A device's policy is forgotten once its feed has
 * been gone for DEVICE_GRACE_MS, so a closed workbench stops speaking for the person.
 * A notification goes to every workbench; one that may not show it reports "error", which
 * reaches the page only once every workbench it went to has; the page hears "show" once.
 */
import {
  mergedNotifyPermission,
  notifyOrigin,
  NOTIFY_DEVICE_PATTERN,
  readNotifyPolicy,
  NOTIFY_MAX_BODY,
  NOTIFY_MAX_ICON_DATA,
  NOTIFY_MAX_ICON_URL,
  NOTIFY_MAX_TAG,
  NOTIFY_MAX_TITLE,
  type Down,
  type NotifyAgentIn,
  type NotifyEventType,
  type NotifyPermission,
  type NotifyPolicy,
  type Up,
} from "@mirror/protocol";
import { randomBytes } from "node:crypto";

/** A burst of this many notifications per session, refilled at one per NOTIFY_REFILL_MS. */
export const NOTIFY_BURST = 10;
export const NOTIFY_REFILL_MS = 3_000;
/** Open notifications remembered per session; the oldest are forgotten past this. */
export const MAX_OPEN_NOTIFICATIONS = 100;
/** Pending permission requests per session; more are answered "default" at once. */
export const MAX_PENDING_ASKS = 8;
/** A request nobody answers resolves as "default", as when a person ignores the browser's. */
export const ASK_TIMEOUT_MS = 10 * 60_000;
/** Notification feeds per session; a new one past this closes the oldest. */
export const MAX_FEEDS = 4;
/** Device policies per session; the least recently reported are forgotten past this. */
export const MAX_DEVICES = 8;
/** A device's policy outlives its feed this long, for a reconnect to pick it up again. */
export const DEVICE_GRACE_MS = 60_000;
/** The key of a policy from a viewer that sent no device id. */
const ANY_DEVICE = "";

export interface NotifyFeed {
  send(message: Down): void;
  /** Ends the feed (the relay forgets it first). */
  close(): void;
  /** Whether the login that opened the feed still holds. */
  authorized(): boolean;
}

export interface NotifyRelayDeps {
  /** Delivers to one page's agent. */
  sendAgent(sid: string, tab: string, value: NotifyAgentIn): void;
  /** Whether someone is looking at the session: a viewer is connected (and so visible). */
  looking(sid: string): boolean;
  /** A same-origin address for a page's icon, through the session's asset proxy. */
  iconUrl(sid: string, url: string, documentOrigin: string): string | undefined;
  /** Brings the tab to the front of the session's window. */
  activate(sid: string, tab: string): void;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
  newId?(): string;
}

interface Shown {
  tab: string;
  agentId: number;
  origin: string;
  tag?: string;
  /** Workbenches it went to, and how many could not show it. */
  devices: number;
  errors: number;
  /** Whether the page has heard "show" (once, however many devices show it). */
  told: boolean;
}

interface Ask {
  tab: string;
  req: number;
  origin: string;
  timer: unknown;
}

interface SessionState {
  /** Device id -> its latest policy, oldest report first. */
  policies: Map<string, NotifyPolicy>;
  /** Feed -> the device id it was opened with. */
  feeds: Map<NotifyFeed, string>;
  /** Devices whose last feed went away: forgotten when the timer fires. */
  leaving: Map<string, unknown>;
  /** Documents that said hello: tab -> origin. */
  tabs: Map<string, string>;
  shown: Map<string, Shown>;
  asks: Map<string, Ask>;
  tokens: number;
  refilledAt: number;
}

type AgentMessage = {
  op?: unknown;
  origin?: unknown;
  req?: unknown;
  id?: unknown;
  title?: unknown;
  body?: unknown;
  icon?: unknown;
  tag?: unknown;
  silent?: unknown;
  requireInteraction?: unknown;
  renotify?: unknown;
};

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.slice(0, max) : "";

export type NotifyRelay = ReturnType<typeof createNotifyRelay>;

export function createNotifyRelay(deps: NotifyRelayDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms).unref());
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  const newId = deps.newId ?? (() => randomBytes(12).toString("base64url"));
  const sessions = new Map<string, SessionState>();

  const stateOf = (sid: string): SessionState => {
    let state = sessions.get(sid);
    if (state === undefined) {
      state = {
        policies: new Map(),
        feeds: new Map(),
        leaving: new Map(),
        tabs: new Map(),
        shown: new Map(),
        asks: new Map(),
        tokens: NOTIFY_BURST,
        refilledAt: now(),
      };
      sessions.set(sid, state);
    }
    return state;
  };
  const toFeeds = (state: SessionState, message: Down) => {
    for (const feed of state.feeds.keys()) feed.send(message);
  };
  const permissionFor = (state: SessionState, origin: string): NotifyPermission =>
    mergedNotifyPermission(state.policies.values(), origin);
  const tellTab = (sid: string, state: SessionState, tab: string) => {
    const origin = state.tabs.get(tab);
    if (origin === undefined) return;
    deps.sendAgent(sid, tab, {
      permission: permissionFor(state, origin),
      away: !deps.looking(sid),
    });
  };
  const tellTabs = (sid: string) => {
    const state = sessions.get(sid);
    if (state === undefined) return;
    for (const tab of state.tabs.keys()) tellTab(sid, state, tab);
  };
  /** Open workbenches: feeds without a device id count one each. */
  const devicesOf = (state: SessionState): number => {
    const named = new Set<string>();
    let anonymous = 0;
    for (const device of state.feeds.values())
      if (device === ANY_DEVICE) anonymous += 1;
      else named.add(device);
    return Math.max(1, anonymous + named.size);
  };
  const deviceOf = (value: unknown): string =>
    typeof value === "string" && NOTIFY_DEVICE_PATTERN.test(value) ? value : ANY_DEVICE;
  /** Asks whose site is now decided get their answer. */
  const settleAsks = (sid: string, state: SessionState) => {
    for (const [id, ask] of state.asks) {
      const permission = permissionFor(state, ask.origin);
      if (permission !== "default") endAsk(sid, state, id, permission);
    }
  };
  const forgetDevice = (sid: string, state: SessionState, device: string) => {
    const timer = state.leaving.get(device);
    if (timer !== undefined) clearTimer(timer);
    state.leaving.delete(device);
    if (state.policies.delete(device)) {
      tellTabs(sid);
      settleAsks(sid, state);
    }
  };
  const feedGone = (sid: string, state: SessionState, feed: NotifyFeed) => {
    const device = state.feeds.get(feed);
    if (!state.feeds.delete(feed) || device === undefined) return;
    if (device === ANY_DEVICE || [...state.feeds.values()].includes(device)) return;
    if (state.leaving.has(device)) return;
    state.leaving.set(
      device,
      setTimer(() => {
        state.leaving.delete(device);
        if (![...state.feeds.values()].includes(device)) forgetDevice(sid, state, device);
      }, DEVICE_GRACE_MS),
    );
  };
  const takeToken = (state: SessionState): boolean => {
    const at = now();
    const refill = Math.floor((at - state.refilledAt) / NOTIFY_REFILL_MS);
    if (refill > 0) {
      state.tokens = Math.min(NOTIFY_BURST, state.tokens + refill);
      state.refilledAt += refill * NOTIFY_REFILL_MS;
    }
    if (state.tokens === NOTIFY_BURST) state.refilledAt = at;
    if (state.tokens <= 0) return false;
    state.tokens -= 1;
    return true;
  };
  const endAsk = (
    sid: string,
    state: SessionState,
    id: string,
    permission: NotifyPermission | null,
  ) => {
    const ask = state.asks.get(id);
    if (ask === undefined) return;
    state.asks.delete(id);
    clearTimer(ask.timer);
    toFeeds(state, { t: "notify-ask-end", id });
    // A document that has gone since has nobody left to answer.
    if (permission !== null && state.tabs.get(ask.tab) === ask.origin)
      deps.sendAgent(sid, ask.tab, { answer: ask.req, permission });
  };
  const forgetShown = (state: SessionState, id: string, tell: boolean) => {
    if (!state.shown.delete(id)) return;
    if (tell) toFeeds(state, { t: "notify-close", id });
  };
  const icon = (sid: string, value: unknown, origin: string): string | undefined => {
    if (typeof value !== "string" || value === "") return undefined;
    if (/^data:image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)[;,]/i.test(value))
      return value.length <= NOTIFY_MAX_ICON_DATA ? value : undefined;
    if (value.length > NOTIFY_MAX_ICON_URL || !/^https?:\/\//i.test(value)) return undefined;
    return deps.iconUrl(sid, value, origin);
  };

  function showFromAgent(sid: string, state: SessionState, tab: string, message: AgentMessage) {
    const agentId = message.id;
    if (typeof agentId !== "number" || !Number.isSafeInteger(agentId)) return;
    const origin = state.tabs.get(tab);
    const refuse = () => deps.sendAgent(sid, tab, { event: agentId, type: "error" });
    // The gateway's own record decides, not what the page's side claims.
    if (origin === undefined || permissionFor(state, origin) !== "granted") return refuse();
    if (state.feeds.size === 0 || !takeToken(state)) return refuse();
    const tag = text(message.tag, NOTIFY_MAX_TAG) || undefined;
    if (tag !== undefined)
      for (const [id, shown] of state.shown)
        if (shown.origin === origin && shown.tag === tag) forgetShown(state, id, false);
    const id = newId();
    state.shown.set(id, {
      tab,
      agentId,
      origin,
      tag,
      devices: devicesOf(state),
      errors: 0,
      told: false,
    });
    for (const oldest of state.shown.keys()) {
      if (state.shown.size <= MAX_OPEN_NOTIFICATIONS) break;
      forgetShown(state, oldest, true);
    }
    const notification: Extract<Down, { t: "notify" }> = {
      t: "notify",
      id,
      tab,
      origin,
      title: text(message.title, NOTIFY_MAX_TITLE),
      body: text(message.body, NOTIFY_MAX_BODY),
    };
    const iconUrl = icon(sid, message.icon, origin);
    if (iconUrl !== undefined) notification.icon = iconUrl;
    if (tag !== undefined) notification.tag = tag;
    if (typeof message.silent === "boolean") notification.silent = message.silent;
    if (message.requireInteraction === true) notification.requireInteraction = true;
    if (message.renotify === true) notification.renotify = true;
    toFeeds(state, notification);
  }

  return {
    /** A message from the agent of `tab`, a page the caller found to belong to `sid`. */
    onAgent(sid: string, tab: string, value: unknown): void {
      if (typeof value !== "object" || value === null) return;
      const message = value as AgentMessage;
      const state = stateOf(sid);
      if (message.op === "hello") {
        const origin = notifyOrigin(message.origin);
        // A new document: the old one's requests and notifications have nobody to report to.
        for (const [id, ask] of state.asks) if (ask.tab === tab) endAsk(sid, state, id, null);
        for (const [id, shown] of state.shown) if (shown.tab === tab) state.shown.delete(id);
        if (origin === null) {
          state.tabs.delete(tab);
          return;
        }
        state.tabs.set(tab, origin);
        tellTab(sid, state, tab);
        return;
      }
      if (message.op === "ask") {
        const req = message.req;
        const origin = state.tabs.get(tab);
        if (typeof req !== "number" || !Number.isSafeInteger(req) || origin === undefined) return;
        const permission = permissionFor(state, origin);
        if (permission !== "default" || state.asks.size >= MAX_PENDING_ASKS) {
          deps.sendAgent(sid, tab, { answer: req, permission });
          return;
        }
        const id = newId();
        state.asks.set(id, {
          tab,
          req,
          origin,
          timer: setTimer(() => endAsk(sid, state, id, "default"), ASK_TIMEOUT_MS),
        });
        toFeeds(state, { t: "notify-ask", id, tab, origin });
        return;
      }
      if (message.op === "show") {
        showFromAgent(sid, state, tab, message);
        return;
      }
      if (message.op === "close") {
        for (const [id, shown] of state.shown)
          if (shown.tab === tab && shown.agentId === message.id) forgetShown(state, id, true);
      }
    },

    /** A viewer's message on the session's notification route. */
    onViewer(sid: string, message: Up): void {
      if (message.t === "notify-permission") {
        const policy = readNotifyPolicy(message);
        if (policy === null) return;
        const state = stateOf(sid);
        const device = deviceOf(message.device);
        state.policies.delete(device);
        state.policies.set(device, policy);
        for (const oldest of [...state.policies.keys()]) {
          if (state.policies.size <= MAX_DEVICES) break;
          state.policies.delete(oldest);
        }
        tellTabs(sid);
        // Requests whose site the person has now decided about.
        settleAsks(sid, state);
        return;
      }
      const state = sessions.get(sid);
      if (state === undefined) return;
      if (message.t === "notify-answer") {
        const ask = state.asks.get(message.id);
        if (ask === undefined) return;
        const decided = permissionFor(state, ask.origin);
        // "granted" holds only once this device can show them, which its policy says.
        const permission =
          message.state === "denied" ? "denied" : message.state === "granted" ? decided : "default";
        endAsk(sid, state, message.id, permission);
        return;
      }
      if (message.t === "notify-event") {
        const shown = state.shown.get(message.id);
        if (shown === undefined) return;
        const type: NotifyEventType = message.type;
        if (!["show", "click", "close", "error"].includes(type)) return;
        // A device that may not show it says "error"; it failed only once every device has.
        if (type === "error" && ++shown.errors < shown.devices) return;
        if (type === "show") {
          if (shown.told) return;
          shown.told = true;
        }
        if (type === "close" || type === "error") forgetShown(state, message.id, true);
        if (type === "click") deps.activate(sid, shown.tab);
        // Only the document that sent it, which is still the one there.
        if (state.tabs.has(shown.tab))
          deps.sendAgent(sid, shown.tab, { event: shown.agentId, type });
      }
    },

    /** A viewer's feed for the session, from the workbench `device` names; returns how to forget it. */
    addFeed(sid: string, feed: NotifyFeed, device?: string): () => void {
      const state = stateOf(sid);
      const id = deviceOf(device);
      const leaving = state.leaving.get(id);
      if (leaving !== undefined) {
        clearTimer(leaving);
        state.leaving.delete(id);
      }
      state.feeds.set(feed, id);
      for (const oldest of [...state.feeds.keys()]) {
        if (state.feeds.size <= MAX_FEEDS) break;
        feedGone(sid, state, oldest);
        oldest.close();
      }
      for (const [askId, ask] of state.asks)
        feed.send({ t: "notify-ask", id: askId, tab: ask.tab, origin: ask.origin });
      return () => feedGone(sid, state, feed);
    },

    /** Someone started or stopped looking at the session. */
    presenceChanged(sid: string): void {
      tellTabs(sid);
    },

    /** The tab closed. */
    forgetTab(sid: string, tab: string): void {
      const state = sessions.get(sid);
      if (state === undefined) return;
      state.tabs.delete(tab);
      for (const [id, ask] of state.asks) if (ask.tab === tab) endAsk(sid, state, id, null);
      for (const [id, shown] of state.shown) if (shown.tab === tab) forgetShown(state, id, false);
    },

    /** The session ended for good. */
    forgetSession(sid: string): void {
      const state = sessions.get(sid);
      if (state === undefined) return;
      sessions.delete(sid);
      for (const ask of state.asks.values()) clearTimer(ask.timer);
      for (const timer of state.leaving.values()) clearTimer(timer);
      for (const feed of [...state.feeds.keys()]) feed.close();
    },

    /** Ends feeds whose login no longer holds. */
    closeUnauthorized(): void {
      for (const [sid, state] of sessions)
        for (const [feed] of [...state.feeds])
          if (!feed.authorized()) {
            // Its say goes at once: the login that gave it no longer holds.
            const device = state.feeds.get(feed)!;
            state.feeds.delete(feed);
            feed.close();
            if (device !== ANY_DEVICE && ![...state.feeds.values()].includes(device))
              forgetDevice(sid, state, device);
          }
    },

    close(): void {
      for (const sid of [...sessions.keys()]) this.forgetSession(sid);
    },

    /** For tests. */
    inspect(sid: string) {
      const state = sessions.get(sid);
      return state
        ? {
            feeds: state.feeds.size,
            shown: state.shown.size,
            asks: state.asks.size,
            policies: state.policies.size,
            policy: (device: string = ANY_DEVICE) => state.policies.get(device) ?? null,
          }
        : undefined;
    },
  };
}
