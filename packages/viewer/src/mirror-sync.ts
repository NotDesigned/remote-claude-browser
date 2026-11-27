/**
 * The mirror's stream-order decisions, as pure functions of its sync state.
 *
 * Three flags say how far the page in view can be trusted:
 *  - `snapshotPending` (connection): a snapshot was asked for, or is known to be coming. Deltas
 *    wait for it, and any snapshot for the active tab rebuilds.
 *  - `needsSnapshot` (the page in view): its replay is no longer valid (a gap, a failed event, a
 *    media lane that cannot renegotiate). It takes no input and no deltas until rebuilt.
 *  - `catchUp` (a tab switch back to a page kept in view or parked): the page is shown at once,
 *    and the gateway's answer for the tab says what it missed:
 *
 *        null ──page shown again──▶ waiting ──resync──▶ answered
 *        waiting | answered ──snapshot of the same document──▶ snapshot ──next delta──▶ null
 *        waiting ──no answer within the switch wait──▶ null, and a snapshot is asked for
 *        any ──rebuild, another tab, lost connection, teardown──▶ null
 *
 *    While catching up, a delta that repeats events the page already applied is trimmed to the
 *    new ones, and a snapshot of the same document confirms the page instead of rebuilding it, but
 *    only when it is exactly where the page stands (its seq is the last one the page applied).
 *
 * mirror.ts holds the state and performs the effects; these functions only decide.
 */
import type { Down, eventWithTime, TabId } from "@mirror/protocol";

export type CatchUp = "waiting" | "answered" | "snapshot" | null;

export interface SyncState {
  activeTab: TabId | null;
  snapshotPending: boolean;
  catchUp: CatchUp;
}

/** What the decisions need of the page in view (mirror.ts's LiveState). */
export interface ShownPage {
  tab: TabId;
  epoch: number;
  nextSeq: number;
  needsSnapshot: boolean;
}

type Snapshot = Pick<Extract<Down, { t: "snapshot" }>, "tab" | "epoch" | "seq">;
type Delta = Pick<Extract<Down, { t: "delta" }>, "tab" | "epoch" | "seq" | "data">;

/** A message for a tab other than the active one is not this page's to apply. */
export function concernsActiveTab(sync: Pick<SyncState, "activeTab">, tab: TabId): boolean {
  return sync.activeTab === null || tab === sync.activeTab;
}

export type SnapshotDecision =
  /** Not for the active tab, or the page in view already is this document and is trusted. */
  | "ignore"
  /** The catch-up's snapshot of the document already shown: keep the page, accept the epoch. */
  | "confirm"
  /** Replace the page in view with a new Replayer built from the snapshot. */
  | "rebuild";

export function snapshotDecision(
  sync: SyncState,
  shown: ShownPage | null,
  message: Snapshot,
): SnapshotDecision {
  if (!concernsActiveTab(sync, message.tab)) return "ignore";
  // Only a snapshot of exactly what the page has applied confirms it: one that is further along
  // carries events the page lacks, and confirming it would leave the page as it was when left.
  if (
    sync.catchUp !== null &&
    shown?.tab === message.tab &&
    !shown.needsSnapshot &&
    message.epoch === shown.epoch
  )
    return message.seq + 1 === shown.nextSeq ? "confirm" : "rebuild";
  if (
    shown === null ||
    shown.tab !== message.tab ||
    // Any other epoch is another document: a tab attached again gets a new hub, whose epochs
    // are not ordered after the old one's in any way the viewer knows.
    message.epoch !== shown.epoch ||
    shown.needsSnapshot ||
    sync.snapshotPending
  )
    return "rebuild";
  return "ignore";
}

export type ResyncDecision =
  /** The gateway answered a catch-up: its snapshot or catch-up delta follows. */
  | "catch-up-answered"
  /** A snapshot is on its way for the active tab (adopting it if none is active yet). */
  | "await-snapshot"
  | "ignore";

export function resyncDecision(
  sync: SyncState,
  shown: ShownPage | null,
  tab: TabId,
): ResyncDecision {
  if (sync.catchUp !== null && shown?.tab === tab) return "catch-up-answered";
  return concernsActiveTab(sync, tab) ? "await-snapshot" : "ignore";
}

/** The catch-up state after the gateway's answer. */
export function catchUpAnswered(catchUp: CatchUp): CatchUp {
  return catchUp === "waiting" ? "answered" : catchUp;
}

export type DeltaPlan =
  | { kind: "ignore" }
  /** The page cannot continue from this delta: ask for a snapshot of `tab`. */
  | { kind: "resync"; reason: string }
  /** Nothing is shown yet: adopt the tab, then ask for its snapshot. */
  | { kind: "resync-unshown"; reason: string }
  | { kind: "apply"; seq: number; data: eventWithTime[] };

export interface DeltaOutcome {
  plan: DeltaPlan;
  /** The catch-up state after this delta. */
  catchUp: CatchUp;
}

export function planDelta(sync: SyncState, shown: ShownPage | null, message: Delta): DeltaOutcome {
  let catchUp = sync.catchUp;
  const outcome = (plan: DeltaPlan): DeltaOutcome => ({ plan, catchUp });
  if (!concernsActiveTab(sync, message.tab) || sync.snapshotPending)
    return outcome({ kind: "ignore" });
  if (shown === null) return outcome({ kind: "resync-unshown", reason: "delta before snapshot" });
  if (message.tab !== shown.tab || shown.needsSnapshot) return outcome({ kind: "ignore" });
  if (message.epoch !== shown.epoch)
    return outcome({
      kind: "resync",
      reason: `epoch gap: expected ${shown.epoch}, got ${message.epoch}`,
    });

  // Frozen protocol assumption: delta.seq is the first event's per-tab sequence.
  const expectedSeq = shown.nextSeq;
  let seq = message.seq;
  let data = message.data;
  if (catchUp !== null) {
    // A catch-up repeats the tab's whole buffer, and this page has already applied the start.
    const applied = expectedSeq - seq;
    if (applied > 0) {
      if (applied >= data.length && data.length > 0) return outcome({ kind: "ignore" });
      data = data.slice(applied);
      seq = expectedSeq;
    }
    if (catchUp === "snapshot") catchUp = null;
  }
  if (seq !== expectedSeq || data.length === 0)
    return outcome({
      kind: "resync",
      reason: data.length === 0 ? "empty delta" : `seq gap: expected ${expectedSeq}, got ${seq}`,
    });
  return outcome({ kind: "apply", seq, data });
}
