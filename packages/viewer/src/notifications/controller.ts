/**
 * Website notifications on this device: the session's notification feed (GET /s/:sid/notify,
 * server-sent events), shown with this browser's own Notification API, and this device's answers
 * posted back on the same path.
 *
 * Desktop browsers show them with `new Notification`. Android Chrome has no such constructor
 * (it throws) and shows them through a service worker (public/notify-sw.js), which also reports
 * clicks and closes itself, since the page may be asleep by then. A click focuses the workbench;
 * the gateway brings the notification's tab to the front and tells the page.
 */
import type { Down, NotifyEventType, NotifyPermission, Up } from "@mirror/protocol";
import {
  decideSite,
  devicePolicy,
  deviceTag,
  type DevicePermission,
  type NotifySettings,
} from "./policy";

/** A permission request from a page of the session, waiting for the person. */
export interface NotifyAsk {
  id: string;
  tab: string;
  origin: string;
}

export interface NotifyState {
  settings: NotifySettings;
  device: DevicePermission;
  asks: NotifyAsk[];
}

export interface ShownHandle {
  close(): void;
}

export interface NotifyShowOptions {
  body: string;
  icon?: string;
  tag: string;
  silent?: boolean;
  requireInteraction?: boolean;
  renotify?: boolean;
  /** For the service worker: whom to report a click to. */
  data: { sid: string; id: string };
}

/** What the controller needs from the browser (browserNotifyEnv); tests pass fakes. */
export interface NotifyEnv {
  permission(): DevicePermission;
  requestPermission(): Promise<NotificationPermission>;
  /** `new Notification`; throws where the browser has no such constructor (Android). */
  showPage(
    title: string,
    options: NotifyShowOptions,
    on: (type: NotifyEventType) => void,
  ): ShownHandle;
  /** Through the service worker, or null without one. */
  showWorker: ((title: string, options: NotifyShowOptions) => Promise<void>) | null;
  closeWorker(id: string): void;
  focus(): void;
  openFeed(url: string): FeedSource;
  post(url: string, message: Up): Promise<unknown>;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface FeedSource {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  readonly readyState: number;
  close(): void;
}

/** A feed the browser gave up on (a refused or ended stream) is opened again after this. */
export const FEED_RETRY_MS = 15_000;
const CLOSED = 2;

export interface NotifyControllerOptions {
  sid: string;
  env: NotifyEnv;
  settings: NotifySettings;
  save(settings: NotifySettings): void;
  onChange(state: NotifyState): void;
}

export type NotifyController = ReturnType<typeof createNotifyController>;

export function createNotifyController(options: NotifyControllerOptions) {
  const { env, sid } = options;
  const path = `/s/${encodeURIComponent(sid)}/notify`;
  let settings = options.settings;
  let device = env.permission();
  let asks: NotifyAsk[] = [];
  const shown = new Map<string, ShownHandle | "worker">();
  let useWorker = false;
  let feed: FeedSource | null = null;
  let retry: unknown = null;
  let disposed = false;

  const changed = () => options.onChange({ settings, device, asks });
  const post = (message: Up): Promise<unknown> => env.post(path, message).catch(() => undefined);
  const report = (): Promise<unknown> => {
    const policy = devicePolicy(settings, device);
    return policy === null ? Promise.resolve() : post({ t: "notify-permission", ...policy });
  };
  const event = (id: string, type: NotifyEventType) => void post({ t: "notify-event", id, type });
  /** Re-reads the browser's permission, which the person may have changed in its settings. */
  const refresh = () => {
    const now = env.permission();
    if (now === device) return false;
    device = now;
    return true;
  };

  function show(message: Extract<Down, { t: "notify" }>) {
    if (refresh()) {
      changed();
      void report();
    }
    if (
      !settings.enabled ||
      device !== "granted" ||
      settings.origins[message.origin] !== "granted"
    ) {
      event(message.id, "error");
      return;
    }
    const showOptions: NotifyShowOptions = {
      body: message.body,
      tag: deviceTag(message.origin, message.tag, message.id),
      data: { sid, id: message.id },
    };
    if (message.icon !== undefined) showOptions.icon = message.icon;
    if (message.silent !== undefined) showOptions.silent = message.silent;
    if (message.requireInteraction) showOptions.requireInteraction = true;
    if (message.renotify) showOptions.renotify = true;
    if (!useWorker) {
      try {
        const handle = env.showPage(message.title, showOptions, (type) => {
          if (type === "click") {
            env.focus();
            handle.close();
          }
          if (type === "close" || type === "error") shown.delete(message.id);
          event(message.id, type);
        });
        shown.set(message.id, handle);
        return;
      } catch {
        // Android Chrome: "Illegal constructor. Use ServiceWorkerRegistration.showNotification()".
        if (env.showWorker === null) {
          event(message.id, "error");
          return;
        }
        useWorker = true;
      }
    }
    shown.set(message.id, "worker");
    env.showWorker!(message.title, showOptions).then(
      () => event(message.id, "show"),
      () => {
        shown.delete(message.id);
        event(message.id, "error");
      },
    );
  }

  function receive(message: Down) {
    switch (message.t) {
      case "notify":
        show(message);
        return;
      case "notify-close": {
        const handle = shown.get(message.id);
        shown.delete(message.id);
        if (handle === "worker") env.closeWorker(message.id);
        else handle?.close();
        return;
      }
      case "notify-ask":
        if (!asks.some((ask) => ask.id === message.id)) {
          asks = [...asks, { id: message.id, tab: message.tab, origin: message.origin }];
          changed();
        }
        return;
      case "notify-ask-end":
        if (asks.some((ask) => ask.id === message.id)) {
          asks = asks.filter((ask) => ask.id !== message.id);
          changed();
        }
        return;
    }
  }

  function open() {
    if (disposed) return;
    const source = env.openFeed(path);
    feed = source;
    // Every (re)connection: the gateway may have restarted and forgotten this device's policy.
    source.onopen = () => {
      refresh();
      void report();
    };
    source.onmessage = (incoming) => {
      let message: Down;
      try {
        message = JSON.parse(incoming.data) as Down;
      } catch {
        return;
      }
      receive(message);
    };
    source.onerror = () => {
      // EventSource retries a dropped stream itself; one it closed (an error status) waits here.
      if (source.readyState !== CLOSED || disposed || retry !== null) return;
      retry = env.setTimer(() => {
        retry = null;
        if (feed === source) {
          source.close();
          open();
        }
      }, FEED_RETRY_MS);
    };
  }

  const update = (next: NotifySettings): Promise<unknown> => {
    settings = next;
    options.save(settings);
    changed();
    return report();
  };

  open();

  return {
    state: (): NotifyState => ({ settings, device, asks }),
    /** Turns the setting on or off; turning it on asks the browser (call from a click). */
    async setEnabled(enabled: boolean): Promise<void> {
      if (enabled && device === "default") device = await env.requestPermission();
      await update({ ...settings, enabled });
    },
    /** The person's answer to a page's request (call from a click: it may ask the browser). */
    async answer(id: string, allow: boolean): Promise<void> {
      const ask = asks.find((item) => item.id === id);
      if (ask === undefined) return;
      asks = asks.filter((item) => item.id !== id);
      let state: NotifyPermission = allow ? "granted" : "denied";
      if (allow && device === "default") device = await env.requestPermission();
      // The browser said no: the site keeps no answer, so it can ask again once that changes.
      if (allow && device !== "granted") state = "default";
      // The policy first: the gateway grants only what the device's policy backs.
      if (state === "default") {
        changed();
        await report();
      } else
        await update(
          decideSite({ ...settings, enabled: settings.enabled || allow }, ask.origin, state),
        );
      await post({ t: "notify-answer", id, state });
    },
    /** Closes a request without answering: the page hears "default", as when ignored. */
    dismiss(id: string): void {
      if (!asks.some((item) => item.id === id)) return;
      asks = asks.filter((item) => item.id !== id);
      changed();
      void post({ t: "notify-answer", id, state: "default" });
    },
    /** Forgets every site's answer. */
    resetSites(): void {
      void update({ ...settings, origins: {} });
    },
    /** The page came back: the person may have changed the browser's permission meanwhile. */
    recheck(): void {
      if (!refresh()) return;
      changed();
      void report();
    },
    dispose(): void {
      disposed = true;
      if (retry !== null) env.clearTimer(retry);
      feed?.close();
      feed = null;
      for (const handle of shown.values()) if (handle !== "worker") handle.close();
      shown.clear();
    },
  };
}

/** The real browser's side of NotifyEnv. */
export function browserNotifyEnv(): NotifyEnv {
  const api = typeof Notification === "function" ? Notification : undefined;
  const container = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
  let registration: Promise<ServiceWorkerRegistration> | null = null;
  const worker = () =>
    (registration ??= container!
      .register("/notify-sw.js", { scope: "/" })
      .then(() => container!.ready)
      .catch((error: unknown) => {
        registration = null;
        throw error;
      }));
  return {
    permission: () => (api ? api.permission : "unsupported"),
    requestPermission: async () => (api ? await api.requestPermission() : "denied"),
    showPage(title, options, on) {
      if (!api) throw new TypeError("Notification is not available");
      const notification = new api(title, options);
      notification.onshow = () => on("show");
      notification.onclick = (event) => {
        event.preventDefault();
        on("click");
      };
      notification.onclose = () => on("close");
      notification.onerror = () => on("error");
      return { close: () => notification.close() };
    },
    showWorker: container
      ? async (title, options) => {
          await (await worker()).showNotification(title, options);
        }
      : null,
    closeWorker(id) {
      if (!container || registration === null) return;
      void worker()
        .then((ready) => ready.getNotifications())
        .then((list) => {
          for (const notification of list)
            if ((notification.data as { id?: unknown } | null)?.id === id) notification.close();
        })
        .catch(() => undefined);
    },
    focus: () => window.focus(),
    openFeed: (url) => new EventSource(url, { withCredentials: true }) as unknown as FeedSource,
    post: (url, message) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
        credentials: "same-origin",
        keepalive: true,
      }),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
}
