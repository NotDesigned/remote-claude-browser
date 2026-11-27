import {
  EventType,
  IncrementalSource,
  type AgentMsg,
  type Down,
  type eventWithTime,
} from "@mirror/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TreeBudget } from "./live-tree/budget";
import { pageSyncMetrics, resetPageSyncMetrics } from "./live-tree/metrics";
import { TabHub as BaseTabHub, type LiveTreeOptions, type TabHubOpts } from "./tabhub";

const TREE: LiveTreeOptions = {
  ringEvents: 100,
  ringBytes: 1024 * 1024,
  maxNodes: 100_000,
  maxBytes: 64 * 1024 * 1024,
  maxSidecar: 1_000,
  verify: false,
  budget: new TreeBudget(1024 * 1024 * 1024),
};

/** Per-hub epochs from 1, as these tests read them. */
class TabHub extends BaseTabHub {
  constructor(opts: TabHubOpts) {
    let epoch = 0;
    super({ nextEpoch: () => ++epoch, ...opts });
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const DOC = 7;
let clock = 1_000;
const hello = (docId = DOC): AgentMsg => ({
  kind: "hello",
  docId,
  url: "https://x/",
  isTop: true,
  ts: 0,
});
const rrweb = (e: eventWithTime, docId = DOC): AgentMsg => ({
  kind: "rrweb",
  docId,
  e: deepFreeze(e),
});
const meta = (width = 1280): eventWithTime =>
  ({
    type: EventType.Meta,
    timestamp: ++clock,
    data: { href: "https://x/", width, height: 720 },
  }) as eventWithTime;
/** html > body#3 > ul#4 */
function page(extra: Record<string, unknown>[] = []): eventWithTime {
  return {
    type: EventType.FullSnapshot,
    timestamp: ++clock,
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: [
          {
            type: 2,
            id: 2,
            tagName: "html",
            attributes: {},
            childNodes: [
              {
                type: 2,
                id: 3,
                tagName: "body",
                attributes: {},
                childNodes: [{ type: 2, id: 4, tagName: "ul", attributes: {}, childNodes: extra }],
              },
            ],
          },
        ],
      },
      initialOffset: { left: 0, top: 0 },
    },
  } as unknown as eventWithTime;
}
const mutation = (data: Record<string, unknown>): eventWithTime =>
  ({
    type: EventType.IncrementalSnapshot,
    timestamp: ++clock,
    data: {
      source: IncrementalSource.Mutation,
      texts: [],
      attributes: [],
      removes: [],
      adds: [],
      ...data,
    },
  }) as unknown as eventWithTime;
/** Adds li#id with a text, as a streamed reply does; every tenth removes an older one. */
function streamItem(index: number): eventWithTime {
  const id = 1000 + index * 2;
  return mutation({
    adds: [
      {
        parentId: 4,
        nextId: null,
        node: { type: 2, id, tagName: "li", attributes: {}, childNodes: [] },
      },
      {
        parentId: id,
        nextId: null,
        node: { type: 3, id: id + 1, textContent: `token ${index} `.repeat(20) },
      },
    ],
    removes: index % 10 === 9 ? [{ parentId: 4, id: 1000 + (index - 9) * 2 }] : [],
  });
}

function hub(liveTree: LiveTreeOptions | false = TREE, opts: Partial<TabHubOpts> = {}) {
  const tab = new TabHub({ sessionId: "s", tabId: "T1", liveTree, ...opts });
  const needs: string[] = [];
  tab.onNeedSnapshot((reason) => {
    needs.push(reason);
  });
  return { tab, needs };
}

/** A hub with its document's first snapshot in. */
function opened(liveTree: LiveTreeOptions | false = TREE, opts: Partial<TabHubOpts> = {}) {
  const made = hub(liveTree, opts);
  made.tab.ingest(hello());
  made.tab.ingest(rrweb(meta()));
  const downs = made.tab.ingest(rrweb(page()));
  made.needs.length = 0;
  return { ...made, downs };
}

function snapshotOf(downs: Down[]): Extract<Down, { t: "snapshot" }> {
  const found = downs.find((down) => down.t === "snapshot");
  if (found?.t !== "snapshot") throw new Error("no snapshot");
  return found;
}

function liIds(snapshot: Extract<Down, { t: "snapshot" }>): number[] {
  const ul = (
    snapshot.data[1]!.data as unknown as {
      node: { childNodes: { childNodes: { childNodes: { childNodes: { id: number }[] }[] }[] }[] };
    }
  ).node.childNodes[0]!.childNodes[0]!.childNodes[0]!;
  return ul.childNodes.map((child) => child.id);
}

afterEach(() => {
  vi.useRealTimers();
  resetPageSyncMetrics();
});

describe.each([
  ["live tree", TREE],
  ["legacy store", false],
] as const)("TabHub with the %s", (_name, liveTree) => {
  it("opens an epoch with the page's snapshot and streams deltas after it", () => {
    const { tab, downs } = opened(liveTree);
    expect(snapshotOf(downs)).toMatchObject({ epoch: 1, seq: 1, reason: "nav" });
    const [delta] = tab.ingest(rrweb(streamItem(0)));
    expect(delta).toMatchObject({ t: "delta", epoch: 1, seq: 2 });
    expect(tab.canResume(1, 3)).toBe(true);
    expect(tab.joinPayload({ epoch: 1, nextSeq: 2 })).toEqual([
      { t: "delta", tab: "T1", epoch: 1, seq: 2, data: [delta!.t === "delta" && delta.data[0]] },
    ]);
  });

  it(`asks the page for a snapshot after 20 000 deltas only without the tree`, () => {
    const { tab, needs } = opened(liveTree);
    for (let index = 0; index < 20_000; index++) tab.ingest(rrweb(streamItem(index)));
    // Two viewers join and leave.
    const first = tab.joinPayload();
    const second = tab.joinPayload({ epoch: 1, nextSeq: 5 });
    if (liveTree === false) {
      expect(needs).toEqual(["resync"]);
      expect(first).toEqual([{ t: "resync", tab: "T1" }]);
      expect(second).toEqual([{ t: "resync", tab: "T1" }]);
      return;
    }
    expect(needs).toEqual([]);
    const snapshot = snapshotOf(first);
    expect(snapshot).toMatchObject({ epoch: 1, seq: tab.seq, reason: "resync" });
    // The current page: the last nine of each ten items, not the first page snapshot.
    expect(liIds(snapshot).at(-1)).toBe(1000 + 19_999 * 2);
    expect(liIds(snapshot)).toHaveLength(18_000);
    expect(snapshotOf(second)).toMatchObject({ epoch: 1, seq: tab.seq });
    expect(pageSyncMetrics.pageSnapshots.nav).toBe(1);
    expect(
      Object.entries(pageSyncMetrics.pageSnapshots)
        .filter(([cause]) => cause !== "nav")
        .every(([, count]) => count === 0),
    ).toBe(true);
  });
});

describe("TabHub with the live tree", () => {
  it("tails a cursor still in the ring, and synthesizes for one before it", () => {
    const { tab } = opened();
    for (let index = 0; index < 150; index++) tab.ingest(rrweb(streamItem(index)));
    // seq 1 is the snapshot; deltas are 2..151; the ring keeps the last 100: 52..151.
    expect(tab.canResume(1, 51)).toBe(false);
    expect(tab.canResume(1, 52)).toBe(true);
    expect(tab.canResume(1, 152)).toBe(true);
    expect(tab.canResume(1, 153)).toBe(false);
    expect(tab.canResume(2, 100)).toBe(false);
    const tail = tab.joinPayload({ epoch: 1, nextSeq: 52 });
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({ t: "delta", epoch: 1, seq: 52 });
    expect((tail[0] as Extract<Down, { t: "delta" }>).data).toHaveLength(100);
    expect(tab.joinPayload({ epoch: 1, nextSeq: 152 })).toEqual([]);
    const synthesized = tab.joinPayload({ epoch: 1, nextSeq: 51 });
    expect(synthesized[0]).toEqual({ t: "resync", tab: "T1" });
    expect(snapshotOf(synthesized)).toMatchObject({ epoch: 1, seq: 151 });
  });

  it("keeps fences in the epoch across synthesized catch-ups", async () => {
    const { tab } = opened();
    tab.ingest(rrweb(streamItem(0)));
    tab.joinPayload();
    tab.ingest({ kind: "fence", docId: DOC, n: 1, edit: null });
    expect(await tab.whenFenced(1, 10)).toMatchObject({ epoch: 1, seq: 2 });
    expect(snapshotOf(tab.joinPayload())).toMatchObject({ epoch: 1, seq: 2 });
  });

  it("asks the page for a snapshot when its tree breaks, and opens a new epoch with it", () => {
    const { tab, needs } = opened();
    tab.ingest(rrweb(streamItem(0)));
    // Text under a text node: the Replayer would throw.
    const [delta] = tab.ingest(
      rrweb(
        mutation({
          adds: [{ parentId: 1001, nextId: null, node: { type: 3, id: 9, textContent: "x" } }],
        }),
      ),
    );
    expect(delta).toMatchObject({ t: "delta", seq: 3 });
    expect(tab.treeState).toBe("broken");
    expect(needs).toEqual(["resync"]);
    expect(pageSyncMetrics.treeBroken).toEqual({ "non-container": 1 });
    // Deltas still flow to connected viewers; a joining one waits for the page.
    expect(tab.ingest(rrweb(streamItem(1)))).toHaveLength(1);
    expect(tab.joinPayload()).toEqual([{ t: "resync", tab: "T1" }]);
    tab.ingest(rrweb(meta()));
    const downs = tab.ingest(rrweb(page()));
    expect(snapshotOf(downs)).toMatchObject({ epoch: 2, reason: "resync" });
    expect(tab.treeState).toBe("live");
    expect(pageSyncMetrics.pageSnapshots.broken).toBe(1);
  });

  it("swallows a verify snapshot that matches: no message, same epoch and seq", () => {
    const { tab } = opened();
    for (let index = 0; index < 3; index++) tab.ingest(rrweb(streamItem(index)));
    const seq = tab.seq;
    tab.suspect();
    tab.ingest(rrweb(meta()));
    expect(tab.ingest(rrweb(page([...pageItems(0, 3)])))).toEqual([]);
    // The next ordinary event ends the checkout and decides.
    const after = tab.ingest(rrweb(streamItem(3)));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ t: "delta", epoch: 1, seq: seq + 1 });
    expect(pageSyncMetrics.verify).toMatchObject({ match: 1, mismatch: 0 });
    expect(pageSyncMetrics.pageSnapshots.verify).toBe(1);
    expect(snapshotOf(tab.joinPayload())).toMatchObject({ epoch: 1, seq: seq + 1 });
  });

  it("sends a verify snapshot that does not match to every viewer in a new epoch", () => {
    vi.useFakeTimers();
    const { tab } = opened();
    const sent: Down[] = [];
    tab.onDown((down) => sent.push(down));
    for (let index = 0; index < 3; index++) tab.ingest(rrweb(streamItem(index)));
    tab.suspect();
    tab.ingest(rrweb(meta()));
    // The page has an item the tree never heard of.
    tab.ingest(
      rrweb(
        page([
          ...pageItems(0, 3),
          { type: 2, id: 77, tagName: "li", attributes: {}, childNodes: [] },
        ]),
      ),
    );
    vi.advanceTimersByTime(1_000);
    expect(pageSyncMetrics.verify).toMatchObject({ match: 0, mismatch: 1 });
    expect(sent).toHaveLength(1);
    const snapshot = snapshotOf(sent);
    expect(snapshot).toMatchObject({ epoch: 2, seq: tab.seq });
    expect(liIds(snapshot)).toContain(77);
  });

  it("goes dormant over the budget, and asks the page when a viewer needs the tab again", () => {
    const budget = new TreeBudget(64 * 1024);
    const { tab, needs } = opened({ ...TREE, budget });
    const other = opened({ ...TREE, budget });
    tab.setForeground(false);
    for (let index = 0; index < 100; index++) other.tab.ingest(rrweb(streamItem(index)));
    expect(tab.treeState).toBe("live");
    for (let index = 0; index < 300; index++) tab.ingest(rrweb(streamItem(index)));
    expect(tab.treeState).toBe("dormant");
    expect(other.tab.treeState).toBe("live");
    expect(pageSyncMetrics.dormant).toBe(1);
    expect(tab.canResume(1, tab.seq)).toBe(false);
    expect(tab.joinPayload()).toEqual([{ t: "resync", tab: "T1" }]);
    expect(needs).toEqual(["resync"]);
    tab.setForeground(true);
    tab.ingest(rrweb(meta()));
    expect(snapshotOf(tab.ingest(rrweb(page())))).toMatchObject({ epoch: 2 });
    expect(tab.treeState).toBe("live");
    expect(pageSyncMetrics.pageSnapshots.dormant).toBe(1);
  });

  it("drops a tree past its per-tab cap and serves the document from the legacy store", () => {
    const { tab, needs } = opened({ ...TREE, maxNodes: 50 });
    for (let index = 0; index < 300; index++) tab.ingest(rrweb(streamItem(index)));
    expect(tab.treeState).toBe("legacy");
    expect(needs).toEqual(["resync"]);
    tab.ingest(rrweb(meta()));
    const downs = tab.ingest(rrweb(page()));
    expect(snapshotOf(downs)).toMatchObject({ epoch: 2 });
    tab.ingest(rrweb(streamItem(1)));
    // The legacy join: the page's snapshot and the deltas since.
    const join = snapshotOf(tab.joinPayload());
    expect(join.data).toHaveLength(3);
    expect(pageSyncMetrics.fallback).toEqual({ nodes: 1 });
    // A new document gets a tree again.
    tab.ingest(hello(8));
    tab.ingest(rrweb(meta(), 8));
    tab.ingest(rrweb(page(), 8));
    expect(tab.treeState).toBe("live");
  });

  it("treats a lost agent message as a broken tree", () => {
    const { tab, needs } = opened();
    tab.noteStreamLoss();
    expect(tab.treeState).toBe("broken");
    expect(needs).toEqual(["resync"]);
    tab.ingest(rrweb(meta()));
    tab.ingest(rrweb(page()));
    expect(pageSyncMetrics.pageSnapshots["stream-loss"]).toBe(1);
  });

  it("keeps the legacy store for a document that broke twice", () => {
    const { tab } = opened();
    const bad = () =>
      tab.ingest(rrweb(mutation({ attributes: [{ id: 1, attributes: { a: "b" } }] })));
    bad();
    tab.ingest(rrweb(meta()));
    tab.ingest(rrweb(page()));
    expect(tab.treeState).toBe("live");
    bad();
    expect(tab.treeState).toBe("legacy");
    expect(pageSyncMetrics.fallback).toEqual({ "repeat-breaks": 1 });
  });

  it("never holds the page's snapshot, and counts what its page snapshots were for", () => {
    const { tab } = opened();
    expect(tab.snapshot).toBeNull();
    expect(tab.deltas).toEqual([]);
    // The page's own snapshot (a late font, a frame's sync), unasked.
    tab.ingest(rrweb(meta()));
    expect(snapshotOf(tab.ingest(rrweb(page())))).toMatchObject({ epoch: 2, reason: "resync" });
    expect(pageSyncMetrics.pageSnapshots["page-initiated"]).toBe(1);
    expect(pageSyncMetrics.verify.match).toBe(1);
  });
});

function pageItems(from: number, to: number): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (let index = from; index < to; index++) {
    const id = 1000 + index * 2;
    items.push({
      type: 2,
      id,
      tagName: "li",
      attributes: {},
      childNodes: [{ type: 3, id: id + 1, textContent: `token ${index} `.repeat(20) }],
    });
  }
  return items;
}
