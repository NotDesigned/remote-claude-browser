/**
 * Pages of tabs left behind, kept built but hidden so returning to them is immediate. Their
 * stages never move in the DOM, which would reload their iframes.
 */
import type { ResumeCursor, TabId } from "@mirror/protocol";
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
  /** Where each parked page's replay stands (what a `held` message lists). */
  cursors(): ResumeCursor[];
}

/**
 * `onChange` hears of every change to the set of parked pages (park, take, drop, keep), with
 * their cursors.
 */
export function createParkedPages(
  limit: number,
  destroy: (live: LiveState) => void,
  onChange?: (cursors: ResumeCursor[]) => void,
): ParkedPages {
  /** Oldest first. */
  const parked = new Map<TabId, LiveState>();
  const cursors = (): ResumeCursor[] =>
    [...parked.values()].map((live) => ({
      tab: live.tab,
      epoch: live.epoch,
      nextSeq: live.nextSeq,
    }));
  const changed = () => onChange?.(cursors());
  const remove = (tab: TabId): boolean => {
    const live = parked.get(tab);
    if (live === undefined) return false;
    parked.delete(tab);
    destroy(live);
    return true;
  };
  const drop = (tab: TabId) => {
    if (remove(tab)) changed();
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
      remove(live.tab);
      parked.set(live.tab, live);
      for (const tab of parked.keys()) {
        if (parked.size <= limit) break;
        remove(tab);
      }
      changed();
    },
    take(tab) {
      const live = parked.get(tab);
      if (live !== undefined) {
        parked.delete(tab);
        changed();
      }
      return live;
    },
    peek: (tab) => parked.get(tab),
    drop,
    dropAll() {
      let any = false;
      for (const tab of [...parked.keys()]) any = remove(tab) || any;
      if (any) changed();
    },
    keep(tabs) {
      let any = false;
      for (const tab of [...parked.keys()]) if (!tabs.includes(tab)) any = remove(tab) || any;
      if (any) changed();
    },
    stages: () => new Set<Element>([...parked.values()].map((live) => live.stage)),
    cursors,
  };
}
