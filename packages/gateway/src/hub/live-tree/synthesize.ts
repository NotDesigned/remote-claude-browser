/**
 * The live tree written out as an ordinary rrweb snapshot: [Meta, FullSnapshot of the top
 * document (frames without their documents), one attach-iframe Mutation per frame document,
 * outer frames first, then the residual events: sheet edits in order, frame scrolls, canvas
 * pictures, the selection, sticky custom events]. Every timestamp is the last ingested one.
 *
 * Each call builds a fresh object graph, so nothing a viewer is sent shares an object with the
 * tree, which keeps changing. Large stylesheets of the top document travel by hash, as in a page
 * snapshot (snapshot-sheets.ts); frame documents keep theirs inline, as attach events always did.
 */
import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";
import { MIN_EXTERNAL_SHEET_LENGTH, registerSheets, sheetHash } from "../snapshot-sheets";
import { SHEET_REF_ATTRIBUTE, SHEET_REF_TEXT, SHEET_TEXT_ATTRIBUTE } from "@mirror/protocol";
import { LiveTree, NodeKind, PARENT, SHADOW, SHEET_CACHE, type TNode } from "./live-tree";

export interface Synthesized {
  events: eventWithTime[];
  /** Stylesheets the FullSnapshot refers to by hash. */
  sheets: Map<string, string>;
  /** How long it took, for the metrics. */
  ms: number;
}

/** A memo unused this long is let go, so a quiet tab does not keep a second copy of its page. */
export const SYNTH_MEMO_MS = 2_000;
/** A subtree answer larger than this is not worth it: the viewer gets a whole catch-up. */
export const MAX_SUBTREE_BYTES = 256 * 1024;

interface Memo {
  version: number;
  value: Synthesized;
  timer: ReturnType<typeof setTimeout>;
}

const memos = new WeakMap<LiveTree, Memo>();

/** The tree as a snapshot, memoized while its version is unchanged. */
export function synthesize(tree: LiveTree): Synthesized {
  const memo = memos.get(tree);
  if (memo !== undefined && memo.version === tree.version) {
    memo.timer.refresh();
    return memo.value;
  }
  if (memo !== undefined) clearTimeout(memo.timer);
  const value = synthesizeFresh(tree);
  const timer = setTimeout(() => {
    if (memos.get(tree)?.timer === timer) memos.delete(tree);
  }, SYNTH_MEMO_MS);
  timer.unref?.();
  memos.set(tree, { version: tree.version, value, timer });
  return value;
}

/** Drops a memo at once (the tree is being let go). */
export function forgetSynthesized(tree: LiveTree): void {
  const memo = memos.get(tree);
  if (memo !== undefined) clearTimeout(memo.timer);
  memos.delete(tree);
}

export function synthesizeFresh(tree: LiveTree): Synthesized {
  const started = performance.now();
  const timestamp = tree.lastTimestamp;
  const sheets = new Map<string, string>();
  const frames: TNode[] = [];
  const node = writeNode(tree.root, { sheets, frames });
  const meta = {
    type: EventType.Meta,
    timestamp,
    data: { ...tree.meta },
  } as eventWithTime;
  const full = {
    type: EventType.FullSnapshot,
    timestamp,
    data: { node, initialOffset: { ...tree.offset } },
  } as unknown as eventWithTime;
  registerSheets(full, sheets);
  const events: eventWithTime[] = [meta, full];
  const attach = (iframe: TNode) => {
    const doc = tree.frames.get(iframe.id);
    if (doc === undefined) return;
    const nested: TNode[] = [];
    events.push(attachEvent(iframe.id, writeNode(doc, { frames: nested }), timestamp));
    for (const inner of nested) attach(inner);
  };
  for (const iframe of frames) attach(iframe);
  for (const entry of tree.sidecar) events.push(restamp(entry.event, timestamp));
  for (const event of tree.frameScrolls.values()) events.push(restamp(event, timestamp));
  for (const list of tree.canvas.values())
    for (const event of list) events.push(restamp(event, timestamp));
  if (tree.selection !== null) events.push(restamp(tree.selection, timestamp));
  for (const event of tree.sticky.values()) events.push(restamp(event, timestamp));
  return { events, sheets, ms: performance.now() - started };
}

function attachEvent(iframeId: number, doc: unknown, timestamp: number): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp,
    data: {
      source: IncrementalSource.Mutation,
      adds: [{ parentId: iframeId, nextId: null, node: doc }],
      removes: [],
      texts: [],
      attributes: [],
      isAttachIframe: true,
    },
  } as unknown as eventWithTime;
}

/** A shallow copy with the synthesized timestamp; its data is shared, and never written. */
function restamp(event: eventWithTime, timestamp: number): eventWithTime {
  return { ...event, timestamp } as eventWithTime;
}

interface WriteContext {
  /** Collects large stylesheets by hash; absent for frame documents (kept inline). */
  sheets?: Map<string, string>;
  /** Collects the iframes met, in document order. */
  frames: TNode[];
}

type Out = Record<string, unknown>;

/** A fresh copy of `node` and everything under it (not frame documents). */
function writeNode(node: TNode, context: WriteContext): Out {
  const out: Out = {};
  for (const key in node) {
    if (key === "childNodes" || key === "attributes") continue;
    const value = node[key];
    out[key] = value !== null && typeof value === "object" ? structuredClone(value) : value;
  }
  if (node.attributes !== undefined) {
    const attributes: Out = { ...node.attributes };
    const css = attributes[SHEET_TEXT_ATTRIBUTE];
    if (context.sheets && typeof css === "string" && css.length >= MIN_EXTERNAL_SHEET_LENGTH) {
      delete attributes[SHEET_TEXT_ATTRIBUTE];
      attributes[SHEET_REF_ATTRIBUTE] = cachedHash(node, css, context.sheets);
    }
    // A select without options has no value, whatever input last said (the page's snapshot
    // reads select.value, which is then "").
    if (node.tagName === "select" && attributes.value !== undefined && !hasOption(node))
      delete attributes.value;
    out.attributes = attributes;
  }
  if (
    context.sheets &&
    node.isStyle === true &&
    typeof node.textContent === "string" &&
    node.textContent.length >= MIN_EXTERNAL_SHEET_LENGTH
  ) {
    delete out.textContent;
    out[SHEET_REF_TEXT] = cachedHash(node, node.textContent, context.sheets);
  }
  if (node.type === NodeKind.Element && node.tagName === "iframe") context.frames.push(node);
  const shadow = node[SHADOW];
  if (node.childNodes !== undefined || shadow !== undefined) {
    const children: Out[] = [];
    for (const child of node.childNodes ?? []) children.push(writeNode(child, context));
    if (shadow !== undefined && shadow.length > 0) {
      out.isShadowHost = true;
      for (const child of shadow) {
        const written = writeNode(child, context);
        written.isShadow = true;
        children.push(written);
      }
    }
    out.childNodes = children;
  }
  return out;
}

function hasOption(node: TNode): boolean {
  for (const child of node.childNodes ?? []) {
    if (child.type !== NodeKind.Element) continue;
    if (child.tagName === "option" || hasOption(child)) return true;
  }
  return false;
}

function cachedHash(node: TNode, text: string, sheets: Map<string, string>): string {
  let cache = node[SHEET_CACHE];
  if (cache === undefined || cache.text !== text) {
    cache = { text, hash: sheetHash(text) };
    node[SHEET_CACHE] = cache;
  }
  sheets.set(cache.hash, text);
  return cache.hash;
}

/**
 * The current content of node `id` and the way to it: [Meta, a FullSnapshot holding only the
 * node's ancestors (each with its own attributes and the one child on the path) and the node's
 * whole subtree, the attach events of the frames on the path]. A viewer casts it into a hidden
 * replay and takes the node's content from there (editable-patch.ts). Null when the node is
 * unknown, is a document or <html>, holds an iframe or canvas (which a hidden replay cannot carry
 * over), or the answer would be too large; the viewer then gets a whole catch-up.
 */
export function subtreeEvents(tree: LiveTree, id: number): eventWithTime[] | null {
  const target = tree.nodes.get(id);
  if (target === undefined || target.type === NodeKind.Document) return null;
  if (target.type === NodeKind.Element && target.tagName === "html") return null;
  let blocked = false;
  const scan = (node: TNode) => {
    if (blocked) return;
    if (node.type === NodeKind.Element && (node.tagName === "iframe" || node.tagName === "canvas"))
      blocked = true;
    for (const child of node.childNodes ?? []) scan(child);
    for (const child of node[SHADOW] ?? []) scan(child);
  };
  scan(target);
  if (blocked) return null;

  // The path from the top document down: [doc, ..., target], crossing frames.
  const path: TNode[] = [];
  for (let node: TNode | null | undefined = target; node; node = node[PARENT]) path.unshift(node);
  if (path[0] !== tree.root) return null;

  const timestamp = tree.lastTimestamp;
  const documents: { frameId: number | null; node: Out }[] = [];
  let current: { frameId: number | null; node: Out } | null = null;
  let parentOut: Out | null = null;
  for (let index = 0; index < path.length; index++) {
    const node = path[index]!;
    const isTarget = index === path.length - 1;
    let out: Out;
    if (isTarget) out = writeNode(node, { frames: [] });
    else {
      out = {};
      for (const key in node) {
        if (key === "childNodes" || key === "attributes") continue;
        const value = node[key];
        out[key] = value !== null && typeof value === "object" ? structuredClone(value) : value;
      }
      if (node.attributes !== undefined) out.attributes = { ...node.attributes };
      if (node.childNodes !== undefined || node[SHADOW] !== undefined) out.childNodes = [];
      if ((node[SHADOW]?.length ?? 0) > 0) out.isShadowHost = true;
    }
    if (node.type === NodeKind.Document) {
      // The top document, or a frame's document reached through its iframe.
      const frame = node[PARENT];
      current = { frameId: frame ? frame.id : null, node: out };
      documents.push(current);
    } else if (parentOut !== null) {
      if (isInShadow(node)) out.isShadow = true;
      (parentOut.childNodes as Out[]).push(out);
    }
    // An iframe's document is not its child: it travels in an attach event.
    parentOut = node.type === NodeKind.Element && node.tagName === "iframe" ? null : out;
  }
  if (documents.length === 0) return null;
  const events: eventWithTime[] = [
    { type: EventType.Meta, timestamp, data: { ...tree.meta } } as eventWithTime,
    {
      type: EventType.FullSnapshot,
      timestamp,
      data: { node: documents[0]!.node, initialOffset: { ...tree.offset } },
    } as unknown as eventWithTime,
  ];
  for (const doc of documents.slice(1)) events.push(attachEvent(doc.frameId!, doc.node, timestamp));
  if (tree.selection !== null) {
    const ranges = (tree.selection.data as { ranges?: { start: number; end: number }[] }).ranges;
    const inside = (nodeId: number) => {
      for (let node = tree.nodes.get(nodeId); node; node = node[PARENT] ?? undefined)
        if (node === target) return true;
      return false;
    };
    if (ranges?.some((range) => inside(range.start) || inside(range.end)))
      events.push(restamp(tree.selection, timestamp));
  }
  if (JSON.stringify(events).length > MAX_SUBTREE_BYTES) return null;
  return events;
}

function isInShadow(node: TNode): boolean {
  const parent = node[PARENT];
  return parent !== null && parent !== undefined && (parent[SHADOW]?.includes(node) ?? false);
}
