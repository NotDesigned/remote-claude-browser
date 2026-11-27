// @vitest-environment node
import type { eventWithTime } from "@mirror/protocol";
import { describe, expect, it } from "vitest";
import {
  catchUpAnswered,
  planDelta,
  resyncDecision,
  snapshotDecision,
  type CatchUp,
  type ShownPage,
  type SyncState,
} from "./mirror-sync";

const sync = (changes: Partial<SyncState> = {}): SyncState => ({
  activeTab: "t1",
  snapshotPending: false,
  catchUp: null,
  ...changes,
});
const shown = (changes: Partial<ShownPage> = {}): ShownPage => ({
  tab: "t1",
  epoch: 3,
  nextSeq: 10,
  needsSnapshot: false,
  ...changes,
});
const events = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ timestamp: index }) as eventWithTime);
const delta = (seq: number, count: number, changes: { tab?: string; epoch?: number } = {}) => ({
  tab: "t1",
  epoch: 3,
  seq,
  data: events(count),
  ...changes,
});

describe("mirror snapshot decisions", () => {
  it("ignores snapshots of other tabs, and adopts any while none is active", () => {
    expect(snapshotDecision(sync(), shown(), { tab: "t2", epoch: 1, seq: 1 })).toBe("ignore");
    expect(snapshotDecision(sync({ activeTab: null }), null, { tab: "t2", epoch: 1, seq: 1 })).toBe(
      "rebuild",
    );
  });

  it("rebuilds whenever the page in view cannot continue", () => {
    expect(snapshotDecision(sync(), null, { tab: "t1", epoch: 3, seq: 9 })).toBe("rebuild");
    expect(snapshotDecision(sync(), shown({ epoch: 2 }), { tab: "t1", epoch: 3, seq: 9 })).toBe(
      "rebuild",
    );
    expect(snapshotDecision(sync(), shown({ tab: "t0" }), { tab: "t1", epoch: 3, seq: 9 })).toBe(
      "rebuild",
    );
    expect(
      snapshotDecision(sync(), shown({ needsSnapshot: true }), { tab: "t1", epoch: 3, seq: 9 }),
    ).toBe("rebuild");
    expect(
      snapshotDecision(sync({ snapshotPending: true }), shown(), { tab: "t1", epoch: 3, seq: 9 }),
    ).toBe("rebuild");
  });

  it("leaves a trusted page of the same document alone", () => {
    expect(snapshotDecision(sync(), shown(), { tab: "t1", epoch: 3, seq: 9 })).toBe("ignore");
  });

  it("confirms the page a catch-up kept, unless its document changed", () => {
    for (const catchUp of ["waiting", "answered", "snapshot"] as const) {
      expect(snapshotDecision(sync({ catchUp }), shown(), { tab: "t1", epoch: 3, seq: 9 })).toBe(
        "confirm",
      );
      expect(snapshotDecision(sync({ catchUp }), shown(), { tab: "t1", epoch: 4, seq: 9 })).toBe(
        "rebuild",
      );
      expect(
        snapshotDecision(sync({ catchUp }), shown({ needsSnapshot: true }), {
          tab: "t1",
          epoch: 3,
          seq: 9,
        }),
      ).toBe("rebuild");
    }
    // Confirming wins over a pending snapshot: the catch-up's snapshot is the one expected.
    expect(
      snapshotDecision(sync({ catchUp: "answered", snapshotPending: true }), shown(), {
        tab: "t1",
        epoch: 3,
        seq: 9,
      }),
    ).toBe("confirm");
  });

  it("rebuilds a kept page the catch-up's snapshot is not exactly level with", () => {
    for (const catchUp of ["waiting", "answered", "snapshot"] as const) {
      // Further along: the page lacks what happened while it was away.
      expect(snapshotDecision(sync({ catchUp }), shown(), { tab: "t1", epoch: 3, seq: 12 })).toBe(
        "rebuild",
      );
      expect(snapshotDecision(sync({ catchUp }), shown(), { tab: "t1", epoch: 3, seq: 4 })).toBe(
        "rebuild",
      );
    }
  });
});

describe("mirror resync decisions", () => {
  it("records the gateway's answer to a catch-up", () => {
    expect(resyncDecision(sync({ catchUp: "waiting" }), shown(), "t1")).toBe("catch-up-answered");
    const steps: CatchUp[] = ["waiting", "answered", "snapshot", null];
    expect(steps.map(catchUpAnswered)).toEqual(["answered", "answered", "snapshot", null]);
  });

  it("otherwise waits for the active tab's snapshot", () => {
    expect(resyncDecision(sync(), shown(), "t1")).toBe("await-snapshot");
    expect(resyncDecision(sync({ catchUp: "waiting" }), shown({ tab: "t0" }), "t1")).toBe(
      "await-snapshot",
    );
    expect(resyncDecision(sync({ activeTab: null }), null, "t9")).toBe("await-snapshot");
    expect(resyncDecision(sync(), shown(), "t2")).toBe("ignore");
  });
});

describe("mirror delta plans", () => {
  it("applies the next deltas in order", () => {
    const { plan, catchUp } = planDelta(sync(), shown(), delta(10, 2));
    expect(plan).toEqual({ kind: "apply", seq: 10, data: events(2) });
    expect(catchUp).toBeNull();
  });

  it("waits while a snapshot is pending, or the page cannot continue", () => {
    expect(planDelta(sync({ snapshotPending: true }), shown(), delta(10, 1)).plan.kind).toBe(
      "ignore",
    );
    expect(planDelta(sync(), shown({ needsSnapshot: true }), delta(10, 1)).plan.kind).toBe(
      "ignore",
    );
    expect(planDelta(sync(), shown(), delta(10, 1, { tab: "t2" })).plan.kind).toBe("ignore");
    expect(planDelta(sync({ activeTab: null }), shown(), delta(10, 1, { tab: "t2" })).plan).toEqual(
      { kind: "ignore" },
    );
  });

  it("asks for a snapshot on a delta it cannot place", () => {
    expect(planDelta(sync(), null, delta(10, 1)).plan).toEqual({
      kind: "resync-unshown",
      reason: "delta before snapshot",
    });
    expect(planDelta(sync(), shown(), delta(10, 1, { epoch: 4 })).plan).toEqual({
      kind: "resync",
      reason: "epoch gap: expected 3, got 4",
    });
    expect(planDelta(sync(), shown(), delta(12, 1)).plan).toEqual({
      kind: "resync",
      reason: "seq gap: expected 10, got 12",
    });
    expect(planDelta(sync(), shown(), delta(8, 4)).plan).toEqual({
      kind: "resync",
      reason: "seq gap: expected 10, got 8",
    });
    expect(planDelta(sync(), shown(), delta(10, 0)).plan).toEqual({
      kind: "resync",
      reason: "empty delta",
    });
  });

  it("trims a catch-up to the events the page has not applied", () => {
    const trimmed = planDelta(sync({ catchUp: "answered" }), shown(), delta(8, 4));
    expect(trimmed.plan).toEqual({ kind: "apply", seq: 10, data: events(4).slice(2) });
    expect(trimmed.catchUp).toBe("answered");
    // Everything already applied: nothing to do, and the catch-up goes on.
    const repeated = planDelta(sync({ catchUp: "snapshot" }), shown(), delta(6, 4));
    expect(repeated).toEqual({ plan: { kind: "ignore" }, catchUp: "snapshot" });
    // A catch-up delta cannot fill a gap either.
    expect(planDelta(sync({ catchUp: "waiting" }), shown(), delta(12, 2)).plan.kind).toBe("resync");
  });

  it("ends a confirmed catch-up with its first delta", () => {
    const first = planDelta(sync({ catchUp: "snapshot" }), shown(), delta(10, 1));
    expect(first).toEqual({ plan: { kind: "apply", seq: 10, data: events(1) }, catchUp: null });
    // Even when that delta then needs a snapshot.
    const gap = planDelta(sync({ catchUp: "snapshot" }), shown(), delta(11, 1));
    expect(gap.catchUp).toBeNull();
    expect(gap.plan.kind).toBe("resync");
  });
});
