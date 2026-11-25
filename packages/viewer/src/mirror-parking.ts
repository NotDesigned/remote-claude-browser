/**
 * Pages of tabs left behind, kept built but hidden so returning to them is immediate. Their
 * stages never move in the DOM, which would reload their iframes.
 */
import type { TabId } from "@mirror/protocol";
import type { LiveState } from "./mirror-replayer";

export interface ParkedPages {
  /** Whether this page may be kept: canvases and video arrive over WebRTC, which ends with it. */
  canPark(live: LiveState): boolean;
  /** Keeps a page that `canPark` accepted; its WebRTC lane and listeners must already be gone. */
  park(live: LiveState): void;
  /** Takes the tab's page out to be shown again, or undefined. */
  take(tab: TabId): LiveState | undefined;
  /** The tab's page, still parked. */
  peek(tab: TabId): LiveState | undefined;
  drop(tab: TabId): void;
  dropAll(): void;
  /** Lets go of pages of tabs that no longer exist. */
  keep(tabs: readonly TabId[]): void;
  /** The parked stages, which the visible surface must leave in place. */
  stages(): Set<Element>;
}

export function createParkedPages(limit: number, destroy: (live: LiveState) => void): ParkedPages {
  /** Oldest first. */
  const parked = new Map<TabId, LiveState>();
  const drop = (tab: TabId) => {
    const live = parked.get(tab);
    if (live === undefined) return;
    parked.delete(tab);
    destroy(live);
  };
  return {
    canPark(live) {
      if (limit < 1 || live.needsSnapshot) return false;
      try {
        const page = live.replayer.iframe.contentDocument;
        return page !== null && page !== undefined && page.querySelector("canvas,video") === null;
      } catch {
        return false;
      }
    },
    park(live) {
      live.stage.inert = true;
      live.stage.dataset.parked = "true";
      drop(live.tab);
      parked.set(live.tab, live);
      for (const tab of parked.keys()) {
        if (parked.size <= limit) break;
        drop(tab);
      }
    },
    take(tab) {
      const live = parked.get(tab);
      if (live !== undefined) parked.delete(tab);
      return live;
    },
    peek: (tab) => parked.get(tab),
    drop,
    dropAll() {
      for (const tab of [...parked.keys()]) drop(tab);
    },
    keep(tabs) {
      for (const tab of [...parked.keys()]) if (!tabs.includes(tab)) drop(tab);
    },
    stages: () => new Set<Element>([...parked.values()].map((live) => live.stage)),
  };
}
