/**
 * Local-echo typing filter.
 *
 * Plain value controls suppress rrweb INPUT echoes and reconcile their scalar `.value` on decay.
 * Contenteditables edit natively too, but their value is a DOM subtree: suppress only rrweb
 * MUTATION records addressed into the active subtree, and only within the echo window after local
 * typing; later authoritative mutations flow. Never attempt a `.value` snap for contenteditable.
 * Clear the node map on resync (register onReset).
 *
 * What was suppressed is remembered. When typing settles (or on blur), text the page has that
 * this editor lacks, or text it removed that this editor still shows, means the two went apart,
 * and the filter asks for a reconcile. So does a later mutation naming a node whose addition was
 * suppressed: this replay never got that node, so it cannot apply the change.
 */
import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";
import {
  deepActiveElement,
  isContenteditableEchoField,
  isEchoField,
  isValueEchoField,
  type EditableFocus,
} from "../input/keys";
import type { RebuildRestoreHook } from "../rebuild-restore";
import { isPasswordField } from "../input/password";
import type { PipelineCtx, Stage } from "./index";

interface EditingState {
  element: HTMLElement;
  lastKeyTs: number;
  pendingServerValue?: string;
  subtreeNodeIds?: Set<number>;
  timer: ReturnType<typeof setTimeout> | null;
  /** What the page did to this editor that its replay did not see, while typing. */
  suppressed?: SuppressedEdits;
}

interface SuppressedEdits {
  /** The page's latest text of each text node it changed or added. */
  texts: Map<number, string>;
  /** Parents of the nodes it added, to forget the texts of a subtree it removed again. */
  parents: Map<number, number>;
  /** The nodes the page removed, with their text. */
  removed: Array<{ id: number; text: string }>;
}

interface EchoRestoreState {
  nodeId: number;
  value: string;
  lastKeyTs: number;
  pendingServerValue?: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: "forward" | "backward" | "none" | null;
}

// @rrweb/types MouseInteractions.Focus/Blur. Protocol intentionally exports only the frozen rrweb
// event surface, so keep these replay-internal discriminators local to the viewer.
const MOUSE_INTERACTION_FOCUS_EVENTS = new Set([5, 6]);
/** How long an applied text change may still wait in the replay buffer. */
const PASSED_TEXT_MEMORY_MS = 3_000;
/** A reconcile the runtime could not send yet is asked for again this often, this many times. */
const RECONCILE_RETRY_MS = 1_000;
const RECONCILE_RETRIES = 30;

export interface EchoFilter extends Stage {
  setFocused(focus: EditableFocus | null): void;
  input(focus: EditableFocus): void;
  keyDown(event: KeyboardEvent, focus: EditableFocus | null): void;
  getFocused(): EditableFocus | null;
  /** True when a field was typed into less than `ms` ago. */
  typingWithin(ms: number): boolean;
  /**
   * The focused editor was brought back in step with the page in place (editable-patch.ts): what
   * held the two apart is settled, and the next divergence asks for a reconcile again.
   */
  settled(): void;
  reset(): void;
  restoreHook: RebuildRestoreHook<EchoRestoreState>;
}

export interface EchoFilterOptions {
  decayMs?: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  /**
   * A contenteditable's replay went apart from the page; once until the next reset. Returns false
   * when nothing could be sent (no input to this tab right now): it is asked again later.
   */
  onContenteditableReconcile?: () => boolean | void;
  /** The replay's node for an rrweb id, to compare local text with what the page reports. */
  nodeFor?: (id: number) => Node | null;
}

export function createEchoFilter(options: EchoFilterOptions = {}): EchoFilter {
  const decayMs = options.decayMs ?? 1_000;
  const now = options.now ?? Date.now;
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  const nodeFor = options.nodeFor ?? (() => null);
  const nodes = new Map<number, EditingState>();
  let focused: EditableFocus | null = null;
  /** Nodes the page added while their additions were suppressed: this replay never had them. */
  const unmapped = new Set<number>();
  /** Text mutations let through to a focused editor, by node, to know none is still buffered. */
  const passedTexts = new Map<number, number>();
  let reconcileRequested = false;
  let reconcileRetry: ReturnType<typeof setTimeout> | null = null;
  let reconcileRetries = 0;

  const requestReconcile = () => {
    if (reconcileRequested || reconcileRetry !== null) return;
    if (options.onContenteditableReconcile?.() === false) {
      // Latched only once sent: the divergence is still there when input to the tab returns.
      if (reconcileRetries >= RECONCILE_RETRIES) return;
      reconcileRetries += 1;
      reconcileRetry = schedule(() => {
        reconcileRetry = null;
        requestReconcile();
      }, RECONCILE_RETRY_MS);
      return;
    }
    reconcileRequested = true;
  };

  const clearState = (nodeId: number) => {
    const state = nodes.get(nodeId);
    if (state?.timer !== null && state?.timer !== undefined) cancel(state.timer);
    nodes.delete(nodeId);
  };

  const reconcile = (nodeId: number) => {
    const state = nodes.get(nodeId);
    if (state === undefined) return;
    // A nonempty password echo contains a mask, never an authoritative editable value.
    if (isPasswordField(state.element) && state.pendingServerValue !== "") {
      state.timer = null;
      return;
    }
    if (!isValueEchoField(state.element)) {
      // Leaving the editor mid-burst: its last echoes are still on the way.
      const remaining = state.lastKeyTs + decayMs - now();
      if (remaining > 0) {
        if (state.timer !== null) cancel(state.timer);
        state.timer = schedule(() => reconcile(nodeId), remaining);
        return;
      }
      state.timer = null;
      const suppressed = state.suppressed;
      clearState(nodeId);
      if (suppressed !== undefined && diverged(state.element, suppressed, nodeFor))
        requestReconcile();
      return;
    }
    if (
      isValueEchoField(state.element) &&
      state.pendingServerValue !== undefined &&
      state.element.value !== state.pendingServerValue
    ) {
      const preserveSelection = state.element.value.length === state.pendingServerValue.length;
      const selectionStart = preserveSelection ? state.element.selectionStart : null;
      const selectionEnd = preserveSelection ? state.element.selectionEnd : null;
      const selectionDirection = preserveSelection ? state.element.selectionDirection : null;
      state.element.value = state.pendingServerValue;
      if (selectionStart !== null && selectionEnd !== null) {
        try {
          state.element.setSelectionRange(
            selectionStart,
            selectionEnd,
            selectionDirection ?? "none",
          );
        } catch {
          // Inputs such as number fields do not expose a selection range.
        }
      }
    }
    clearState(nodeId);
  };

  const armDecay = (nodeId: number, state: EditingState) => {
    if (state.timer !== null) cancel(state.timer);
    const remaining = Math.max(0, decayMs - (now() - state.lastKeyTs));
    state.timer = schedule(() => {
      const current = nodes.get(nodeId);
      if (current !== state) return;
      if (now() - current.lastKeyTs < decayMs) {
        armDecay(nodeId, current);
        return;
      }
      reconcile(nodeId);
    }, remaining);
  };

  const filter = ((event: eventWithTime, ctx: PipelineCtx): eventWithTime | null => {
    if (event.type !== EventType.IncrementalSnapshot) return event;
    const data = event.data;
    if (
      data.source === IncrementalSource.MouseInteraction &&
      MOUSE_INTERACTION_FOCUS_EVENTS.has(data.type)
    ) {
      // Focus is local interaction state: trusted click/Tab already performed this transition in
      // the mirror before the authoritative recording echoes it back. Replaying delayed focus/blur
      // can redirect native keystrokes into an old field or leave the document body focused.
      return null;
    }
    if (data.source === IncrementalSource.Mutation) {
      // The page removed an editing host itself (a chat composer mounted anew after sending):
      // that is not an echo of typing. Kept here, the old editor would keep focus and take keys
      // the page has nowhere to put, so its removal, and anything it adds in its place, show.
      for (const mutation of data.removes) {
        const state = nodes.get(mutation.id);
        if (state !== undefined && state.subtreeNodeIds !== undefined) clearState(mutation.id);
      }
      // Suppression lasts only the echo window after local typing, focus or not: past it, the
      // page's own changes to the editor must show.
      const active: EditingState[] = [];
      for (const [nodeId, state] of nodes) {
        if (state.element.isConnected === false) {
          clearState(nodeId);
          continue;
        }
        if (state.subtreeNodeIds === undefined) continue;
        const ids = state.subtreeNodeIds;
        for (const mutation of data.adds)
          if (ids.has(mutation.parentId)) collectSerializedNodeIds(mutation.node, ids);
        if (ctx.nowMs - state.lastKeyTs < decayMs) active.push(state);
      }

      const owner = (id: number) => active.find((state) => state.subtreeNodeIds!.has(id));
      const record = (state: EditingState): SuppressedEdits =>
        (state.suppressed ??= { texts: new Map(), parents: new Map(), removed: [] });
      const adds = data.adds.filter((mutation) => {
        const state = owner(mutation.parentId) ?? owner(mutation.node.id);
        if (state === undefined) return true;
        collectSerializedNodeIds(mutation.node, state.subtreeNodeIds!);
        collectSerializedNodeIds(mutation.node, unmapped);
        recordAddedTexts(record(state), mutation.node, mutation.parentId);
        return false;
      });
      // Adds can introduce ids referenced by another record in the same rrweb mutation batch.
      const texts = data.texts.filter((mutation) => {
        const state = owner(mutation.id);
        if (state === undefined) return true;
        record(state).texts.set(mutation.id, mutation.value ?? "");
        return false;
      });
      const attributes = data.attributes.filter((mutation) => owner(mutation.id) === undefined);
      const removes = data.removes.filter((mutation) => {
        const state = owner(mutation.id) ?? owner(mutation.parentId);
        if (state === undefined) return true;
        const edits = record(state);
        const known = edits.texts.get(mutation.id);
        const text = known ?? nodeFor(mutation.id)?.textContent ?? "";
        forgetSubtree(edits, mutation.id);
        edits.removed.push({ id: mutation.id, text });
        return false;
      });

      // What passes and names a node this replay never got cannot be applied here.
      if (
        unmapped.size > 0 &&
        (texts.some((mutation) => unmapped.has(mutation.id)) ||
          attributes.some((mutation) => unmapped.has(mutation.id)) ||
          removes.some(
            (mutation) => unmapped.has(mutation.id) || unmapped.has(mutation.parentId),
          ) ||
          adds.some(
            (mutation) =>
              unmapped.has(mutation.parentId) ||
              (mutation.nextId !== null && unmapped.has(mutation.nextId)),
          ))
      ) {
        requestReconcile();
      }

      // Setting a text node's data, even to what it already holds, moves a caret inside it to
      // the start. An echo that arrives after its window changes nothing but that.
      const focusedEditor =
        focused !== null && isContenteditableEchoField(focused.element) ? focused.element : null;
      const unchanged = (mutation: { id: number; value: string | null }) => {
        if (focusedEditor === null) return false;
        const node = nodeFor(mutation.id);
        if (node === null || !focusedEditor.contains(node)) return false;
        const at = passedTexts.get(mutation.id);
        // An earlier change still waiting in the replay buffer would make this one necessary.
        if (at !== undefined && ctx.nowMs - at < PASSED_TEXT_MEMORY_MS) return false;
        if (node.textContent === (mutation.value ?? "")) return true;
        passedTexts.set(mutation.id, ctx.nowMs);
        if (passedTexts.size > 256) passedTexts.delete(passedTexts.keys().next().value!);
        return false;
      };
      const applied = texts.filter((mutation) => !unchanged(mutation));
      if (
        applied.length === data.texts.length &&
        attributes.length === data.attributes.length &&
        removes.length === data.removes.length &&
        adds.length === data.adds.length
      ) {
        return event;
      }
      if (
        applied.length === 0 &&
        attributes.length === 0 &&
        removes.length === 0 &&
        adds.length === 0
      ) {
        return null;
      }
      return {
        ...event,
        data: { ...data, texts: applied, attributes, removes, adds },
      } as eventWithTime;
    }
    if (data.source !== IncrementalSource.Input || data.isChecked) return event;
    const state = nodes.get(data.id);
    if (state === undefined || !isValueEchoField(state.element)) return event;
    if (isPasswordField(state.element) && data.text !== "") {
      state.pendingServerValue = undefined;
      return null;
    }
    if (ctx.nowMs - state.lastKeyTs < decayMs) {
      state.pendingServerValue = data.text;
      return null;
    }
    clearState(data.id);
    return event;
  }) as EchoFilter;

  filter.setFocused = (focus) => {
    if (focused?.nodeId === focus?.nodeId && focused?.element === focus?.element) return;
    if (focused !== null) reconcile(focused.nodeId);
    focused = focus;
  };

  filter.input = (focus) => {
    filter.setFocused(focus);
    if (focus.nodeId < 0 || !isEchoField(focus.element)) return;
    const field = focus.element;
    const timestamp = now();
    const state = nodes.get(focus.nodeId) ?? {
      element: field,
      lastKeyTs: timestamp,
      timer: null,
    };
    state.element = field;
    state.lastKeyTs = timestamp;
    if (isContenteditableEchoField(field)) {
      state.pendingServerValue = undefined;
      state.subtreeNodeIds ??= new Set<number>();
      state.subtreeNodeIds.add(focus.nodeId);
      for (const id of focused?.subtreeNodeIds ?? []) state.subtreeNodeIds.add(id);
      for (const id of focus.subtreeNodeIds ?? []) state.subtreeNodeIds.add(id);
    } else {
      state.subtreeNodeIds = undefined;
    }
    nodes.set(focus.nodeId, state);
    armDecay(focus.nodeId, state);
  };

  filter.keyDown = (_event, focus) => {
    filter.setFocused(focus);
    // Enter is not an acknowledgement of earlier edits. Keep local text protected
    // until the ordinary reconciliation window; a delayed echo may be a prefix.
  };

  filter.getFocused = () => focused;
  filter.typingWithin = (ms) => {
    const at = now();
    for (const state of nodes.values()) if (at - state.lastKeyTs < ms) return true;
    return false;
  };
  filter.settled = () => {
    for (const state of nodes.values()) state.suppressed = undefined;
    unmapped.clear();
    passedTexts.clear();
    reconcileRequested = false;
    if (reconcileRetry !== null) cancel(reconcileRetry);
    reconcileRetry = null;
    reconcileRetries = 0;
  };
  filter.reset = () => {
    for (const nodeId of [...nodes.keys()]) clearState(nodeId);
    focused = null;
    // A rebuilt replay has every node of the page again.
    unmapped.clear();
    passedTexts.clear();
    reconcileRequested = false;
    if (reconcileRetry !== null) cancel(reconcileRetry);
    reconcileRetry = null;
    reconcileRetries = 0;
  };

  filter.restoreHook = {
    capture() {
      if (focused === null) return null;
      const state = nodes.get(focused.nodeId);
      if (
        state === undefined ||
        !isValueEchoField(focused.element) ||
        !isValueEchoField(state.element)
      ) {
        return null;
      }
      return {
        nodeId: focused.nodeId,
        value: state.element.value,
        lastKeyTs: state.lastKeyTs,
        pendingServerValue: state.pendingServerValue,
        selectionStart: state.element.selectionStart,
        selectionEnd: state.element.selectionEnd,
        selectionDirection: state.element.selectionDirection,
      };
    },
    restore(iframe, snapshot) {
      const root = iframe.contentDocument;
      const active = root === null ? null : deepActiveElement(root);
      if (active === null || !isValueEchoField(active)) return;
      active.value = snapshot.value;
      if (snapshot.selectionStart !== null && snapshot.selectionEnd !== null) {
        try {
          active.setSelectionRange(
            snapshot.selectionStart,
            snapshot.selectionEnd,
            snapshot.selectionDirection ?? "none",
          );
        } catch {
          // Inputs such as number fields do not expose a selection range.
        }
      }
      const state: EditingState = {
        element: active,
        lastKeyTs: snapshot.lastKeyTs,
        pendingServerValue: snapshot.pendingServerValue,
        timer: null,
      };
      nodes.set(snapshot.nodeId, state);
      focused = { element: active, nodeId: snapshot.nodeId };
      armDecay(snapshot.nodeId, state);
    },
  };

  return filter;
}

function collectSerializedNodeIds(
  node: { id: number; childNodes?: unknown[] },
  ids: Set<number>,
): void {
  ids.add(node.id);
  for (const child of node.childNodes ?? []) {
    collectSerializedNodeIds(child as { id: number; childNodes?: unknown[] }, ids);
  }
}

interface SerializedNode {
  id: number;
  type?: number;
  textContent?: string;
  childNodes?: unknown[];
}

/** rrweb's serialized node type for text. */
const SERIALIZED_TEXT = 3;

function recordAddedTexts(edits: SuppressedEdits, node: SerializedNode, parentId: number): void {
  edits.parents.set(node.id, parentId);
  if (node.type === SERIALIZED_TEXT) edits.texts.set(node.id, node.textContent ?? "");
  for (const child of node.childNodes ?? []) {
    recordAddedTexts(edits, child as SerializedNode, node.id);
  }
}

/** A removed node takes the text of everything the page had added below it along. */
function forgetSubtree(edits: SuppressedEdits, id: number): void {
  const inside = (node: number): boolean => {
    for (let at: number | undefined = node; at !== undefined; at = edits.parents.get(at)) {
      if (at === id) return true;
    }
    return false;
  };
  for (const node of [...edits.texts.keys()]) if (inside(node)) edits.texts.delete(node);
}

function normalizedText(text: string): string {
  return text.replace(/ /g, " ").trim();
}

/**
 * Whether the page's editor, as far as the suppressed changes tell, holds other text than this
 * replay's: a text node both have reads differently, the page has text this one lacks, or it
 * removed text that this one still shows. Echoes of local typing pass: their text is all here
 * already, in whatever nodes the browser made.
 */
function diverged(
  element: HTMLElement,
  edits: SuppressedEdits,
  nodeFor: (id: number) => Node | null,
): boolean {
  const local = normalizedText(element.textContent ?? "");
  const remote = [...edits.texts.values()].map(normalizedText).filter((text) => text !== "");
  // A node this replay has is compared as itself; only text it never got is looked for in the
  // editor's text, where another node holding the same words would otherwise pass for it.
  for (const [id, text] of edits.texts) {
    const node = nodeFor(id);
    if (node === null) {
      const wanted = normalizedText(text);
      if (wanted !== "" && !local.includes(wanted)) return true;
    } else if (element.contains(node)) {
      if (normalizedText(node.textContent ?? "") !== normalizedText(text)) return true;
    }
    // The page moved the node out of this editor: not this editor's text.
  }
  return edits.removed.some(({ id, text }) => {
    const node = nodeFor(id);
    // The page took this node out: this editor still showing it, with text the page holds
    // nowhere else, is apart from it. Another node with the same words is not.
    const shown =
      node === null
        ? normalizedText(text)
        : element.contains(node)
          ? normalizedText(node.textContent ?? "")
          : "";
    if (shown === "" || remote.some((kept) => kept.includes(shown))) return false;
    return node !== null || local.includes(shown);
  });
}
