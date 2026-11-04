import { EventType, type Down, type TabId } from "@mirror/protocol";

type Snapshot = Extract<Down, { t: "snapshot" }>;

/** Canvas and rrweb must never own the same surface at the same time. */
export function createPresentationState() {
  const modes = new Map<TabId, "dom" | "px">();
  let viewport: { tab: TabId; w: number; h: number; dpr: number } | undefined;
  return {
    observe(message: Down) {
      if (message.t === "mode") modes.set(message.tab, message.mode);
    },
    isPixel(tab: TabId | null) {
      return tab !== null && modes.get(tab) === "px";
    },
    shouldMirror(message: Down, activeTab: TabId | null = null) {
      if (
        (message.t === "snapshot" || message.t === "delta" || message.t === "resync") &&
        activeTab !== null &&
        message.tab !== activeTab
      )
        return false;
      return !(
        (message.t === "snapshot" || message.t === "delta" || message.t === "resync") &&
        modes.get(message.tab) === "px"
      );
    },
    needsViewport(tab: TabId, w: number, h: number, dpr: number) {
      return (
        !viewport ||
        viewport.tab !== tab ||
        viewport.w !== w ||
        viewport.h !== h ||
        viewport.dpr !== dpr
      );
    },
    resetViewport() {
      viewport = undefined;
    },
    /** The last viewport this page negotiated, kept across a resumable reconnect. */
    currentViewport() {
      return viewport === undefined ? undefined : { ...viewport };
    },
    restoreViewport(saved: { tab: TabId; w: number; h: number; dpr: number } | undefined) {
      viewport = saved === undefined ? undefined : { ...saved };
    },
    requested(tab: TabId, w: number, h: number, dpr = 1) {
      viewport = { tab, w, h, dpr };
    },
    matchesViewport(tab: TabId, w: number, h: number) {
      return viewport?.tab === tab && viewport.w === w && viewport.h === h;
    },
    canAcknowledge(snapshot: Snapshot, activeTab: TabId | null, driver: boolean) {
      if (
        !driver ||
        snapshot.reason !== "viewport" ||
        activeTab !== snapshot.tab ||
        viewport?.tab !== snapshot.tab
      )
        return false;
      const meta = snapshot.data.find((event) => event.type === EventType.Meta);
      return (
        meta?.type === EventType.Meta &&
        meta.data.width === viewport.w &&
        meta.data.height === viewport.h
      );
    },
  };
}
