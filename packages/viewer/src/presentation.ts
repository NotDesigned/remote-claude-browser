import {
  encodeResumeCursors,
  type Down,
  type PxQuality,
  type TabId,
  type Up,
} from "@mirror/protocol";
import type { ViewMode } from "./client-session";
import { extractSnapshotViewport, fitViewportScale, type Mirror } from "./mirror";
import { createPxView, type PxView } from "./pxview";
import { videoOption } from "./px-video";
import type { GatewayConnectionState } from "./ws";
import { deepActiveElement, isTextEditable } from "./input/keys";
import { followsFocusByItself } from "./input/focus-follow";

/**
 * Whether a measured size change must wait. Android WebViews (WeChat, QQ, UC, Samsung) shrink
 * the page for the soft keyboard. Reporting that as a new viewport made the stage inert while the
 * remote page re-laid out, which took focus from the field, closed the keyboard, grew the page
 * back and started over. A height-only change while a field here has focus is the keyboard; the
 * mirror just rescales, and the real size is reported once nobody is typing.
 */
export function defersViewport(
  current: { w: number; h: number; dpr: number } | undefined,
  measured: { w: number; h: number; dpr: number },
  editing: boolean,
): boolean {
  return (
    editing &&
    current !== undefined &&
    current.w === measured.w &&
    current.dpr === measured.dpr &&
    current.h !== measured.h
  );
}

/**
 * On a phone, a text field in the mirror, or pixel mode's keyboard textarea, has focus. A desktop
 * has no soft keyboard, and its pixel textarea keeps focus all the time.
 */
function editingIn(host: HTMLElement): boolean {
  if (followsFocusByItself(host.ownerDocument.defaultView)) return false;
  const active = deepActiveElement(host.ownerDocument);
  if (active === null || active === host.ownerDocument.body) return false;
  return (
    isTextEditable(active) && (host.contains(active) || active.ownerDocument !== host.ownerDocument)
  );
}

type Snapshot = Extract<Down, { t: "snapshot" }>;
type Viewport = Extract<Up, { t: "view" }>;
type DomUpdate = Extract<Down, { t: "snapshot" | "delta" | "resync" | "caught-up" | "subtree" }>;

interface PresentationOptions {
  host: HTMLElement;
  mirror: Mirror;
  send(message: Up): void;
  entryTab: TabId | null;
  entryMode: ViewMode | null;
  preferredQuality(): PxQuality;
  onTab(tab: TabId): void;
  onViewMode(mode: ViewMode): void;
  onTabMode(tab: TabId, mode: ViewMode): void;
  onInputReady(ready: boolean): void;
  onPaint(): void;
}

function isDomUpdate(message: Down): message is DomUpdate {
  return (
    message.t === "snapshot" ||
    message.t === "delta" ||
    message.t === "resync" ||
    message.t === "caught-up" ||
    message.t === "subtree"
  );
}

/** One remote tab and one input agreement own the display, independent of the shell UI. */
export function createPresentation(options: PresentationOptions) {
  const { host, mirror, send } = options;
  const modes = new Map<TabId, ViewMode>();
  let { entryMode, entryTab } = options;
  let tab: TabId | null = null;
  let viewerId: string | null = null;
  let driver = false;
  let ready = false;
  let reconnecting = false;
  let viewport: Viewport | undefined;
  let viewportLimit: Extract<Down, { t: "hello" }>["viewportLimit"];
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let activating: { tab: TabId; until: number } | undefined;
  let pixels: PxView | undefined;
  let held: { tab: TabId; updates: DomUpdate[]; timer: ReturnType<typeof setTimeout> } | undefined;
  host.inert = true;
  options.onInputReady(false);

  const modeFor = (target: TabId): ViewMode => modes.get(target) ?? "dom";
  const canInput = (target: TabId, mode: ViewMode) =>
    driver && ready && tab === target && modeFor(target) === mode;

  const inputReady = (value: boolean) => {
    if (value === ready) return;
    ready = value;
    // Making the stage inert takes focus from its field, which closes a phone's keyboard.
    host.inert = !ready && !editingIn(host);
    options.onInputReady(ready);
  };

  const measureViewport = () => {
    const { clientWidth: width, clientHeight: height } = host;
    const dpr = host.ownerDocument.defaultView?.devicePixelRatio || 1;
    if (!viewportLimit || width <= 0 || height <= 0) return { w: width, h: height, dpr };
    const scale = Math.min(
      1,
      fitViewportScale(width, height, viewportLimit.width, viewportLimit.height),
    );
    return {
      w: Math.max(1, Math.round(width * scale)),
      h: Math.max(1, Math.round(height * scale)),
      dpr,
    };
  };
  const viewportMatchesHost = ({ w, h, dpr } = measureViewport()) =>
    viewport?.tab === tab && viewport.w === w && viewport.h === h && viewport.dpr === dpr;

  const reportViewport = () => {
    resizeTimer = undefined;
    if (!driver || tab === null) return;
    const measured = measureViewport();
    if (measured.w <= 0 || measured.h <= 0 || viewportMatchesHost(measured)) return;
    if (viewport?.tab === tab && defersViewport(viewport, measured, editingIn(host))) {
      // Look again later: the keyboard closes, or the person leaves the field.
      scheduleViewport(1_000);
      return;
    }
    inputReady(false);
    viewport = { t: "view", tab, ...measured };
    send(viewport);
  };
  const scheduleViewport = (delay = 0) => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(reportViewport, delay);
  };

  const releaseHeld = (replay: boolean) => {
    if (!held) return;
    const { updates, timer } = held;
    held = undefined;
    clearTimeout(timer);
    if (replay) for (const message of updates) mirror.handle(message);
  };

  const follow = (next: TabId) => {
    if (tab === next) return;
    releaseHeld(true);
    tab = next;
    viewport = undefined;
    inputReady(false);
    options.onTab(next);
    options.onViewMode(modes.get(next) ?? entryMode ?? "dom");
    pixels?.selectTab(next);
    if (mirror.getActiveTab() !== null) mirror.selectTab(next);
    scheduleViewport();
  };

  const activate = (target: TabId) => {
    // A tab list sent before this click can still name the previous tab.
    activating = { tab: target, until: Date.now() + 2_000 };
    follow(target);
    send({ t: "nav", tab: target, action: "activate" });
  };

  const sendMode = (target: TabId, mode: ViewMode, quality: PxQuality) => {
    if (mode === "px") send({ t: "mode", tab: target, mode, quality, ...videoOption() });
    else send({ t: "mode", tab: target, mode });
  };

  const ensurePixels = () => {
    if (pixels) return pixels;
    pixels = createPxView({
      container: host,
      send(message) {
        if (!("tab" in message) || message.tab !== tab) return;
        // Decoder recovery doesn't require an input agreement.
        if (
          driver &&
          modeFor(tab) === "px" &&
          (ready || message.t === "vid-key" || message.t === "mode")
        )
          send(message);
      },
      onEnterPx: () => mirror.teardown(),
      onPaint: options.onPaint,
    });
    if (tab !== null) pixels.selectTab(tab);
    return pixels;
  };

  const matchesViewport = (target: TabId, w: number, h: number) =>
    driver && tab === target && viewport?.tab === target && viewport.w === w && viewport.h === h;

  const snapshotApplied = (snapshot: Snapshot) => {
    if (!driver || snapshot.tab !== tab) return;
    if (snapshot.reason === "viewport") {
      const size = extractSnapshotViewport(snapshot);
      if (!size || !matchesViewport(snapshot.tab, size.w, size.h)) return;
      send({ t: "view-ack", tab: snapshot.tab, epoch: snapshot.epoch });
      inputReady(true);
    } else if (!ready) scheduleViewport();
  };

  return {
    canInput,
    isDriver: () => driver,
    activeTab: () => tab,
    snapshotApplied,
    activate,
    requestMode(mode: ViewMode, quality: PxQuality) {
      if (tab === null) entryMode = mode;
      else {
        releaseHeld(true);
        // Capture can temporarily change the remote page geometry before pixel mode starts.
        if (mode === "px" && modeFor(tab) === "dom")
          held = { tab, updates: [], timer: setTimeout(() => releaseHeld(true), 8_000) };
        sendMode(tab, mode, quality);
      }
      options.onViewMode(mode);
    },
    updateQuality(quality: PxQuality) {
      if (tab !== null && modeFor(tab) === "px") sendMode(tab, "px", quality);
    },
    resized() {
      mirror.refreshViewportLayout();
      scheduleViewport(300);
    },
    resumeParam() {
      if (tab === null || modeFor(tab) === "px") return null;
      const cursor = mirror.resumeCursor();
      return cursor?.tab === tab ? encodeResumeCursors([cursor]) : null;
    },
    connectionChanged(state: GatewayConnectionState, reconnected: boolean) {
      if (state === "open") {
        reconnecting = reconnected;
        return;
      }
      driver = false;
      inputReady(false);
      clearTimeout(resizeTimer);
      if (state !== "closed") return;
      activating = undefined;
      releaseHeld(false);
      if (tab !== null) entryMode ??= modes.get(tab) ?? null;
      if (tab === null || modeFor(tab) !== "px") mirror.connectionLost();
    },
    handle(message: Down) {
      if (isDomUpdate(message)) {
        // Select provisionally when the join snapshot arrives before the tab list.
        if (tab === null && message.t === "snapshot") follow(message.tab);
        if (tab !== null && message.tab !== tab) return;
        if (modeFor(message.tab) === "px") {
          if (message.t === "snapshot") snapshotApplied(message);
        } else if (held?.tab === message.tab) held.updates.push(message);
        else mirror.handle(message);
        return;
      }

      switch (message.t) {
        case "hello": {
          mirror.handle(message);
          viewportLimit = message.viewportLimit;
          const resumed =
            reconnecting &&
            tab !== null &&
            modeFor(tab) === "dom" &&
            message.resumed?.includes(tab) === true;
          if (reconnecting && (tab === null || modeFor(tab) === "dom"))
            mirror.connectionRestored(resumed);
          reconnecting = false;
          viewerId = message.viewerId;
          driver = message.role === "driver";
          if (!resumed || !driver) viewport = undefined;
          inputReady(resumed && driver && viewportMatchesHost());
          scheduleViewport();
          break;
        }
        case "driver": {
          mirror.handle(message);
          const changed = viewerId !== null && viewerId === message.viewerId;
          if (changed === driver) break;
          driver = changed;
          viewport = undefined;
          inputReady(false);
          if (driver) scheduleViewport();
          break;
        }
        case "tabs": {
          mirror.keepTabs(message.tabs.map(({ id }) => id));
          const active = message.tabs.find((candidate) => candidate.active);
          if (!active) break;
          if (activating && active.id !== activating.tab && Date.now() < activating.until) break;
          activating = undefined;
          const requestedTab = message.tabs.find(({ id }) => id === entryTab)?.id ?? active.id;
          const requestedMode = entryMode;
          entryTab = null;
          entryMode = null;
          follow(active.id);
          if (requestedMode !== null) {
            if (requestedTab !== active.id) activate(requestedTab);
            sendMode(requestedTab, requestedMode, options.preferredQuality());
          }
          break;
        }
        case "mode":
          modes.set(message.tab, message.mode);
          if (message.mode === "px") ensurePixels().handle(message);
          else pixels?.handle(message);
          if (held?.tab === message.tab) releaseHeld(message.mode === "dom");
          options.onTabMode(message.tab, message.mode);
          if (message.tab === tab) {
            options.onViewMode(message.mode);
            if (message.mode === "dom") scheduleViewport();
          }
          break;
        case "px":
          send({ t: "px-ack", tab: message.tab });
          // Both frame formats share display ownership inside PxView.
          ensurePixels().handle(message);
          break;
        case "vid":
        case "vid-cfg":
          ensurePixels().handle(message);
          break;
        case "view-ok":
          if (matchesViewport(message.tab, message.w, message.h)) inputReady(true);
          break;
        case "tab-state":
          if (message.tab === tab) {
            inputReady(false);
            if (message.state === "ready") {
              viewport = undefined;
              scheduleViewport();
            }
          }
          break;
        case "rtc-sig":
        case "pong":
          mirror.handle(message);
          break;
      }
    },
    dispose() {
      driver = false;
      inputReady(false);
      clearTimeout(resizeTimer);
      releaseHeld(false);
      pixels?.destroy();
      mirror.teardown();
    },
  };
}
