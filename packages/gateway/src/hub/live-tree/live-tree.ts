/**
 * The current DOM of one tab's document, kept by the gateway from its rrweb stream.
 *
 * Seeded from the page's FullSnapshot, it applies each later event the way the viewer's Replayer
 * does, so that at any moment it equals what a viewer that replayed the whole stream holds. From
 * it the gateway serves joins, reconnects, tab switches and one viewer's recovery as an ordinary
 * rrweb FullSnapshot of the current state (synthesize.ts), instead of asking the page for a new
 * snapshot that every viewer would rebuild from.
 *
 * Representation: plain objects shaped like rrweb-snapshot's `serializedNodeWithId`, indexed by
 * id. A shadow root's children are held apart from the host's own (in DOM order each list keeps
 * its own siblings), and an iframe's document hangs off the frame rather than its children, as in
 * the stream, where it is attached by a mutation. Parent links and sizes live on symbol keys,
 * which the synthesizer never copies.
 *
 * Events are immutable after ingest: the fan-out still holds them, so the tree adopts deep copies
 * of every node it takes in and reads only primitives out of the rest.
 *
 * The mutation applier is a port of `Replayer.applyMutation` in @rrweb/replay 2.1.1 (replay.js,
 * around lines 12198-12555 of the patched build here), branch by branch: rrweb is
 * Copyright (c) 2018 Contributors (https://github.com/rrweb-io/rrweb), MIT licensed (see
 * THIRD_PARTY_NOTICES.md). Where the Replayer would throw (and the viewer would rebuild), or where
 * the tree cannot represent what the Replayer does, it throws TreeBroken and the gateway falls
 * back to asking the page.
 */
import {
  EventType,
  IncrementalSource,
  REMOTE_FOCUS_EVENT,
  WORKING_MARK_ANIMATION,
  type eventWithTime,
} from "@mirror/protocol";
import { applyStyleDiff, declarationMap } from "./inline-style";

/** rrweb-snapshot NodeType. */
export const NodeKind = {
  Document: 0,
  DocumentType: 1,
  Element: 2,
  Text: 3,
  CDATA: 4,
  Comment: 5,
} as const;

export const PARENT: unique symbol = Symbol("parent");
export const SHADOW: unique symbol = Symbol("shadow");
const SIZE: unique symbol = Symbol("size");
const IN_SHADOW: unique symbol = Symbol("inShadow");
export const SHEET_CACHE: unique symbol = Symbol("sheetCache");

export type AttributeValue = string | number | boolean;

export interface TNode {
  type: number;
  id: number;
  childNodes?: TNode[];
  tagName?: string;
  attributes?: Record<string, AttributeValue>;
  textContent?: string;
  isStyle?: boolean;
  isShadow?: boolean;
  isShadowHost?: boolean;
  rootId?: number;
  [key: string]: unknown;
  [PARENT]?: TNode | null;
  [SHADOW]?: TNode[];
  [SIZE]?: number;
  [IN_SHADOW]?: boolean;
  [SHEET_CACHE]?: { text: string; hash: string };
}

/** The tree no longer equals what a full replay holds; the gateway asks the page instead. */
export class TreeBroken extends Error {
  constructor(
    readonly kind: string,
    /** This document should use the legacy store from now on, rather than a new tree. */
    readonly fallback = false,
  ) {
    super(`live tree broken: ${kind}`);
    this.name = "TreeBroken";
  }
}

export interface LiveTreeOpts {
  /** More orphaned adds than this in one document is a broken tree. */
  maxOrphans?: number;
  /** Non-sampled canvas commands kept per canvas before the document falls back. */
  maxCanvasCommands?: number;
  /** Check every structural invariant after each mutation (tests and VERIFY). */
  checkInvariants?: boolean;
}

export interface Anomalies {
  /** A change to a node the tree does not have, skipped as the Replayer skips it. */
  unknownTarget: number;
  /** An add whose parent or next sibling never arrived, dropped as the Replayer drops it. */
  orphanAdd: number;
  /** An add of a node the tree already has. */
  move: number;
  /** A removed longhand only a shorthand set; the shorthand was dropped. */
  styleUncertain: number;
  /** rrweb's legacy -1 sibling ids, which the tree does not place. */
  legacy: number;
}

export interface TreeStats {
  nodes: number;
  estBytes: number;
  sidecar: number;
  frames: number;
  version: number;
  anomalies: Anomalies;
}

export interface Mismatch {
  id: number;
  kind: string;
}

interface SideEntry {
  event: eventWithTime;
  /** The style or link element (or document/host for adoptions) whose sheet this changes. */
  owner?: number;
  styleId?: number;
  bytes: number;
}

interface AddedNode {
  parentId: number;
  previousId?: number | null;
  nextId: number | null;
  node: TNode;
}

interface MutationData {
  source: number;
  texts: { id: number; value: string | null }[];
  attributes: { id: number; attributes: Record<string, unknown> }[];
  removes: { parentId: number; id: number; isShadow?: boolean }[];
  adds: AddedNode[];
  isAttachIframe?: true;
}

/** Bytes a node costs beyond its strings: object, map entry, arrays (calibrated by the bench). */
export const NODE_OVERHEAD_BYTES = 200;
/** Ids removed this many ago are forgotten; adds under them are then orphans, not removals. */
const GRAVEYARD_LIMIT = 200_000;

export const STICKY_TAGS: readonly string[] = [REMOTE_FOCUS_EVENT, WORKING_MARK_ANIMATION];

const isContainer = (node: TNode) =>
  node.type === NodeKind.Document || node.type === NodeKind.Element;
const isIframe = (node: TNode) => node.type === NodeKind.Element && node.tagName === "iframe";

function nodeSize(node: TNode): number {
  let size = NODE_OVERHEAD_BYTES;
  if (typeof node.tagName === "string") size += node.tagName.length;
  if (typeof node.textContent === "string") size += node.textContent.length * 2;
  if (node.attributes)
    for (const key in node.attributes) {
      const value = node.attributes[key];
      size += 48 + key.length * 2 + (typeof value === "string" ? value.length * 2 : 8);
    }
  return size;
}

function eventBytes(event: unknown): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 0;
  }
}

export class LiveTree {
  /** Increments on every change to what a synthesized snapshot would contain. */
  version = 0;
  estBytes = 0;
  /** Timestamp of the last event applied; synthesized events all carry it. */
  lastTimestamp = 0;
  readonly anomalies: Anomalies = {
    unknownTarget: 0,
    orphanAdd: 0,
    move: 0,
    styleUncertain: 0,
    legacy: 0,
  };

  readonly nodes = new Map<number, TNode>();
  root!: TNode;
  meta!: { href: string; width: number; height: number };
  offset = { left: 0, top: 0 };
  /** iframe id -> its attached document. */
  readonly frames = new Map<number, TNode>();
  /** Documents added before their iframe (the Replayer's newDocumentQueue), by iframe id. */
  private readonly pendingDocs = new Map<number, AddedNode>();
  sidecar: SideEntry[] = [];
  private sidecarOwners = new Map<number, number>();
  sidecarBytes = 0;
  /** Latest scroll of each frame document. */
  readonly frameScrolls = new Map<number, eventWithTime>();
  /** Per canvas: the latest full sampled frame and the commands after it. */
  readonly canvas = new Map<number, eventWithTime[]>();
  selection: eventWithTime | null = null;
  readonly sticky = new Map<string, eventWithTime>();
  private graveyard = new Set<number>();
  private orphans = 0;
  private readonly maxOrphans: number;
  private readonly maxCanvasCommands: number;
  private readonly checkInvariants: boolean;

  private constructor(opts: LiveTreeOpts) {
    this.maxOrphans = opts.maxOrphans ?? 50;
    this.maxCanvasCommands = opts.maxCanvasCommands ?? 500;
    this.checkInvariants = opts.checkInvariants ?? false;
  }

  /** A tree of the document in `full`, as the page snapshot `meta` + `full` shows it. */
  static seed(meta: eventWithTime, full: eventWithTime, opts: LiveTreeOpts = {}): LiveTree {
    if (meta.type !== EventType.Meta || full.type !== EventType.FullSnapshot)
      throw new TreeBroken("seed");
    const tree = new LiveTree(opts);
    tree.meta = {
      href: String(meta.data.href ?? ""),
      width: Number(meta.data.width) || 0,
      height: Number(meta.data.height) || 0,
    };
    const data = full.data as { node: TNode; initialOffset?: { left: number; top: number } };
    tree.offset = {
      left: Number(data.initialOffset?.left) || 0,
      top: Number(data.initialOffset?.top) || 0,
    };
    tree.root = tree.adopt(data.node, null, false);
    tree.lastTimestamp = Math.max(meta.timestamp, full.timestamp);
    tree.version = 1;
    if (tree.checkInvariants) tree.assertInvariants();
    return tree;
  }

  has(id: number): boolean {
    return this.nodes.has(id);
  }

  stats(): TreeStats {
    return {
      nodes: this.nodes.size,
      estBytes: this.estBytes,
      sidecar: this.sidecar.length,
      frames: this.frames.size,
      version: this.version,
      anomalies: { ...this.anomalies },
    };
  }

  /**
   * Applies one ingested event (never a Meta or FullSnapshot). "ignored" when it changes nothing
   * a snapshot would contain (pointer movement, logs).
   */
  apply(event: eventWithTime): "ok" | "ignored" {
    const result = this.applyEvent(event);
    if (result === "ok") {
      this.version += 1;
      if (Number.isFinite(event.timestamp))
        this.lastTimestamp = Math.max(this.lastTimestamp, event.timestamp);
    }
    return result;
  }

  private applyEvent(event: eventWithTime): "ok" | "ignored" {
    if (event.type === EventType.Custom) {
      const tag = (event.data as { tag?: unknown }).tag;
      if (typeof tag !== "string" || !STICKY_TAGS.includes(tag)) return "ignored";
      const payload = (event.data as { payload?: { id?: unknown } }).payload;
      const key =
        tag === WORKING_MARK_ANIMATION && typeof payload?.id === "number"
          ? `${tag}:${payload.id}`
          : tag;
      this.sticky.delete(key);
      this.sticky.set(key, structuredClone(event));
      return "ok";
    }
    if (event.type !== EventType.IncrementalSnapshot) return "ignored";
    const data = event.data as { source: number } & Record<string, unknown>;
    switch (data.source) {
      case IncrementalSource.Mutation:
        this.applyMutation(data as unknown as MutationData);
        return "ok";
      case IncrementalSource.Scroll:
        return this.applyScroll(event, data as unknown as { id: number; x: number; y: number });
      case IncrementalSource.ViewportResize:
        this.meta.width = Number(data.width) || 0;
        this.meta.height = Number(data.height) || 0;
        return "ok";
      case IncrementalSource.Input:
        return this.applyInput(data as unknown as { id: number; text: string; isChecked: boolean });
      case IncrementalSource.MediaInteraction:
        return this.applyMedia(data);
      case IncrementalSource.StyleSheetRule:
      case IncrementalSource.StyleDeclaration:
      case IncrementalSource.AdoptedStyleSheet:
      case IncrementalSource.Font:
      case IncrementalSource.CustomElement:
        this.addSidecar(event, data);
        return "ok";
      case IncrementalSource.CanvasMutation:
        return this.applyCanvas(event, data);
      case IncrementalSource.Selection:
        this.selection = structuredClone(event);
        return "ok";
      default:
        // MouseMove, MouseInteraction, TouchMove, Drag, Log: nothing a page snapshot holds.
        return "ignored";
    }
  }

  // ---- mutations (replay.js applyMutation) ----

  private applyMutation(d: MutationData): void {
    const removedNow = new Set<number>();
    // replay.js ~12218: removes whose node is unknown are skipped (warnNodeNotFound).
    for (const mutation of d.removes ?? []) {
      const target = this.nodes.get(mutation.id);
      if (target === undefined) {
        if (!this.graveyard.has(mutation.id)) this.anomalies.unknownTarget += 1;
        continue;
      }
      // ~12233: an unknown parent leaves the node where it is, still mapped.
      const parent = this.nodes.get(mutation.parentId);
      if (parent === undefined) {
        this.anomalies.unknownTarget += 1;
        continue;
      }
      // ~12240: parent.removeChild throws (and is only warned about) for a node elsewhere; the
      // Replayer has already unmapped it, which the tree cannot represent.
      if (target[PARENT] !== parent) throw new TreeBroken("remove-parent");
      this.contentChanged(parent);
      this.detach(target);
      this.drop(target, removedNow);
    }

    // ~12260: adds, with the queue for parents and next siblings that arrive later.
    let queue: AddedNode[] = [];
    let placed = 0;
    const appendNode = (mutation: AddedNode) => {
      const parent = this.nodes.get(mutation.parentId);
      if (parent === undefined) {
        if (mutation.node.type === NodeKind.Document) {
          this.pendingDocs.set(mutation.parentId, cloneAdded(mutation));
          return;
        }
        queue.push(mutation);
        return;
      }
      if (!isContainer(parent)) throw new TreeBroken("non-container");
      const shadow = mutation.node.isShadow === true;
      // ~12293: nextNotInDOM
      const next = mutation.nextId ? this.nodes.get(mutation.nextId) : undefined;
      if (
        mutation.nextId !== null &&
        mutation.nextId !== undefined &&
        mutation.nextId !== -1 &&
        next === undefined
      ) {
        queue.push(mutation);
        return;
      }
      // ~12296: a node whose document is unknown is dropped silently.
      if (mutation.node.rootId && !this.nodes.has(mutation.node.rootId)) {
        this.orphan(1);
        return;
      }
      // ~12299: a document added under an iframe is that frame's new document.
      if (isIframe(parent)) {
        this.attachDocument(parent, mutation.node);
        placed += 1;
        return;
      }
      if (mutation.previousId === -1 || mutation.nextId === -1) {
        this.anomalies.legacy += 1;
        return;
      }
      let target = this.nodes.get(mutation.node.id);
      if (target !== undefined) {
        // An id the tree has: the Replayer would build a second element under it. The page moved
        // it; take it from where it was.
        this.anomalies.move += 1;
        for (let up: TNode | null | undefined = parent; up; up = up[PARENT])
          if (up === target) throw new TreeBroken("cycle");
        this.detach(target);
        this.contentChanged(target[PARENT] ?? undefined);
        refreshFields(target, mutation.node);
      } else {
        target = this.adopt(mutation.node, null, shadow);
      }
      if (shadow) parent.isShadowHost = true;
      const list = childList(parent, shadow);
      // ~12328: special cases for text under textarea and style, and doctype/html in documents.
      if (parent.type === NodeKind.Element && target.type === NodeKind.Text) {
        if (parent.tagName === "textarea") {
          for (const child of [...list])
            if (child.type === NodeKind.Text) {
              this.detach(child);
              this.drop(child, removedNow);
            }
        } else if (parent.tagName === "style") {
          this.materializeStyle(parent, target);
        }
      } else if (parent.type === NodeKind.Document) {
        if (target.type === NodeKind.DocumentType && list[0]?.type === NodeKind.DocumentType) {
          const old = list[0];
          this.detach(old);
          this.drop(old, removedNow);
        }
        if (target.type === NodeKind.Element && target.tagName === "html") {
          const html = list.find(
            (child) => child.type === NodeKind.Element && child.tagName === "html",
          );
          if (html !== undefined) {
            this.detach(html);
            this.drop(html, removedNow);
          }
        }
      }
      // ~12352: placement.
      const previous = mutation.previousId ? this.nodes.get(mutation.previousId) : undefined;
      const afterPrevious = previous === undefined ? undefined : nextSibling(previous);
      if (afterPrevious !== undefined) {
        if (afterPrevious[PARENT] !== parent || (afterPrevious[IN_SHADOW] ?? false) !== shadow)
          throw new TreeBroken("insert");
        this.insertBefore(parent, shadow, target, afterPrevious);
      } else if (next !== undefined && next[PARENT] != null) {
        if (next[PARENT] === parent && (next[IN_SHADOW] ?? false) === shadow)
          this.insertBefore(parent, shadow, target, next);
        else if (containsInScope(parent, shadow, next)) throw new TreeBroken("insert");
        else this.insertBefore(parent, shadow, target, undefined);
      } else {
        this.insertBefore(parent, shadow, target, undefined);
      }
      placed += 1;
      if (parent.type === NodeKind.Element && parent.tagName === "style") this.prune(parent.id);
      // ~12367: an iframe whose document arrived first.
      if (isIframe(target)) {
        const waiting = this.pendingDocs.get(target.id);
        if (waiting !== undefined) {
          this.pendingDocs.delete(target.id);
          this.attachDocument(target, waiting.node);
        }
      }
    };

    for (const mutation of d.adds ?? []) appendNode(mutation);
    // ~12392: resolve trees while that places anything (the Replayer gives up after 500 ms).
    while (queue.length > 0) {
      const current = queue;
      queue = [];
      const before = placed;
      for (const tree of queueToResolveTrees(current)) {
        if (!this.nodes.has(tree.value.parentId)) {
          this.orphan(countTree(tree), [tree.value], removedNow);
          continue;
        }
        iterateResolveTree(tree, appendNode);
      }
      if (placed === before && queue.length > 0) {
        this.orphan(queue.length, queue, removedNow);
        break;
      }
    }

    // ~12420: texts, the last value per node.
    const seen = new Set<number>();
    for (let index = (d.texts ?? []).length - 1; index >= 0; index--) {
      const mutation = d.texts[index]!;
      if (seen.has(mutation.id)) continue;
      seen.add(mutation.id);
      const target = this.nodes.get(mutation.id);
      if (target === undefined) {
        if (!removedNow.has(mutation.id) && !this.graveyard.has(mutation.id))
          this.anomalies.unknownTarget += 1;
        continue;
      }
      if (isContainer(target)) throw new TreeBroken("text-on-container");
      const parent = target[PARENT];
      if (parent?.type === NodeKind.Element && parent.tagName === "style") {
        this.materializeStyle(parent);
        this.prune(parent.id);
      }
      this.estBytes -= target[SIZE] ?? 0;
      target.textContent = mutation.value ?? "";
      target[SIZE] = nodeSize(target);
      this.estBytes += target[SIZE];
    }

    // ~12440: attributes.
    for (const mutation of d.attributes ?? []) {
      const target = this.nodes.get(mutation.id);
      if (target === undefined) {
        if (!removedNow.has(mutation.id) && !this.graveyard.has(mutation.id))
          this.anomalies.unknownTarget += 1;
        continue;
      }
      if (target.type !== NodeKind.Element) throw new TreeBroken("attribute-on-non-element");
      this.estBytes -= target[SIZE] ?? 0;
      const attributes = (target.attributes ??= {});
      for (const name in mutation.attributes) {
        const value = mutation.attributes[name];
        if (value === null) {
          delete attributes[name];
        } else if (typeof value === "string") {
          if (name === "_cssText" && (target.tagName === "link" || target.tagName === "style")) {
            // ~12462: the Replayer builds the element again from its new text: its children go.
            for (const child of [...(target.childNodes ?? [])]) {
              this.detach(child);
              this.drop(child, removedNow);
            }
            this.prune(target.id);
            attributes[name] = value;
          } else if (name === "value" && target.tagName === "textarea") {
            // ~12497: the text becomes the textarea's only (unmapped) child.
            for (const child of [...(target.childNodes ?? [])]) {
              this.detach(child);
              this.drop(child, removedNow);
            }
            attributes[name] = value;
          } else {
            attributes[name] = value;
          }
        } else if (name === "style" && typeof value === "object") {
          const current = typeof attributes.style === "string" ? attributes.style : "";
          const result = applyStyleDiff(current, value as Record<string, unknown>);
          if (result.uncertain) this.anomalies.styleUncertain += 1;
          if (result.value === "") delete attributes.style;
          else attributes.style = result.value;
        }
      }
      target[SIZE] = nodeSize(target);
      this.estBytes += target[SIZE];
    }
    if (this.checkInvariants) this.assertInvariants();
  }

  /** ~replay.js attachDocumentToIframe: the frame's document, replacing any it had. */
  private attachDocument(iframe: TNode, node: TNode): void {
    const old = this.frames.get(iframe.id);
    if (old !== undefined) {
      this.frames.delete(iframe.id);
      this.drop(old);
    }
    // A frame the page moved keeps its document's id (the patched Replayer forgets the stale one).
    const stale = this.nodes.get(node.id);
    if (stale !== undefined) {
      this.detach(stale);
      this.drop(stale);
    }
    const doc = this.adopt(node, iframe, false);
    this.frames.set(iframe.id, doc);
    // Frames inside it whose documents arrived first.
    const visit = (current: TNode) => {
      if (isIframe(current)) {
        const waiting = this.pendingDocs.get(current.id);
        if (waiting !== undefined) {
          this.pendingDocs.delete(current.id);
          this.attachDocument(current, waiting.node);
        }
      }
      for (const child of current.childNodes ?? []) visit(child);
      for (const child of current[SHADOW] ?? []) visit(child);
    };
    visit(doc);
  }

  /**
   * A style element built from `_cssText` holds the text in children the snapshot left empty;
   * before its children change, give each its part of that text, as the Replayer's DOM has it.
   * `adding` is a text child about to be added to a style with no children (~12340: it takes the
   * element's unmapped text).
   */
  private materializeStyle(style: TNode, adding?: TNode): void {
    const css = style.attributes?._cssText;
    if (typeof css !== "string") return;
    const texts = (style.childNodes ?? []).filter((child) => child.type === NodeKind.Text);
    this.estBytes -= style[SIZE] ?? 0;
    delete style.attributes!._cssText;
    style[SIZE] = nodeSize(style);
    this.estBytes += style[SIZE];
    if (texts.length === 0) {
      if (adding !== undefined) this.setText(adding, css);
      return;
    }
    const splits = css.split("/* rr_split */");
    while (splits.length > 1 && splits.length > texts.length)
      splits.splice(-2, 2, splits.slice(-2).join(""));
    texts.forEach((text, index) => this.setText(text, splits[index] ?? ""));
  }

  private setText(node: TNode, text: string): void {
    this.estBytes -= node[SIZE] ?? 0;
    node.textContent = text;
    node[SIZE] = nodeSize(node);
    this.estBytes += node[SIZE];
  }

  private orphan(count: number, mutations?: AddedNode[], removedNow?: Set<number>): void {
    // Adds under a node that was removed are what the page meant: nothing to show.
    if (mutations !== undefined) {
      const underRemoved = mutations.every(
        (mutation) =>
          removedNow?.has(mutation.parentId) === true || this.graveyard.has(mutation.parentId),
      );
      if (underRemoved) return;
    }
    this.anomalies.orphanAdd += count;
    this.orphans += count;
    if (this.orphans > this.maxOrphans) throw new TreeBroken("orphans");
  }

  /** Deep-copies `source` into the tree under `parent`, indexing it. */
  private adopt(source: TNode, parent: TNode | null, inShadow: boolean): TNode {
    if (typeof source !== "object" || source === null || !Number.isSafeInteger(source.id))
      throw new TreeBroken("malformed-node");
    const node: TNode = { type: source.type, id: source.id };
    for (const key of Object.keys(source)) {
      if (key === "childNodes" || key === "attributes" || key === "type" || key === "id") continue;
      const value = source[key];
      if (value !== null && typeof value === "object") node[key] = structuredClone(value);
      else node[key] = value;
    }
    if (source.attributes !== undefined) {
      const attributes: Record<string, AttributeValue> = {};
      for (const key of Object.keys(source.attributes)) {
        const value = source.attributes[key];
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
          attributes[key] = value;
      }
      node.attributes = attributes;
    }
    node[PARENT] = parent;
    node[IN_SHADOW] = inShadow;
    if (this.nodes.has(node.id)) throw new TreeBroken("duplicate-id");
    this.nodes.set(node.id, node);
    this.graveyard.delete(node.id);
    node[SIZE] = nodeSize(node);
    this.estBytes += node[SIZE];
    if (source.childNodes !== undefined || isContainer(node)) {
      node.childNodes = [];
      for (const child of source.childNodes ?? []) {
        const shadow = child.isShadow === true;
        const adopted = this.adopt(child, node, shadow);
        if (shadow) (node[SHADOW] ??= []).push(adopted);
        else node.childNodes.push(adopted);
      }
    }
    return node;
  }

  private insertBefore(
    parent: TNode,
    shadow: boolean,
    node: TNode,
    before: TNode | undefined,
  ): void {
    const list = childList(parent, shadow);
    const index = before === undefined ? -1 : list.indexOf(before);
    if (index < 0) list.push(node);
    else list.splice(index, 0, node);
    node[PARENT] = parent;
    node[IN_SHADOW] = shadow;
  }

  /** Takes a node out of its parent's list; its ids stay. */
  private detach(node: TNode): void {
    const parent = node[PARENT];
    if (parent === null || parent === undefined) return;
    if (parent.type === NodeKind.Element && this.frames.get(parent.id) === node) {
      this.frames.delete(parent.id);
    } else {
      const list = node[IN_SHADOW] ? parent[SHADOW] : parent.childNodes;
      const index = list?.indexOf(node) ?? -1;
      if (index >= 0) list!.splice(index, 1);
    }
    node[PARENT] = null;
  }

  /** Forgets a detached subtree: its ids, its frames' documents and what refers to them. */
  private drop(node: TNode, removed?: Set<number>): void {
    const stack = [node];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (this.nodes.get(current.id) === current) {
        this.nodes.delete(current.id);
        this.graveyard.add(current.id);
        removed?.add(current.id);
        this.estBytes -= current[SIZE] ?? 0;
        if (this.sidecarOwners.has(current.id)) this.prune(current.id);
        this.canvas.delete(current.id);
        this.frameScrolls.delete(current.id);
      }
      for (const child of current.childNodes ?? []) stack.push(child);
      for (const child of current[SHADOW] ?? []) stack.push(child);
      const doc = isIframe(current) ? this.frames.get(current.id) : undefined;
      if (doc !== undefined) {
        this.frames.delete(current.id);
        stack.push(doc);
      }
    }
    if (this.graveyard.size > GRAVEYARD_LIMIT) this.graveyard = new Set();
  }

  /** A style element's sheet is rebuilt when its text changes: its rule edits are in the text. */
  private contentChanged(parent: TNode | undefined): void {
    if (parent?.type === NodeKind.Element && parent.tagName === "style") {
      this.materializeStyle(parent);
      this.prune(parent.id);
    }
  }

  // ---- other events ----

  private applyScroll(
    event: eventWithTime,
    data: { id: number; x: number; y: number },
  ): "ok" | "ignored" {
    if (data.id === this.root.id) {
      this.offset = { left: Number(data.x) || 0, top: Number(data.y) || 0 };
      return "ok";
    }
    const node = this.nodes.get(data.id);
    if (node === undefined) return "ignored";
    if (node.type === NodeKind.Document) {
      this.frameScrolls.set(node.id, structuredClone(event));
      return "ok";
    }
    if (node.type !== NodeKind.Element) return "ignored";
    const attributes = (node.attributes ??= {});
    if (data.x) attributes.rr_scrollLeft = Number(data.x);
    else delete attributes.rr_scrollLeft;
    if (data.y) attributes.rr_scrollTop = Number(data.y);
    else delete attributes.rr_scrollTop;
    return "ok";
  }

  /** As rrweb-snapshot serializes form state (serializeElementNode). */
  private applyInput(data: { id: number; text: string; isChecked: boolean }): "ok" | "ignored" {
    const node = this.nodes.get(data.id);
    if (node === undefined || node.type !== NodeKind.Element) return "ignored";
    const attributes = (node.attributes ??= {});
    this.estBytes -= node[SIZE] ?? 0;
    const type = attributes.type;
    const text = typeof data.text === "string" ? data.text : "";
    if (type === "radio" || type === "checkbox" || type === "submit" || type === "button") {
      if (data.isChecked) attributes.checked = true;
      else delete attributes.checked;
    } else {
      if (text) attributes.value = text;
      else delete attributes.value;
      if (node.tagName === "textarea") {
        for (const child of [...(node.childNodes ?? [])]) {
          this.detach(child);
          this.drop(child);
        }
      }
      if (node.tagName === "select") this.selectOption(node, text);
    }
    node[SIZE] = nodeSize(node);
    this.estBytes += node[SIZE];
    return "ok";
  }

  private selectOption(select: TNode, value: string): void {
    let chosen = false;
    const visit = (node: TNode) => {
      if (node.type !== NodeKind.Element) return;
      if (node.tagName === "option") {
        const attributes = (node.attributes ??= {});
        const optionValue =
          typeof attributes.value === "string"
            ? attributes.value
            : (node.childNodes ?? [])
                .map((child) => child.textContent ?? "")
                .join("")
                .replace(/\s+/g, " ")
                .trim();
        if (!chosen && optionValue === value) {
          attributes.selected = true;
          chosen = true;
        } else delete attributes.selected;
        return;
      }
      for (const child of node.childNodes ?? []) visit(child);
    };
    for (const child of select.childNodes ?? []) visit(child);
  }

  private applyMedia(data: Record<string, unknown>): "ok" | "ignored" {
    const node = this.nodes.get(Number(data.id));
    if (node === undefined || node.type !== NodeKind.Element) return "ignored";
    const attributes = (node.attributes ??= {});
    if (data.type === 0) attributes.rr_mediaState = "played";
    if (data.type === 1) attributes.rr_mediaState = "paused";
    if (typeof data.currentTime === "number") attributes.rr_mediaCurrentTime = data.currentTime;
    if (typeof data.playbackRate === "number") attributes.rr_mediaPlaybackRate = data.playbackRate;
    if (typeof data.muted === "boolean") attributes.rr_mediaMuted = data.muted;
    if (typeof data.loop === "boolean") attributes.rr_mediaLoop = data.loop;
    if (typeof data.volume === "number") attributes.rr_mediaVolume = data.volume;
    return "ok";
  }

  private applyCanvas(event: eventWithTime, data: Record<string, unknown>): "ok" | "ignored" {
    const id = Number(data.id);
    if (!this.nodes.has(id)) return "ignored";
    const commands = data.commands as { property?: string }[] | undefined;
    const fullFrame =
      Array.isArray(commands) &&
      commands[0]?.property === "clearRect" &&
      commands.some((command) => command.property === "drawImage");
    const copy = structuredClone(event);
    if (fullFrame) {
      this.canvas.set(id, [copy]);
      return "ok";
    }
    const list = this.canvas.get(id) ?? [];
    list.push(copy);
    this.canvas.set(id, list);
    if (list.length > this.maxCanvasCommands) throw new TreeBroken("canvas-commands", true);
    return "ok";
  }

  // ---- CSSOM sidecar ----

  private addSidecar(event: eventWithTime, data: Record<string, unknown>): void {
    const owner = typeof data.id === "number" ? data.id : undefined;
    const styleId = typeof data.styleId === "number" ? data.styleId : undefined;
    // A constructed sheet's replace() gives it all its rules: what came before is moot.
    if (
      data.source === IncrementalSource.StyleSheetRule &&
      styleId !== undefined &&
      (typeof data.replace === "string" || typeof data.replaceSync === "string")
    ) {
      this.removeSidecar(
        (entry) =>
          entry.styleId === styleId &&
          ((entry.event.data as { source: number }).source === IncrementalSource.StyleSheetRule ||
            (entry.event.data as { source: number }).source === IncrementalSource.StyleDeclaration),
      );
    }
    const copy = structuredClone(event);
    const bytes = eventBytes(copy);
    this.sidecar.push({ event: copy, owner, styleId, bytes });
    this.sidecarBytes += bytes;
    this.estBytes += bytes;
    if (owner !== undefined)
      this.sidecarOwners.set(owner, (this.sidecarOwners.get(owner) ?? 0) + 1);
  }

  /** Forgets the sheet edits of an element whose sheet is gone or rebuilt. */
  private prune(owner: number): void {
    if (!this.sidecarOwners.has(owner)) return;
    this.removeSidecar((entry) => entry.owner === owner);
  }

  private removeSidecar(match: (entry: SideEntry) => boolean): void {
    const kept: SideEntry[] = [];
    for (const entry of this.sidecar) {
      if (!match(entry)) {
        kept.push(entry);
        continue;
      }
      this.sidecarBytes -= entry.bytes;
      this.estBytes -= entry.bytes;
      if (entry.owner !== undefined) {
        const count = (this.sidecarOwners.get(entry.owner) ?? 1) - 1;
        if (count <= 0) this.sidecarOwners.delete(entry.owner);
        else this.sidecarOwners.set(entry.owner, count);
      }
    }
    this.sidecar = kept;
  }

  /** Bytes of everything kept beside the nodes, for the memory estimate. */
  residualBytes(): number {
    let bytes = this.sidecarBytes;
    for (const list of this.canvas.values()) for (const event of list) bytes += eventBytes(event);
    return bytes;
  }

  // ---- invariants ----

  /** Throws TreeBroken("invariant") on any inconsistency between the lists and the index. */
  assertInvariants(): void {
    let count = 0;
    const visit = (node: TNode, parent: TNode | null, inShadow: boolean, depth: number) => {
      if (depth > 10_000) throw new TreeBroken("cycle");
      if (this.nodes.get(node.id) !== node) throw new TreeBroken("invariant");
      if (node[PARENT] !== parent) throw new TreeBroken("invariant");
      if ((node[IN_SHADOW] ?? false) !== inShadow) throw new TreeBroken("invariant");
      count += 1;
      if (!isContainer(node) && ((node.childNodes?.length ?? 0) > 0 || node[SHADOW]?.length))
        throw new TreeBroken("under-text");
      for (const child of node.childNodes ?? []) visit(child, node, false, depth + 1);
      for (const child of node[SHADOW] ?? []) visit(child, node, true, depth + 1);
      const doc = isIframe(node) ? this.frames.get(node.id) : undefined;
      if (doc !== undefined) visit(doc, node, false, depth + 1);
    };
    visit(this.root, null, false, 0);
    if (count !== this.nodes.size) throw new TreeBroken("invariant");
  }

  // ---- comparison with a page snapshot ----

  /**
   * Differences between this tree and the page's own snapshot of the same document (ids are
   * stable across same-document snapshots). Volatile media time, adopted sheets (whose ids the
   * recorder mints again) and style text whose form differs (a sheet's text against its
   * children's) are not compared.
   */
  compare(meta: eventWithTime, full: eventWithTime, attach: readonly eventWithTime[]): Mismatch[] {
    const page = LiveTree.seed(meta, full);
    for (const event of attach) page.apply(event);
    const mismatches: Mismatch[] = [];
    const add = (id: number, kind: string) => {
      if (mismatches.length < 50) mismatches.push({ id, kind });
    };
    if (page.meta.width !== this.meta.width || page.meta.height !== this.meta.height)
      add(0, "meta");
    const visit = (mine: TNode, theirs: TNode) => {
      if (mine.type !== theirs.type || mine.tagName !== theirs.tagName) {
        add(mine.id, "node");
        return;
      }
      if (mine.type === NodeKind.Element) compareAttributes(mine, theirs, add);
      const styleForm =
        mine.type === NodeKind.Element &&
        mine.tagName === "style" &&
        (typeof mine.attributes?._cssText === "string") !==
          (typeof theirs.attributes?._cssText === "string");
      if (styleForm) return;
      if (
        mine.type !== NodeKind.Element &&
        mine.type !== NodeKind.Document &&
        (mine.textContent ?? "") !== (theirs.textContent ?? "")
      ) {
        const parent = mine[PARENT];
        const capturedStyle =
          parent?.tagName === "style" && typeof parent.attributes?._cssText === "string";
        if (!capturedStyle) add(mine.id, "text");
      }
      for (const shadow of [false, true]) {
        const a = shadow ? (mine[SHADOW] ?? []) : (mine.childNodes ?? []);
        const b = shadow ? (theirs[SHADOW] ?? []) : (theirs.childNodes ?? []);
        if (a.length !== b.length || a.some((child, index) => child.id !== b[index]!.id)) {
          add(mine.id, shadow ? "shadow-children" : "children");
          continue;
        }
        a.forEach((child, index) => visit(child, b[index]!));
      }
      if (isIframe(mine)) {
        const a = this.frames.get(mine.id);
        const b = page.frames.get(theirs.id);
        if ((a === undefined) !== (b === undefined)) add(mine.id, "frame");
        else if (a !== undefined && b !== undefined) {
          if (a.id !== b.id) add(mine.id, "frame");
          else visit(a, b);
        }
      }
    };
    if (this.root.id !== page.root.id) add(this.root.id, "root");
    else visit(this.root, page.root);
    return mismatches;
  }
}

const VOLATILE_ATTRIBUTES = new Set(["rr_mediaCurrentTime"]);

function compareAttributes(
  mine: TNode,
  theirs: TNode,
  add: (id: number, kind: string) => void,
): void {
  const a = mine.attributes ?? {};
  const b = theirs.attributes ?? {};
  const style = mine.tagName === "style" || mine.tagName === "link";
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const name of names) {
    if (VOLATILE_ATTRIBUTES.has(name)) continue;
    if (style && name === "_cssText") continue;
    const x = a[name];
    const y = b[name];
    if (name === "style" && typeof x === "string" && typeof y === "string") {
      const mapA = declarationMap(x);
      const mapB = declarationMap(y);
      if (mapA.size !== mapB.size || [...mapA].some(([key, value]) => mapB.get(key) !== value))
        add(mine.id, "style");
      continue;
    }
    if (String(x) !== String(y)) add(mine.id, `attr:${name}`);
  }
}

function childList(parent: TNode, shadow: boolean): TNode[] {
  if (shadow) return (parent[SHADOW] ??= []);
  return (parent.childNodes ??= []);
}

function nextSibling(node: TNode): TNode | undefined {
  const parent = node[PARENT];
  if (parent === null || parent === undefined) return undefined;
  const list = node[IN_SHADOW] ? parent[SHADOW] : parent.childNodes;
  if (list === undefined) return undefined;
  const index = list.indexOf(node);
  return index < 0 ? undefined : list[index + 1];
}

/** DOM `contains` from the list `shadow` of `parent`: the same tree scope, any depth. */
function containsInScope(parent: TNode, shadow: boolean, node: TNode): boolean {
  let current: TNode = node;
  for (;;) {
    const up = current[PARENT];
    if (up === null || up === undefined) return false;
    if (up === parent) return (current[IN_SHADOW] ?? false) === shadow;
    // Crossing into a shadow host or out of a frame document leaves the scope.
    if (current[IN_SHADOW] || current.type === NodeKind.Document) return false;
    current = up;
  }
}

/** Copies the add's own fields (never its children) onto a node the tree already has. */
function refreshFields(target: TNode, source: TNode): void {
  for (const key of Object.keys(source)) {
    if (key === "childNodes" || key === "id") continue;
    const value = source[key];
    target[key] = value !== null && typeof value === "object" ? structuredClone(value) : value;
  }
}

function cloneAdded(mutation: AddedNode): AddedNode {
  return structuredClone(mutation);
}

interface ResolveTree {
  value: AddedNode;
  parent: ResolveTree | null;
  children: ResolveTree[];
}

/** replay.js queueToResolveTrees. */
function queueToResolveTrees(queue: AddedNode[]): ResolveTree[] {
  const map = new Map<number, ResolveTree>();
  const put = (mutation: AddedNode, parent: ResolveTree | null): ResolveTree => {
    const tree: ResolveTree = { value: mutation, parent, children: [] };
    map.set(mutation.node.id, tree);
    return tree;
  };
  const trees: ResolveTree[] = [];
  for (const mutation of queue) {
    const { nextId, parentId } = mutation;
    const next = nextId ? map.get(nextId) : undefined;
    if (next !== undefined) {
      if (next.parent) {
        const index = next.parent.children.indexOf(next);
        next.parent.children.splice(index, 0, put(mutation, next.parent));
      } else {
        const index = trees.indexOf(next);
        trees.splice(index, 0, put(mutation, null));
      }
      continue;
    }
    const parent = map.get(parentId);
    if (parent !== undefined) {
      parent.children.push(put(mutation, parent));
      continue;
    }
    trees.push(put(mutation, null));
  }
  return trees;
}

/** replay.js iterateResolveTree. */
function iterateResolveTree(tree: ResolveTree, callback: (mutation: AddedNode) => void): void {
  callback(tree.value);
  for (let index = tree.children.length - 1; index >= 0; index--)
    iterateResolveTree(tree.children[index]!, callback);
}

function countTree(tree: ResolveTree): number {
  let count = 1;
  for (const child of tree.children) count += countTree(child);
  return count;
}
