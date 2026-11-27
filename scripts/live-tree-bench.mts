// What the gateway's live tree costs on a heavy page, against the legacy store, on one recorded
// trace of the long-conversation fixture in a real Chromium with the real agent:
//   pnpm bench:live-tree        (node --expose-gc; BENCH_JSON=<file> also writes the numbers)
//
// The trace: a 60 s reply streamed at ~30 tokens a second, then 20 000 more tokens as fast as the
// page can, and a CSS-in-JS storm. Both stores are fed the same agent messages; two viewers join
// after the trace. Reported: apply time per event (mean, p50, p99) and its share of the streamed
// minute, synthesis time (p50, p95, and a memoized repeat), retained heap per tab after GC and
// the tree's own estimate, synthesized and page snapshot bytes, page snapshots by cause, and the
// RSS of four such tabs.
import { writeFileSync } from "node:fs";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { EventType, type AgentMsg } from "../packages/protocol/src/index";
import {
  eventsOf,
  openRecordedTab,
  startFixtureServer,
} from "../packages/gateway/src/hub/live-tree/chromium-harness";
import { TreeBudget } from "../packages/gateway/src/hub/live-tree/budget";
import {
  pageSyncMetrics,
  resetPageSyncMetrics,
} from "../packages/gateway/src/hub/live-tree/metrics";
import { synthesize, synthesizeFresh } from "../packages/gateway/src/hub/live-tree/synthesize";
import { externalizeSheets } from "../packages/gateway/src/hub/snapshot-sheets";
import { TabHub, type LiveTreeOptions } from "../packages/gateway/src/hub/tabhub";

if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Run through scripts/limited-run.sh");
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const chrome =
  process.env.CHROME_PATH ?? process.env.CLAUDE_TEST_CHROME ?? "/usr/bin/google-chrome";
const STREAM_MS = Number(process.env.BENCH_STREAM_MS ?? 60_000);
const FAST_TOKENS = Number(process.env.BENCH_FAST_TOKENS ?? 20_000);

const TREE: LiveTreeOptions = {
  ringEvents: 2_000,
  ringBytes: 2 * 1024 * 1024,
  maxNodes: 400_000,
  maxBytes: 48 * 1024 * 1024,
  maxSidecar: 20_000,
  verify: false,
  budget: new TreeBudget(1024 * 1024 * 1024),
};

const mb = (bytes: number) => Number((bytes / 1048576).toFixed(2));
const round = (value: number, digits = 1) => Number(value.toFixed(digits));
function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}
function heap(): number {
  for (let index = 0; index < 4; index++) gc();
  return process.memoryUsage().heapUsed;
}

// ---- record ----
const server = await startFixtureServer();
const tab = await openRecordedTab(chrome);
let trace: AgentMsg[];
let streamEvents = 0;
let pageSnapshotBytes = 0;
try {
  await tab.navigate(`${server.origin}/long?cross=${server.crossOrigin}`);
  const started = tab.messages.length;
  await tab.evaluate(`window.__fixture.stream(${Math.round(STREAM_MS / 33)}, 33)`);
  streamEvents = tab.messages.length - started;
  await tab.evaluate(`window.__fixture.cssStorm(400)`);
  await tab.evaluate(`window.__fixture.stream(${FAST_TOKENS}, 0)`);
  // The page's own snapshot now, to compare with the tree's at the same point.
  const before = eventsOf(tab.messages).length;
  await tab.pageSnapshot(800);
  const events = eventsOf(tab.messages);
  const full = events.findIndex(
    (event, index) => index >= before && event.type === EventType.FullSnapshot,
  );
  pageSnapshotBytes = JSON.stringify([events[full - 1], externalizeSheets(events[full]!)]).length;
  // The trace ends just before that snapshot.
  let seen = 0;
  const cut = tab.messages.findIndex((message) => message.kind === "rrweb" && seen++ === full - 1);
  trace = tab.messages.slice(0, cut);
} finally {
  await tab.close();
  await server.close();
}
const deltas = trace.filter((message) => message.kind === "rrweb").length;
console.log(`trace: ${trace.length} agent messages, ${deltas} rrweb events`);

// ---- feed ----
function feed(liveTree: LiveTreeOptions | false, label: string) {
  let epoch = 0;
  const hub = new TabHub({ sessionId: "bench", tabId: label, liveTree, nextEpoch: () => ++epoch });
  const needs: string[] = [];
  hub.onNeedSnapshot((reason) => void needs.push(reason));
  const started = performance.now();
  for (const message of trace) hub.ingest(message);
  const ingestMs = performance.now() - started;
  return { hub, needs, ingestMs };
}

resetPageSyncMetrics();
const baseHeap = heap();
const legacy = feed(false, "legacy");
const legacyHeap = heap() - baseHeap;
legacy.hub.joinPayload();
legacy.hub.joinPayload();
const legacyCauses = { ...pageSyncMetrics.pageSnapshots };

resetPageSyncMetrics();
const treeBase = heap();
const live = feed(TREE, "tree");
const treeHeap = heap() - treeBase;
const apply = pageSyncMetrics.apply.summary();
const streamedApplyMs = (apply.mean * Math.min(streamEvents, apply.count)) / 1000;
const join1 = live.hub.joinPayload();
const join2 = live.hub.joinPayload();
const treeCauses = { ...pageSyncMetrics.pageSnapshots };
const stats = live.hub.treeStats();

// ---- synthesis ----
const tree = (live.hub as unknown as { tree: Parameters<typeof synthesizeFresh>[0] }).tree;
const synthTimes: number[] = [];
for (let index = 0; index < 20; index++) synthTimes.push(synthesizeFresh(tree).ms);
synthesize(tree);
const cachedStart = performance.now();
synthesize(tree);
const cachedMs = performance.now() - cachedStart;
const synthesized = synthesizeFresh(tree);
const synthBytes = JSON.stringify(synthesized.events.slice(0, 2)).length;
const synthAllBytes = JSON.stringify(synthesized.events).length;

// ---- four heavy tabs ----
const rssBefore = (gc(), process.memoryUsage().rss);
const four = [1, 2, 3, 4].map((n) => feed(TREE, `tab-${n}`).hub);
gc();
const rssFour = process.memoryUsage().rss - rssBefore;

const result = {
  trace: { messages: trace.length, events: deltas, streamedEvents: streamEvents },
  applyMicros: {
    mean: round(apply.mean, 2),
    p50: round(apply.p50, 2),
    p99: round(apply.p99, 2),
    shareOfStreamedMinute: round((streamedApplyMs / STREAM_MS) * 100, 3),
  },
  ingestMs: { legacy: round(legacy.ingestMs), tree: round(live.ingestMs) },
  synthMs: {
    p50: round(percentile(synthTimes, 0.5)),
    p95: round(percentile(synthTimes, 0.95)),
    cachedRepeat: round(cachedMs, 3),
  },
  memoryMB: {
    legacyRetained: mb(legacyHeap),
    treeRetained: mb(treeHeap),
    treeEstimate: mb(stats.estBytes),
    estimateVsHeap: round(stats.estBytes / Math.max(1, treeHeap), 2),
    pageSnapshotJson: mb(pageSnapshotBytes),
    treeVsSnapshot: round(treeHeap / Math.max(1, pageSnapshotBytes), 2),
    rssFourTabs: mb(rssFour),
  },
  bytes: {
    pageSnapshot: pageSnapshotBytes,
    synthesizedSnapshot: synthBytes,
    synthesizedWithResiduals: synthAllBytes,
    ratio: round(synthBytes / Math.max(1, pageSnapshotBytes), 3),
  },
  tree: { nodes: stats.nodes, sidecar: stats.sidecar, state: stats.state },
  pageSnapshots: { legacy: legacyCauses, tree: treeCauses },
  joins: {
    legacy: legacy.needs,
    tree: [join1, join2].map((payload) => payload.map((down) => down.t).join("+")),
  },
};
console.log(JSON.stringify(result, null, 2));
if (process.env.BENCH_JSON) writeFileSync(process.env.BENCH_JSON, JSON.stringify(result, null, 2));
void four;
