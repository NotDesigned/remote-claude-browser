/**
 * Differential acceptance for the live tree, with Chromium and the real agent.
 *
 * Every page change a script or the seeded fuzz makes is recorded by the agent; the tree follows
 * the stream. At each checkpoint:
 *  (a) the page's own snapshot of the same document equals the tree (LiveTree.compare);
 *  (b) a Replayer given the stream and a Replayer given the tree's synthesized snapshot build the
 *      same DOM (elements, attributes, form state, shadow roots, frames and every sheet's rules),
 *      written out in a second browser.
 * Where the recorder missed a page change, or the Replayer misplaces a batch the tree places as
 * the page has it, the tree must agree with one of them; those are counted and printed.
 *
 * Run from the repository root:
 *   pnpm -F @mirror/gateway exec tsx src/hub/live-tree.accept.ts
 * LIVE_TREE_SEEDS (default 20) seeds of LIVE_TREE_OPS (default 2000) operations, plus one random
 * seed that is printed; LIVE_TREE_SEED=<n> runs that one seed alone.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";
import {
  eventsOf,
  firstDifference,
  openRecordedTab,
  openReplayHarness,
  sleep,
  startFixtureServer,
  type RecordedTab,
  type ReplayedNode,
  type ReplayHarness,
} from "./live-tree/chromium-harness";
import { LiveTree, SHADOW, TreeBroken, significantMismatches } from "./live-tree/live-tree";
import { synthesizeFresh } from "./live-tree/synthesize";

const chrome = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const SEEDS = Number(process.env.LIVE_TREE_SEEDS ?? 20);
const OPS = Number(process.env.LIVE_TREE_OPS ?? 2000);
const CHECKPOINT_EVERY = Number(process.env.LIVE_TREE_CHECKPOINT ?? 500);

function lastIndexOf(events: readonly eventWithTime[], type: EventType): number {
  for (let index = events.length - 1; index >= 0; index--)
    if (events[index]!.type === type) return index;
  return -1;
}

/** Follows one recorded document as the gateway does, checkpoint after checkpoint. */
class Follower {
  tree: LiveTree | null = null;
  private applied = 0;
  checkpoints = 0;
  /** Where the page's snapshot and the stream disagree, and the tree agrees with the stream. */
  recorderGaps = 0;
  /** Where the Replayer and the page disagree, and the tree agrees with the page. */
  replayerGaps = 0;
  /** TreeBroken kinds met (each then waits for a page snapshot, as the gateway does). */
  readonly broken: string[] = [];
  /** Anomalies of every tree this follower had. */
  readonly anomalies: Record<string, number> = {};

  constructor(
    private readonly tab: RecordedTab,
    private readonly harness: ReplayHarness,
    private readonly label: string,
  ) {}

  /** Applies everything recorded up to `upTo`; a page snapshot seeds the tree again, as in TabHub. */
  private catchUp(events: eventWithTime[], upTo: number): void {
    for (; this.applied < upTo; this.applied++) {
      const event = events[this.applied]!;
      if (event.type === EventType.Meta) continue;
      if (event.type === EventType.FullSnapshot) {
        const meta = lastIndexOf(events.slice(0, this.applied), EventType.Meta);
        assert(meta >= 0, `${this.label}: no Meta`);
        this.tree = LiveTree.seed(events[meta]!, event, { checkInvariants: true });
        continue;
      }
      try {
        this.tree?.apply(event);
      } catch (error) {
        this.dump(events);
        // A broken tree makes the gateway ask the page for a snapshot; so does the next checkpoint.
        if (!(error instanceof TreeBroken)) throw error;
        this.broken.push(error.kind);
        this.tree = null;
      }
    }
  }

  private dump(events: eventWithTime[]): void {
    if (process.env.LIVE_TREE_DUMP)
      writeFileSync(process.env.LIVE_TREE_DUMP, JSON.stringify({ at: this.applied, events }));
  }

  /**
   * Asks the page for a snapshot and checks the tree as it stood just before it. A difference
   * fails only where the tree agrees with neither the page nor a Replayer given the same stream:
   * the recorder misses some page changes (the stream then lacks them for every viewer too), and
   * the Replayer mishandles some batches the tree places as the page has them.
   */
  async checkpoint(): Promise<void> {
    await sleep(400);
    const before = eventsOf(this.tab.messages).length;
    await this.tab.pageSnapshot(800);
    const events = eventsOf(this.tab.messages);
    const fullIndex = events.findIndex(
      (event, index) => index >= before && event.type === EventType.FullSnapshot,
    );
    assert(fullIndex > 0, `${this.label}: no page snapshot`);
    const metaIndex = lastIndexOf(events.slice(0, fullIndex), EventType.Meta);
    this.catchUp(events, metaIndex);
    const tree = this.tree;
    if (tree === null) {
      // Broken since the last checkpoint: start again from this snapshot.
      this.applied = metaIndex;
      this.catchUp(events, events.length);
      return;
    }
    const first = events.findIndex((event) => event.type === EventType.Meta);
    const stream = events.slice(first, metaIndex);
    const checkout = events.slice(metaIndex);
    const label = `${this.label} checkpoint ${this.checkpoints}`;

    // (b) The tree's snapshot against the Replayer given the stream, and the page's own snapshot.
    const synthesized = synthesizeFresh(tree);
    const replayed = await this.harness.replay(stream);
    const fromTree = await this.harness.replay(synthesized.events, synthesized.sheets);
    const differences = differencePaths(replayed, fromTree);
    if (differences.length > 0) {
      // Node by node, the tree's snapshot must agree with the stream's replay or the page's.
      const [stream_, tree_, page_] = [
        await this.harness.inspect(stream, null),
        await this.harness.inspect(synthesized.events, null, synthesized.sheets),
        await this.harness.inspect(checkout, null),
      ];
      const unexplained: string[] = [];
      for (const [id, mine] of Object.entries(tree_)) {
        for (const aspect of aspects(mine)) {
          const value = JSON.stringify(aspect.of(mine));
          if (value === JSON.stringify(aspect.of(stream_[Number(id)] ?? null))) continue;
          if (value === JSON.stringify(aspect.of(page_[Number(id)] ?? null))) continue;
          unexplained.push(
            `${id} ${aspect.name}: tree ${value?.slice(0, 200)} stream ${JSON.stringify(aspect.of(stream_[Number(id)] ?? null))?.slice(0, 200)} page ${JSON.stringify(aspect.of(page_[Number(id)] ?? null))?.slice(0, 200)}`,
          );
        }
      }
      for (const id of Object.keys(page_))
        if (!(id in tree_) && id in stream_) unexplained.push(`${id}: missing from the tree`);
      if (unexplained.length > 0) {
        this.dump(events);
        console.log(
          differences.map(
            (path) =>
              `${path}: ${firstDifference(valueAt(replayed, path), valueAt(fromTree, path))}`,
          ),
        );
      }
      assert.deepEqual(
        unexplained.slice(0, 10),
        [],
        `${label}: the tree's snapshot replays differently from the stream and the page`,
      );
      this.replayerGaps += differences.length;
    }

    // (a) The tree against the page's snapshot, node by node.
    const attach = checkout.filter(
      (event) =>
        event.type === EventType.IncrementalSnapshot &&
        event.data.source === IncrementalSource.Mutation &&
        (event.data as { isAttachIframe?: boolean }).isAttachIframe === true,
    );
    const mismatches = significantMismatches(
      tree.compare(checkout[0]!, checkout[1]!, attach),
    ).filter((mismatch) => mismatch.kind !== "frame-id");
    if (mismatches.length > 0) {
      const replayer = await this.harness.inspect(
        stream,
        mismatches.map((mismatch) => mismatch.id),
      );
      const page = LiveTree.seed(checkout[0]!, checkout[1]!);
      for (const event of attach) page.apply(event);
      const unexplained = mismatches.filter(
        (mismatch) =>
          !agrees(tree, mismatch.id, mismatch.kind, replayer[mismatch.id] ?? null) &&
          carried(stream, page, mismatch.id, mismatch.kind),
      );
      if (unexplained.length > 0) this.dump(events);
      assert.deepEqual(
        unexplained.map((mismatch) =>
          describe(tree, mismatch.id, mismatch.kind, replayer[mismatch.id] ?? null),
        ),
        [],
        `${label}: the tree differs from the page's snapshot and from the stream's replay`,
      );
      this.recorderGaps += mismatches.length;
    }

    for (const [key, value] of Object.entries(tree.anomalies))
      this.anomalies[key] = (this.anomalies[key] ?? 0) + value;
    // As TabHub does with a page snapshot: the tree starts again from it.
    this.applied = metaIndex;
    this.catchUp(events, events.length);
    this.checkpoints += 1;
  }
}

interface Aspect {
  name: string;
  of(node: ReplayedNode | null): unknown;
}

/** What is compared of one replayed node: each attribute, text, children, sheets, form state. */
function aspects(node: ReplayedNode | null): Aspect[] {
  if (node === null) return [];
  const list: Aspect[] = [
    { name: "text", of: (n) => n?.text },
    { name: "children", of: (n) => n?.children },
    { name: "rules", of: (n) => n?.rules },
    { name: "adopted", of: (n) => n?.adopted },
    { name: "value", of: (n) => n?.value },
    { name: "checked", of: (n) => n?.checked },
    { name: "selected", of: (n) => n?.selected },
  ];
  // Form state is compared as the properties above: a Replayer sets those, not attributes.
  for (const name of Object.keys(node.attributes ?? {}).filter(
    (n) => !["value", "checked", "selected"].includes(n),
  ))
    list.push({ name: `attr:${name}`, of: (n) => n?.attributes?.[name] });
  return list;
}

/** Every place two written DOMs differ: a leaf, or a list whose length differs. */
function differencePaths(
  a: unknown,
  b: unknown,
  path: (string | number)[] = [],
  out: string[] = [],
): string[] {
  if (out.length >= 20 || a === b) return out;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    out.push(JSON.stringify(path));
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) {
    out.push(JSON.stringify(path));
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys)
    differencePaths(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      [...path, key],
      out,
    );
  return out;
}

function valueAt(value: unknown, path: string): unknown {
  let current = value;
  for (const key of JSON.parse(path) as string[]) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Whether the Replayer holds for this node what the tree does, in the way `kind` concerns. */
function agrees(tree: LiveTree, id: number, kind: string, replayed: ReplayedNode | null): boolean {
  const node = tree.nodes.get(id);
  if (node === undefined || replayed === null) return false;
  if (kind.startsWith("attr:")) {
    const name = kind.slice(5);
    const mine = node.attributes?.[name];
    const theirs = replayed.attributes?.[name];
    return (mine === undefined ? undefined : String(mine)) === theirs;
  }
  if (kind === "text") return (node.textContent ?? "") === (replayed.text ?? "");
  if (kind === "children" || kind === "shadow-children") {
    const mine = [
      ...(node.childNodes ?? []),
      ...((node as unknown as Record<symbol, TNodeLike[]>)[SHADOW] ?? []),
    ].map((child) => child.id);
    return JSON.stringify(mine) === JSON.stringify(replayed.children.filter((child) => child >= 0));
  }
  return false;
}

/**
 * Whether the stream ever carried the page's value for what `kind` concerns: an attribute value
 * or a text that no event of the stream holds is a change the recorder missed.
 */
function carried(
  stream: readonly eventWithTime[],
  page: LiveTree,
  id: number,
  kind: string,
): boolean {
  const node = page.nodes.get(id);
  if (node === undefined) return true;
  const name = kind.startsWith("attr:") ? kind.slice(5) : null;
  if (name === null && kind !== "text") return true;
  const wanted = name === null ? (node.textContent ?? "") : node.attributes?.[name];
  if (wanted === undefined) return true;
  for (const event of stream) {
    if (
      event.type !== EventType.IncrementalSnapshot ||
      event.data.source !== IncrementalSource.Mutation
    )
      continue;
    const data = event.data as unknown as {
      adds: { node: { id: number; textContent?: string; attributes?: Record<string, unknown> } }[];
      attributes: { id: number; attributes: Record<string, unknown> }[];
      texts: { id: number; value: string }[];
    };
    for (const add of data.adds) {
      if (add.node.id !== id) continue;
      if (name === null ? add.node.textContent === wanted : add.node.attributes?.[name] === wanted)
        return true;
    }
    if (name === null) {
      if (data.texts.some((text) => text.id === id && text.value === wanted)) return true;
    } else if (
      data.attributes.some((change) => change.id === id && change.attributes[name] === wanted)
    )
      return true;
  }
  return false;
}

interface TNodeLike {
  id: number;
}

function describe(tree: LiveTree, id: number, kind: string, replayed: ReplayedNode | null): string {
  const node = tree.nodes.get(id);
  const children = node
    ? [
        ...(node.childNodes ?? []),
        ...((node as unknown as Record<symbol, TNodeLike[]>)[SHADOW] ?? []),
      ].map((child) => child.id)
    : null;
  return `${id} ${kind}: tree ${JSON.stringify({ tag: node?.tagName, attributes: node?.attributes, children })} replayer ${JSON.stringify(replayed)}`;
}

function summary(follower: Follower): string {
  return (
    `recorder gaps ${follower.recorderGaps}, replayer gaps ${follower.replayerGaps}, ` +
    `broken ${JSON.stringify(follower.broken)}, anomalies ${JSON.stringify(follower.anomalies)}`
  );
}

async function scripted(tab: RecordedTab, harness: ReplayHarness, url: string): Promise<string> {
  await tab.navigate(url);
  const follower = new Follower(tab, harness, "long-conversation");
  await follower.checkpoint();
  // Streaming, a CSS-in-JS storm, typing into the composer and scrolling.
  await tab.evaluate("window.__fixture.stream(200, 2)");
  await tab.evaluate("window.__fixture.cssStorm(300)");
  await tab.evaluate(`(() => {
    const view = window.composerView;
    for (const word of ["hello ", "world ", "-- ", "**bold** "]) view.dispatch(view.state.tr.insertText(word));
    window.scrollTo(0, 4000);
  })()`);
  await follower.checkpoint();
  // List reorder, frame navigation and removal, details, adopted sheets changed.
  await tab.evaluate(`(() => {
    const thread = document.getElementById("thread");
    const turns = [...thread.children];
    for (let i = 0; i < 20; i++) thread.insertBefore(turns[turns.length - 1 - i], turns[i * 3]);
    document.getElementById("same-site").src = "/conversation-frame.html?site=again";
    const details = document.createElement("details");
    details.innerHTML = "<summary>s</summary><p>inside</p>";
    thread.append(details);
    details.open = true;
    document.adoptedStyleSheets[0].replaceSync(".turn { opacity: 0.99 }");
  })()`);
  await sleep(500);
  await tab.evaluate(`(() => {
    document.getElementById("cross-site").contentWindow.postMessage({ op: "mutate", n: 5 }, "*");
    const view = window.composerView;
    view.dispatch(view.state.tr.delete(0, view.state.doc.content.size));
  })()`);
  await follower.checkpoint();
  await tab.evaluate(`document.getElementById("same-site").remove()`);
  await follower.checkpoint();
  const stats = follower.tree!.stats();
  return `long-conversation: ${follower.checkpoints} checkpoints, ${stats.nodes} nodes, ${summary(follower)}`;
}

async function fuzz(
  tab: RecordedTab,
  harness: ReplayHarness,
  url: string,
  seed: number,
): Promise<string> {
  await tab.navigate(url);
  const follower = new Follower(tab, harness, `fuzz seed ${seed}`);
  let done = 0;
  for (let step = 0; step < OPS; step += 100) {
    done += await tab.evaluate<number>(`window.__fuzz(${seed * 1000 + step}, 100)`);
    await sleep(5);
    if ((step + 100) % CHECKPOINT_EVERY === 0) await follower.checkpoint();
  }
  if (OPS % CHECKPOINT_EVERY !== 0) await follower.checkpoint();
  return `seed ${seed}: ${done} ops, ${follower.checkpoints} checkpoints, ${summary(follower)}`;
}

async function main(): Promise<void> {
  const server = await startFixtureServer();
  const tab = await openRecordedTab(chrome);
  const harness = await openReplayHarness(chrome);
  try {
    const only = process.env.LIVE_TREE_SEED;
    if (only === undefined) {
      console.log(
        await scripted(tab, harness, `${server.origin}/long?cross=${server.crossOrigin}`),
      );
    }
    const seeds =
      only !== undefined
        ? [Number(only)]
        : [
            ...Array.from({ length: SEEDS }, (_, index) => index + 1),
            Math.floor(Math.random() * 1e6),
          ];
    for (const seed of seeds) {
      console.log(
        await fuzz(tab, harness, `${server.origin}/fuzz?cross=${server.crossOrigin}`, seed),
      );
    }
    console.log(`live tree accept: ${seeds.length} fuzz seeds x ${OPS} ops: no differences`);
  } finally {
    await harness.close();
    await tab.close();
    await server.close();
  }
}

await main();
