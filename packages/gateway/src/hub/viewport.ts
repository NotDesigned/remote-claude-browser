/**
 * Gateway viewport agreement.
 *
 * Driver `view` messages lock input immediately, debounce bursts for 300ms, apply Chromium device
 * metrics, and force a viewport snapshot. Only an acknowledgement of the final viewport epoch
 * unlocks that viewer. Nav/trim/resync epochs never perturb the geometry gate (H3).
 */
import { EventType, type Down, type SnapshotReason, type TabId, type Up } from "@mirror/protocol";
import type { CdpSend } from "../types";
import { screenMetrics } from "../browser/screen-metrics";

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_SNAPSHOT_RETRY_MS = 5_500;
const MAX_VIEWPORT_DIMENSION = 10_000;
const MAX_DPR = 10;

type SnapshotDown = Extract<Down, { t: "snapshot" }>;
type ViewportSnapshot = Pick<SnapshotDown, "tab" | "epoch" | "reason"> &
  Partial<Pick<SnapshotDown, "data">>;
export type ViewportMsg = Extract<Up, { t: "view" } | { t: "view-ack" }>;

export interface ViewportHub {
  viewport: { w: number; h: number; dpr: number } | null;
  epoch?: number;
  pixelZoom?: number;
  pixelGrabbing?: boolean;
  requestSnapshot(reason: SnapshotReason): void;
  hasGeometry?(w: number, h: number): boolean;
}

export interface ViewportAgreementDeps {
  send: CdpSend;
  sessionFor(tabId: TabId): string | undefined;
  hubFor(tabId: TabId): ViewportHub | undefined;
  isDriver(viewerId: string): boolean;
  /** The page lays out as on a phone, following its viewport meta tag. */
  mobile?: boolean;
  /**
   * Tells a viewer its unchanged geometry already holds, so it needs no viewport snapshot. Without
   * this every `view` takes the full negotiation.
   */
  confirmViewport?(viewerId: string, tab: TabId, viewport: { w: number; h: number }): void;
  debounceMs?: number;
  /** Slightly longer than TabHub's default request timeout, then recurring until recovery. */
  snapshotRetryMs?: number;
  now?: () => number;
  gate?: ViewportInputGate;
}

export interface ViewportAgreement {
  readonly gate: ViewportInputGate;
  /** True when a valid message was accepted into the negotiation/gate. */
  handle(viewerId: string, msg: ViewportMsg): boolean;
  /**
   * Call before broadcasting so a same-turn ack sees the new gate state. Returns a replacement
   * reason when a navigation/resync snapshot also completes the pending viewport agreement.
   */
  noteSnapshot(snapshot: ViewportSnapshot): "viewport" | undefined;
  viewportFor(tabId: TabId): { w: number; h: number; dpr: number } | undefined;
  /** Abandon a crashed document's negotiation and require a new viewport agreement. */
  resetTab(tabId: TabId): void;
  removeViewer(viewerId: string): void;
  dispose(): void;
}

/**
 * Input is gated only by geometry-changing viewport snapshots. General hub epochs also advance
 * for navigation and buffer trims; comparing an ack to the hub's current epoch would therefore
 * drop valid input after every routine trim.
 */
export class ViewportInputGate {
  private readonly requiredEpochs = new Map<TabId, number>();
  private readonly pendingTabs = new Set<TabId>();
  private readonly acknowledgedEpochs = new Map<string, Map<TabId, number>>();

  /** Lock at receipt of `view`, covering the debounce/CDP/snapshot transition window. */
  beginViewportChange(tabId: TabId): void {
    this.pendingTabs.add(tabId);
  }

  noteSnapshot(snapshot: Pick<SnapshotDown, "tab" | "epoch" | "reason">): void {
    if (!isViewportReason(snapshot.reason)) return;
    this.requiredEpochs.set(snapshot.tab, snapshot.epoch);
    this.pendingTabs.delete(snapshot.tab);
  }

  acknowledge(viewerId: string, tabId: TabId, epoch: number): boolean {
    if (this.pendingTabs.has(tabId) || this.requiredEpochs.get(tabId) !== epoch) return false;
    let viewerEpochs = this.acknowledgedEpochs.get(viewerId);
    if (viewerEpochs === undefined) {
      viewerEpochs = new Map();
      this.acknowledgedEpochs.set(viewerId, viewerEpochs);
    }
    viewerEpochs.set(tabId, epoch);
    return true;
  }

  /** The tab's current snapshot matches this viewer's unchanged geometry request. */
  confirmGeometry(viewerId: string, tabId: TabId, epoch: number): void {
    this.pendingTabs.delete(tabId);
    if (!this.requiredEpochs.has(tabId)) this.requiredEpochs.set(tabId, epoch);
    this.acknowledge(viewerId, tabId, this.requiredEpochs.get(tabId)!);
  }

  /**
   * A reconnecting viewer whose replay continued in the same hub epoch has already applied the
   * snapshot of the current geometry, so it inherits that agreement without a new negotiation.
   */
  inheritAgreement(viewerId: string, tabId: TabId): boolean {
    const epoch = this.requiredEpochs.get(tabId);
    return epoch !== undefined && this.acknowledge(viewerId, tabId, epoch);
  }

  allowsInput(viewerId: string, tabId: TabId): boolean {
    if (this.pendingTabs.has(tabId)) return false;
    const requiredEpoch = this.requiredEpochs.get(tabId);
    // Unknown tabs have never completed D7 negotiation, so there is no geometry agreement to
    // trust yet. The first viewport snapshot + matching ack is the only initial unlock path.
    return (
      requiredEpoch !== undefined &&
      this.acknowledgedEpochs.get(viewerId)?.get(tabId) === requiredEpoch
    );
  }

  removeViewer(viewerId: string): void {
    this.acknowledgedEpochs.delete(viewerId);
  }
}

interface RequestedViewport {
  revision: number;
  requestedAt: number;
  w: number;
  h: number;
  dpr: number;
}

interface TabNegotiation {
  desired: RequestedViewport;
  lastViewAt: number;
  appliedRevision: number;
  applying: boolean;
  inFlight: boolean;
  geometryRetryUsed: boolean;
  debounceTimer?: ReturnType<typeof setTimeout>;
  snapshotRetryTimer?: ReturnType<typeof setTimeout>;
}

export function createViewportAgreement(deps: ViewportAgreementDeps): ViewportAgreement {
  const debounceMs = checkedDelay("debounceMs", deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const snapshotRetryMs = checkedDelay(
    "snapshotRetryMs",
    deps.snapshotRetryMs ?? DEFAULT_SNAPSHOT_RETRY_MS,
  );
  const now = deps.now ?? Date.now;
  const gate = deps.gate ?? new ViewportInputGate();
  const tabs = new Map<TabId, TabNegotiation>();
  const resetTabs = new Set<TabId>();
  let nextRevision = 0;
  let disposed = false;

  return {
    gate,
    handle(viewerId, msg) {
      if (disposed) return false;
      if (msg.t === "view-ack") return gate.acknowledge(viewerId, msg.tab, msg.epoch);
      if (!deps.isDriver(viewerId) || !isValidViewport(msg)) return false;

      // Only a burst of changes needs debouncing; a lone request applies at once.
      const previous = tabs.get(msg.tab)?.lastViewAt;
      const inBurst = previous !== undefined && now() - previous < debounceMs;
      const desired: RequestedViewport = {
        revision: ++nextRevision,
        requestedAt: inBurst ? now() : now() - debounceMs,
        w: msg.w,
        h: msg.h,
        dpr: msg.dpr,
      };
      const existing = tabs.get(msg.tab);
      const settled =
        !existing ||
        (!existing.applying &&
          !existing.inFlight &&
          existing.debounceTimer === undefined &&
          existing.desired.revision <= existing.appliedRevision);
      const state = existing ?? {
        desired,
        lastViewAt: now(),
        appliedRevision: 0,
        applying: false,
        inFlight: false,
        geometryRetryUsed: false,
      };
      state.desired = desired;
      state.lastViewAt = now();
      tabs.set(msg.tab, state);
      resetTabs.delete(msg.tab);
      if (settled && applyUnchanged(viewerId, msg, state)) return true;
      gate.beginViewportChange(msg.tab);
      scheduleApply(msg.tab, state);
      return true;
    },
    noteSnapshot(snapshot) {
      if (disposed || resetTabs.has(snapshot.tab)) return;
      const viewportSnapshot = isViewportReason(snapshot.reason);
      const state = tabs.get(snapshot.tab);
      if (state === undefined) {
        if (viewportSnapshot) gate.noteSnapshot(snapshot);
        return;
      }
      if (!viewportSnapshot && !state.inFlight) return;

      if (state.desired.revision > state.appliedRevision || state.applying) {
        // This snapshot belongs to an older override. Keep the pending lock and negotiate the
        // newest requested dimensions; acknowledging this epoch must not unlock stale geometry.
        if (viewportSnapshot) {
          state.inFlight = false;
          clearSnapshotRetry(state);
          scheduleApply(snapshot.tab, state);
        }
        return;
      }
      const meta = snapshot.data?.find((event) => event.type === EventType.Meta);
      const matchesGeometry =
        snapshot.data === undefined
          ? deps.hubFor(snapshot.tab)?.hasGeometry?.(state.desired.w, state.desired.h)
          : meta?.type === EventType.Meta &&
            meta.data.width === state.desired.w &&
            meta.data.height === state.desired.h;
      if (matchesGeometry === false) {
        // The recorder can lag Chromium's override: retry once quickly, then at the usual interval.
        if (viewportSnapshot && state.inFlight && !state.geometryRetryUsed) {
          state.geometryRetryUsed = true;
          scheduleSnapshotRetry(snapshot.tab, state, Math.min(debounceMs, snapshotRetryMs));
        }
        return;
      }
      if (!viewportSnapshot && (snapshot.data === undefined || matchesGeometry !== true)) return;
      if (state.inFlight) {
        state.inFlight = false;
        clearSnapshotRetry(state);
      }
      // A matching full snapshot already proves the geometry. Reuse it even when it arrived
      // for navigation/resync, rather than waiting on another command in a loading renderer.
      gate.noteSnapshot({ ...snapshot, reason: "viewport" });
      return "viewport";
    },
    viewportFor(tabId) {
      const viewport = deps.hubFor(tabId)?.viewport;
      return viewport ?? undefined;
    },
    resetTab(tabId) {
      if (disposed) return;
      gate.beginViewportChange(tabId);
      const state = tabs.get(tabId);
      if (state !== undefined) {
        clearDebounce(state);
        clearSnapshotRetry(state);
        tabs.delete(tabId);
      }
      // A snapshot already in transit from the dead document cannot unlock input before the
      // replacement driver has requested its geometry.
      resetTabs.add(tabId);
    },
    removeViewer(viewerId) {
      gate.removeViewer(viewerId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const state of tabs.values()) {
        clearDebounce(state);
        clearSnapshotRetry(state);
      }
      tabs.clear();
      resetTabs.clear();
    },
  };

  /** An unchanged viewport needs no device override, no debounce and no extra full snapshot. */
  function applyUnchanged(
    viewerId: string,
    msg: Extract<ViewportMsg, { t: "view" }>,
    state: TabNegotiation,
  ): boolean {
    const hub = deps.hubFor(msg.tab);
    const applied = hub?.viewport;
    if (!hub || !deps.confirmViewport || !sameViewport(applied, msg)) return false;
    if (hub.hasGeometry?.(msg.w, msg.h)) {
      state.appliedRevision = state.desired.revision;
      gate.confirmGeometry(viewerId, msg.tab, hub.epoch ?? 0);
      deps.confirmViewport(viewerId, msg.tab, { w: msg.w, h: msg.h });
      return true;
    }
    return false;
  }

  function current(tabId: TabId, state: TabNegotiation): boolean {
    return !disposed && tabs.get(tabId) === state;
  }

  function scheduleApply(tabId: TabId, state: TabNegotiation): void {
    if (!current(tabId, state) || state.inFlight || state.applying) return;
    clearDebounce(state);
    const waitMs = Math.max(0, state.desired.requestedAt + debounceMs - now());
    state.debounceTimer = setTimeout(() => {
      if (!current(tabId, state)) return;
      state.debounceTimer = undefined;
      void apply(tabId, state);
    }, waitMs);
    state.debounceTimer.unref?.();
  }

  async function apply(tabId: TabId, state: TabNegotiation): Promise<void> {
    if (!current(tabId, state) || state.inFlight || state.applying) return;
    const desired = state.desired;
    const sessionId = deps.sessionFor(tabId);
    const hub = deps.hubFor(tabId);
    if (sessionId === undefined || hub === undefined) return;

    state.applying = true;
    try {
      // At a browser zoom the window is larger and the page still lays out at the same size.
      const zoom = hub.pixelZoom ?? 1;
      await deps.send(sessionId, "Emulation.setDeviceMetricsOverride", {
        width: Math.round(desired.w * zoom),
        height: Math.round(desired.h * zoom),
        deviceScaleFactor: zoom > 1 || hub.pixelGrabbing ? 1 : desired.dpr,
        mobile: deps.mobile === true && zoom <= 1,
        ...screenMetrics(
          Math.round(desired.w * zoom),
          Math.round(desired.h * zoom),
          deps.mobile === true && zoom <= 1,
        ),
      });
      if (!current(tabId, state)) return;
      hub.viewport = { w: desired.w, h: desired.h, dpr: desired.dpr };
      state.appliedRevision = desired.revision;
      state.inFlight = true;
      state.geometryRetryUsed = false;
      scheduleSnapshotRetry(tabId, state);
      hub.requestSnapshot("viewport");
    } catch {
      if (!current(tabId, state)) return;
      // Keep input locked and retry the latest request. A detached tab simply has no session on
      // the next attempt; a transient CDP failure cannot accidentally reopen stale input.
      if (state.desired.revision === desired.revision) state.desired.requestedAt = now();
    } finally {
      if (current(tabId, state)) {
        state.applying = false;
        if (!state.inFlight) scheduleApply(tabId, state);
      }
    }
  }

  function scheduleSnapshotRetry(
    tabId: TabId,
    state: TabNegotiation,
    delayMs = snapshotRetryMs,
  ): void {
    if (!current(tabId, state)) return;
    clearSnapshotRetry(state);
    state.snapshotRetryTimer = setTimeout(() => {
      if (!current(tabId, state)) return;
      state.snapshotRetryTimer = undefined;
      if (!state.inFlight) return;
      deps.hubFor(tabId)?.requestSnapshot("viewport");
      scheduleSnapshotRetry(tabId, state);
    }, delayMs);
    state.snapshotRetryTimer.unref?.();
  }
}

function sameViewport(
  a: { w: number; h: number; dpr: number } | null | undefined,
  b: { w: number; h: number; dpr: number },
): boolean {
  return !!a && a.w === b.w && a.h === b.h && a.dpr === b.dpr;
}

function clearDebounce(state: TabNegotiation): void {
  if (state.debounceTimer !== undefined) clearTimeout(state.debounceTimer);
  state.debounceTimer = undefined;
}

function clearSnapshotRetry(state: TabNegotiation): void {
  if (state.snapshotRetryTimer !== undefined) clearTimeout(state.snapshotRetryTimer);
  state.snapshotRetryTimer = undefined;
}

function checkedDelay(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function isValidViewport(msg: Extract<ViewportMsg, { t: "view" }>): boolean {
  return (
    Number.isSafeInteger(msg.w) &&
    msg.w > 0 &&
    msg.w <= MAX_VIEWPORT_DIMENSION &&
    Number.isSafeInteger(msg.h) &&
    msg.h > 0 &&
    msg.h <= MAX_VIEWPORT_DIMENSION &&
    Number.isFinite(msg.dpr) &&
    msg.dpr > 0 &&
    msg.dpr <= MAX_DPR
  );
}

function isViewportReason(reason: SnapshotReason | undefined): reason is "viewport" {
  return reason === "viewport";
}
