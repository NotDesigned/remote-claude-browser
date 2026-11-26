/**
 * Website notifications, delivered on the person's own device instead of the remote browser.
 *
 * Chromium's own notifications are blocked by policy (deploy/browser-policies.json): its
 * permission bubble and notification windows sit on a display nobody watches. This replaces the
 * page's Notification API so that its permission is the viewer's answer (relayed by the gateway),
 * requestPermission asks the person in the workbench, and each notification is sent to the
 * gateway, which shows it on the viewer's device and reports back what happened to it.
 *
 * Only top-level documents get this: a cross-origin frame may not ask for notifications anyway.
 * A page's ServiceWorkerRegistration.showNotification is covered here; a service worker's own
 * self.registration.showNotification is not, and stays blocked by the policy. Covering it would
 * mean auto-attaching to service_worker targets (launch.ts attaches pages and frames only) and
 * patching each worker before it runs; it would rarely fire anyway: such notifications mostly
 * answer push messages, and push needs the browser's real permission (blocked) and a push service
 * this Chromium does not have.
 *
 * While the page may notify and nobody is looking at the session, the page also sees itself
 * hidden and unfocused: sites only notify when they are in the background, and the remote tab is
 * otherwise always visible and focused (focus emulation keeps the caret alive).
 */
import type {
  NotifyAgentIn,
  NotifyAgentOut,
  NotifyContent,
  NotifyEventType,
  NotifyPermission,
} from "@mirror/protocol";

/** Chromium's limit, which pages may read. */
const MAX_ACTIONS = 2;

export interface NotificationShim {
  receive(value: unknown): void;
}

interface NotificationState {
  id: number;
  persistent: boolean;
  open: boolean;
  title: string;
  body: string;
  dir: NotificationDirection;
  lang: string;
  tag: string;
  icon: string;
  badge: string;
  image: string;
  data: unknown;
  silent: boolean | null;
  requireInteraction: boolean;
  renotify: boolean;
  timestamp: number;
  actions: readonly NotificationAction[];
  vibrate: readonly number[];
  handlers: Partial<Record<NotifyEventType, unknown>>;
}

type Target = Window & typeof globalThis;
interface NotificationAction {
  action: string;
  title: string;
  icon?: string;
}

export function installNotificationShim(
  target: Target,
  send: (message: NotifyAgentOut) => void,
): NotificationShim {
  const NativeEventTarget = target.EventTarget;
  const NativeEvent = target.Event;
  const nativeAddEventListener = NativeEventTarget.prototype.addEventListener;
  const nativeDispatchEvent = NativeEventTarget.prototype.dispatchEvent;
  const NativeTypeError = target.TypeError;
  const NativePromise = target.Promise;
  const defineProperty = Object.defineProperty;
  const schedule = (callback: () => void) => target.setTimeout(callback, 0);
  const origin = target.location.origin;

  // Functions defined here print like the browser's own, so a page's quick look at
  // Notification.toString() finds nothing unusual.
  const nativeNames = new WeakMap<object, string>();
  const nativeToString = target.Function.prototype.toString;
  const toString = function (this: unknown): string {
    const name = typeof this === "function" ? nativeNames.get(this) : undefined;
    if (name !== undefined) return `function ${name}() { [native code] }`;
    return nativeToString.call(this as () => void);
  };
  nativeNames.set(toString, "toString");
  defineProperty(toString, "name", { value: "toString", configurable: true });
  defineProperty(target.Function.prototype, "toString", {
    value: toString,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  const asNative = <T extends object>(value: T, name: string, length?: number): T => {
    nativeNames.set(value, name);
    defineProperty(value, "name", { value: name, configurable: true });
    if (length !== undefined)
      defineProperty(value, "length", { value: length, configurable: true });
    return value;
  };

  let permission: NotifyPermission = "default";
  let away = false;
  let nextId = 0;
  let nextRequest = 0;
  const states = new WeakMap<object, NotificationState>();
  const shown = new Map<number, object>();
  const requests = new Map<number, (permission: NotifyPermission) => void>();

  const stateOf = (value: unknown): NotificationState => {
    const state = typeof value === "object" && value !== null ? states.get(value) : undefined;
    if (state === undefined) throw new NativeTypeError("Illegal invocation");
    return state;
  };
  const fire = (notification: object, type: NotifyEventType) => {
    const event = new NativeEvent(type, { cancelable: type === "click" });
    nativeDispatchEvent.call(notification as EventTarget, event);
  };

  const resolveIcon = (value: unknown): string => {
    if (value === undefined || value === null || value === "") return "";
    try {
      return new URL(String(value), target.document.baseURI).href;
    } catch {
      return "";
    }
  };

  /** A Notification object the way the constructor and showNotification both make it. */
  function create(
    newTarget: object,
    title: unknown,
    options: unknown,
    persistent: boolean,
    context: string,
  ): object {
    const init = (options ?? {}) as NotificationOptions & {
      renotify?: boolean;
      image?: string;
      timestamp?: number;
      vibrate?: number | number[];
      actions?: NotificationAction[];
    };
    if (typeof init !== "object")
      throw new NativeTypeError(
        `${context}: The provided value is not of type 'NotificationOptions'.`,
      );
    const tag = init.tag === undefined ? "" : String(init.tag);
    const renotify = !!init.renotify;
    if (renotify && tag === "")
      throw new NativeTypeError(
        `${context}: Notifications which set the renotify flag must specify a non-empty tag.`,
      );
    const actions = Array.isArray(init.actions) ? init.actions : [];
    if (!persistent && actions.length > 0)
      throw new NativeTypeError(
        `${context}: Actions are only supported for persistent notifications shown using ServiceWorkerRegistration.showNotification().`,
      );
    let data: unknown = init.data ?? null;
    if (data !== null && typeof target.structuredClone === "function")
      data = target.structuredClone(data);
    const notification = Reflect.construct(NativeEventTarget, [], newTarget as () => void);
    const state: NotificationState = {
      id: 0,
      persistent,
      open: false,
      title: String(title),
      body: init.body === undefined ? "" : String(init.body),
      dir: init.dir === "ltr" || init.dir === "rtl" ? init.dir : "auto",
      lang: init.lang === undefined ? "" : String(init.lang),
      tag,
      icon: resolveIcon(init.icon),
      badge: resolveIcon(init.badge),
      image: resolveIcon(init.image),
      data,
      silent: init.silent === undefined || init.silent === null ? null : !!init.silent,
      requireInteraction: !!init.requireInteraction,
      renotify,
      timestamp: typeof init.timestamp === "number" ? init.timestamp : Date.now(),
      actions: Object.freeze(actions.slice(0, MAX_ACTIONS).map((action) => ({ ...action }))),
      vibrate: Object.freeze(
        Array.isArray(init.vibrate)
          ? init.vibrate.map(Number)
          : init.vibrate
            ? [+init.vibrate]
            : [],
      ),
      handlers: {},
    };
    states.set(notification, state);
    for (const type of ["show", "click", "close", "error"] as const)
      nativeAddEventListener.call(notification, type, (event) => {
        const handler = state.handlers[type];
        if (typeof handler === "function") handler.call(notification, event);
      });
    return notification;
  }

  /** Sends a notification on its way; a notification with the same tag replaces the older one. */
  function show(notification: object): void {
    const state = states.get(notification)!;
    if (state.tag !== "")
      for (const [id, other] of shown) {
        const previous = states.get(other)!;
        if (previous.tag !== state.tag) continue;
        // Replaced, as Chromium does it: quietly, the device replaces it by its tag too.
        previous.open = false;
        shown.delete(id);
      }
    state.id = ++nextId;
    state.open = true;
    shown.set(state.id, notification);
    const content: NotifyContent = { title: state.title, body: state.body };
    if (state.icon !== "") content.icon = state.icon;
    if (state.tag !== "") content.tag = state.tag;
    if (state.silent !== null) content.silent = state.silent;
    if (state.requireInteraction) content.requireInteraction = true;
    if (state.renotify) content.renotify = true;
    send({ op: "show", id: state.id, origin, ...content });
  }

  const Notification = function Notification(this: unknown, title: unknown): object {
    const context = "Failed to construct 'Notification'";
    if (new.target === undefined)
      throw new NativeTypeError(
        `${context}: Please use the 'new' operator, this DOM object constructor cannot be called as a function.`,
      );
    if (arguments.length < 1)
      throw new NativeTypeError(`${context}: 1 argument required, but only 0 present.`);
    // eslint-disable-next-line prefer-rest-params
    const notification = create(new.target, title, arguments[1], false, context);
    if (permission === "granted") show(notification);
    // Without permission Chromium makes the object anyway and reports an error on it.
    else schedule(() => fire(notification, "error"));
    return notification;
  } as unknown as { prototype: object } & ((...args: unknown[]) => object);
  asNative(Notification, "Notification", 1);
  Object.setPrototypeOf(Notification, NativeEventTarget);
  const prototype = Object.create(NativeEventTarget.prototype);
  defineProperty(prototype, "constructor", {
    value: Notification,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  defineProperty(prototype, Symbol.toStringTag, { value: "Notification", configurable: true });
  defineProperty(Notification, "prototype", {
    value: prototype,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  const readOnly: (keyof NotificationState)[] = [
    "title",
    "dir",
    "lang",
    "body",
    "tag",
    "icon",
    "badge",
    "image",
    "data",
    "silent",
    "requireInteraction",
    "renotify",
    "timestamp",
    "actions",
    "vibrate",
  ];
  for (const member of readOnly)
    defineProperty(prototype, member, {
      get: asNative(
        function (this: unknown) {
          return stateOf(this)[member];
        },
        `get ${member}`,
        0,
      ),
      enumerable: true,
      configurable: true,
    });
  for (const type of ["show", "click", "close", "error"] as const)
    defineProperty(prototype, `on${type}`, {
      get: asNative(
        function (this: unknown) {
          return stateOf(this).handlers[type] ?? null;
        },
        `get on${type}`,
        0,
      ),
      set: asNative(
        function (this: unknown, handler: unknown) {
          stateOf(this).handlers[type] =
            typeof handler === "function" || (typeof handler === "object" && handler !== null)
              ? handler
              : null;
        },
        `set on${type}`,
        1,
      ),
      enumerable: true,
      configurable: true,
    });
  defineProperty(prototype, "close", {
    value: asNative(
      function close(this: unknown) {
        const state = stateOf(this);
        if (!state.open) return;
        state.open = false;
        shown.delete(state.id);
        send({ op: "close", id: state.id });
        const notification = this as object;
        schedule(() => fire(notification, "close"));
      },
      "close",
      0,
    ),
    writable: true,
    enumerable: true,
    configurable: true,
  });

  defineProperty(Notification, "permission", {
    get: asNative(() => permission, "get permission", 0),
    enumerable: true,
    configurable: true,
  });
  defineProperty(Notification, "maxActions", {
    get: asNative(() => MAX_ACTIONS, "get maxActions", 0),
    enumerable: true,
    configurable: true,
  });
  defineProperty(Notification, "requestPermission", {
    value: asNative(
      function requestPermission(callback?: unknown) {
        const answered = new NativePromise<NotifyPermission>((resolve) => {
          // Chromium does not ask again once there is an answer.
          if (permission !== "default") {
            resolve(permission);
            return;
          }
          const req = ++nextRequest;
          requests.set(req, resolve);
          send({ op: "ask", req, origin });
        });
        if (typeof callback === "function")
          void answered.then((result) => (callback as (value: NotifyPermission) => void)(result));
        return answered;
      },
      "requestPermission",
      0,
    ),
    writable: true,
    enumerable: true,
    configurable: true,
  });
  defineProperty(target, "Notification", {
    value: Notification,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  // A service worker registration's notifications, shown from the page.
  const registration = target.ServiceWorkerRegistration?.prototype;
  if (registration !== undefined) {
    defineProperty(registration, "showNotification", {
      value: asNative(
        function showNotification(this: unknown, title: unknown, options?: unknown) {
          const context = "Failed to execute 'showNotification' on 'ServiceWorkerRegistration'";
          try {
            if (arguments.length < 1)
              throw new NativeTypeError(`${context}: 1 argument required, but only 0 present.`);
            if (permission !== "granted")
              throw new NativeTypeError(
                `${context}: No notification permission has been granted for this origin.`,
              );
            show(create(Notification, title, options, true, context));
            return NativePromise.resolve(undefined);
          } catch (error) {
            return NativePromise.reject(error);
          }
        },
        "showNotification",
        1,
      ),
      writable: true,
      enumerable: true,
      configurable: true,
    });
    defineProperty(registration, "getNotifications", {
      value: asNative(
        function getNotifications(filter?: { tag?: unknown }) {
          const tag = filter?.tag === undefined ? "" : String(filter.tag);
          const open = [...shown.values()].filter((notification) => {
            const state = states.get(notification)!;
            return state.persistent && (tag === "" || state.tag === tag);
          });
          return NativePromise.resolve(open);
        },
        "getNotifications",
        0,
      ),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  // navigator.permissions.query({ name: "notifications" }) answers with the same state.
  const statuses = new Set<PermissionStatus>();
  const stateGetter = asNative(() => permission, "get state", 0);
  const permissions = target.Permissions?.prototype;
  if (permissions !== undefined && typeof permissions.query === "function") {
    const nativeQuery = permissions.query;
    defineProperty(permissions, "query", {
      value: asNative(
        function query(this: Permissions, descriptor: PermissionDescriptor) {
          // eslint-disable-next-line prefer-rest-params
          const result = nativeQuery.apply(this, arguments as unknown as [PermissionDescriptor]);
          const name = (descriptor as { name?: unknown } | null | undefined)?.name;
          if (name !== "notifications") return result;
          return result.then((status) => {
            defineProperty(status, "state", { get: stateGetter, configurable: true });
            statuses.add(status);
            return status;
          });
        },
        "query",
        1,
      ),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  const visibility = installAwayVisibility(
    target,
    asNative,
    () => away && permission === "granted",
  );

  // After the agent's own hello, which opens the document's stream at the gateway; still before
  // any page script runs.
  void NativePromise.resolve().then(() => send({ op: "hello", origin }));

  return {
    receive(value) {
      const message = value as Partial<
        NotifyAgentIn & {
          permission: NotifyPermission;
          away: boolean;
          answer: number;
          event: number;
          type: NotifyEventType;
        }
      >;
      if (typeof message.event === "number") {
        const notification = shown.get(message.event);
        if (notification === undefined) return;
        const type = message.type;
        if (type === "close" || type === "error") {
          states.get(notification)!.open = false;
          shown.delete(message.event);
        }
        if (type === "show" || type === "click" || type === "close" || type === "error") {
          // A persistent notification's click belongs to its service worker, which is not here.
          if (type === "click" && states.get(notification)!.persistent) return;
          fire(notification, type);
        }
        return;
      }
      const next = message.permission;
      if (next !== "default" && next !== "granted" && next !== "denied") return;
      const before = visibility.awayNow();
      const changed = next !== permission;
      permission = next;
      if (typeof message.away === "boolean") away = message.away;
      if (typeof message.answer === "number") {
        const resolve = requests.get(message.answer);
        requests.delete(message.answer);
        resolve?.(next);
      }
      if (changed)
        for (const status of statuses) nativeDispatchEvent.call(status, new NativeEvent("change"));
      if (visibility.awayNow() !== before) visibility.changed();
    },
  };
}

/**
 * The top document's visibility and focus as the page reads them, hidden while `away()` holds.
 * Returns whether that is in effect, and the way to tell the page it changed.
 */
function installAwayVisibility(
  target: Target,
  asNative: <T extends object>(value: T, name: string, length?: number) => T,
  away: () => boolean,
): { awayNow(): boolean; changed(): void } {
  const document = target.document;
  const documentPrototype = target.Document?.prototype;
  const hiddenDescriptor =
    documentPrototype && Object.getOwnPropertyDescriptor(documentPrototype, "hidden");
  const stateDescriptor =
    documentPrototype && Object.getOwnPropertyDescriptor(documentPrototype, "visibilityState");
  const nativeHasFocus = documentPrototype?.hasFocus;
  const nativeHidden = hiddenDescriptor?.get;
  const nativeState = stateDescriptor?.get;
  if (!documentPrototype || !nativeHidden || !nativeState || typeof nativeHasFocus !== "function")
    return { awayNow: () => false, changed: () => undefined };
  const awayHere = (value: unknown) => value === document && away();
  Object.defineProperty(documentPrototype, "hidden", {
    ...hiddenDescriptor,
    get: asNative(
      function (this: Document) {
        return awayHere(this) || nativeHidden.call(this);
      },
      "get hidden",
      0,
    ),
  });
  Object.defineProperty(documentPrototype, "visibilityState", {
    ...stateDescriptor,
    get: asNative(
      function (this: Document) {
        return awayHere(this) ? "hidden" : nativeState.call(this);
      },
      "get visibilityState",
      0,
    ),
  });
  Object.defineProperty(documentPrototype, "hasFocus", {
    value: asNative(
      function hasFocus(this: Document) {
        return awayHere(this) ? false : nativeHasFocus.call(this);
      },
      "hasFocus",
      0,
    ),
    writable: true,
    enumerable: true,
    configurable: true,
  });
  const nativeDispatchEvent = target.EventTarget.prototype.dispatchEvent;
  const NativeEvent = target.Event;
  const NativeFocusEvent = target.FocusEvent ?? target.Event;
  const toWindow = (event: Event) => {
    try {
      nativeDispatchEvent.call(target, event);
    } catch {
      // Not an event target (tests): the document still hears it.
    }
  };
  return {
    awayNow: () => away(),
    changed() {
      // Already hidden for real: the page heard that from the browser itself.
      if (nativeState.call(document) === "hidden") return;
      const nowAway = away();
      if (nowAway) toWindow(new NativeFocusEvent("blur"));
      nativeDispatchEvent.call(document, new NativeEvent("visibilitychange", { bubbles: true }));
      if (!nowAway) toWindow(new NativeFocusEvent("focus"));
    },
  };
}
