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
 *
 * One change is not waited for: the page taking away the text that Enter just sent (a chat
 * composer clearing itself after sending). Held back until typing settles, the replay showed the
 * sent message in the composer while the next one was typed after it; the reconcile is asked for
 * as soon as that change arrives.
 *
 * With input acks (`acks`, a gateway with `ackecho1`), "typing settles" is no longer a guess from
 * a timer: a field stays held while any input is unacknowledged, until the final ack after its
 * last input has settled (input/input-seq.ts). That ack carries the hash of what the page's field
 * holds, compared with what this replay's field holds after it has applied everything before the
 * ack: equal, and the two are provably in step, so what was held back is dropped; different, and
 * the reconcile is asked for at once. An ack that covers Enter with the page's field empty, while
 * this one still shows text, is the page having sent and cleared it. The decay timer stays only as
 * a ceiling (ACK_LIVENESS_MS) for acks that never come.
 */
import {
  EventType,
  IncrementalSource,
  editHash,
  editableText,
  normalizeEditableText,
  type eventWithTime,
} from "@mirror/protocol";
import type { InputLabCounter, SettledAck } from "../input/input-seq";
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
  /** Ack mode: held until the final ack covering `watermark` settles. */
  awaiting?: boolean;
  /** Ack mode: the newest input sent when this field was last typed into. */
  watermark?: number;
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
/** How long after Enter the page taking the editor's text away counts as it sending that text. */
const SENT_CLEAR_MS = 5_000;
/** Ack mode: a field typed into is let go after this long without its final ack. */
export const ACK_LIVENESS_MS = 3_000;

/** The input acks the filter follows, for the tab in view (input/input-seq.ts). */
export interface EchoAcks {
  /** The gateway has `ackecho1`: acks decide the editing window. */
  enabled(): boolean;
  subscribe(listener: (settled: SettledAck) => void): () => void;
  /** Inputs sent and not yet settled. */
  outstanding(): number;
  /** The newest iseq sent. */
  lastStamped(): number;
  /** Shadow measurement (inputlab). */
  count?(counter: InputLabCounter): void;
}

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
  /** Input acks: with `enabled()`, they decide when typing has settled instead of `decayMs`. */
  acks?: EchoAcks;
}

/** A field's text as the page's editHash sees it. */
export function localFieldText(element: HTMLElement): string {
  if (isValueEchoField(element)) return element.value;
  return (element as { childNodes?: unknown }).childNodes === undefined
    ? (element.textContent ?? "")
    : editableText(element);
}

export function createEchoFilter(options: EchoFilterOptions = {}): EchoFilter {
  const decayMs = options.decayMs ?? 1_000;
  const now = options.now ?? Date.now;
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  const nodeFor = options.nodeFor ?? (() => null);
  const acks = options.acks;
  const ackMode = () => acks?.enabled() === true;
  /** Whether a field's echoes are still held back. */
  const active = (state: EditingState, at: number) =>
    ackMode()
      ? at - state.lastKeyTs < ACK_LIVENESS_MS * 2 &&
        (state.awaiting === true || (acks?.outstanding() ?? 0) > 0)
      : at - state.lastKeyTs < decayMs;
  /** Ack mode: a reconcile that could not be sent is asked again with the next settled ack. */
  let reconcileDeferred = false;
  const nodes = new Map<number, EditingState>();
  let focused: EditableFocus | null = null;
  /** Nodes the page added while their additions were suppressed: this replay never had them. */
  const unmapped = new Set<number>();
  /** Text mutations let through to a focused editor, by node, to know none is still buffered. */
  const passedTexts = new Map<number, number>();
  let reconcileRequested = false;
  /**
   * The page changed the editor while a reconcile was on its way, or one was due then. That one's
   * catch-up may come from before the change, and the change is held back here: once it is
   * applied (settled), which drops what was held, another is asked for, or the replay would show
   * the editor as it was (the message just sent, left in a composer the page has cleared).
   */
  let reconcileAgain = false;
  let reconcileRetry: ReturnType<typeof setTimeout> | null = null;
  let reconcileRetries = 0;
  /** Each editor's text when Enter was last pressed in it, and when. */
  const sentTexts = new WeakMap<Element, { text: string; at: number }>();
  /** Ack mode: Enter pressed in a field, and the newest iseq sent before it. */
  let sentAck: { element: HTMLElement; nodeId: number; after: number } | null = null;

  const requestReconcile = () => {
    if (reconcileRequested) reconcileAgain = true;
    if (reconcileRequested || reconcileRetry !== null) return;
    if (options.onContenteditableReconcile?.() === false) {
      // Latched only once sent: the divergence is still there when input to the tab returns.
      if (ackMode()) {
        reconcileDeferred = true;
        return;
      }
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
      // Leaving the editor mid-burst: its last echoes are still on the way. With acks, its final
      // ack says when they are all here.
      if (ackMode()) {
        if (active(state, now())) {
          if (state.timer === null) armDecay(nodeId, state);
          return;
        }
      }
      const remaining = ackMode() ? 0 : state.lastKeyTs + decayMs - now();
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
    if (ackMode()) {
      // Only a ceiling: the final ack closes the window. Re-armed whole, never for less.
      if (state.timer !== null) return;
      state.timer = schedule(() => {
        state.timer = null;
        const current = nodes.get(nodeId);
        if (current !== state) return;
        if (now() - current.lastKeyTs < ACK_LIVENESS_MS) {
          armDecay(nodeId, current);
          return;
        }
        current.awaiting = false;
        reconcile(nodeId);
      }, ACK_LIVENESS_MS);
      return;
    }
    if (state.timer !== null) cancel(state.timer);
    const remaining = Math.max(0, decayMs - (now() - state.lastKeyTs));
    state.timer = schedule(() => {
      const current = nodes.get(nodeId);
      if (current !== state) return;
      if (now() - current.lastKeyTs < decayMs) {
        armDecay(nodeId, current);
        return;
      }
      // The page has not answered for everything typed yet: shadow measurement of acks.
      if ((acks?.outstanding() ?? 0) > 0) acks?.count?.("decayWhileOutstanding");
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
      const held: EditingState[] = [];
      for (const [nodeId, state] of nodes) {
        if (state.element.isConnected === false) {
          clearState(nodeId);
          continue;
        }
        if (state.subtreeNodeIds === undefined) continue;
        const ids = state.subtreeNodeIds;
        for (const mutation of data.adds)
          if (ids.has(mutation.parentId)) collectSerializedNodeIds(mutation.node, ids);
        if (active(state, ctx.nowMs)) held.push(state);
      }

      const owner = (id: number) => held.find((state) => state.subtreeNodeIds!.has(id));
      const record = (state: EditingState): SuppressedEdits =>
        (state.suppressed ??= { texts: new Map(), parents: new Map(), removed: [] });
      /** The text each held-back editor's share of this batch took away and put in. */
      const changed = new Map<EditingState, { removed: string; added: string }>();
      const change = (state: EditingState, removed: string, added: string) => {
        const entry = changed.get(state) ?? { removed: "", added: "" };
        entry.removed += removed;
        entry.added += added;
        changed.set(state, entry);
      };
      const adds = data.adds.filter((mutation) => {
        const state = owner(mutation.parentId) ?? owner(mutation.node.id);
        if (state === undefined) return true;
        collectSerializedNodeIds(mutation.node, state.subtreeNodeIds!);
        collectSerializedNodeIds(mutation.node, unmapped);
        recordAddedTexts(record(state), mutation.node, mutation.parentId);
        change(state, "", serializedText(mutation.node));
        return false;
      });
      // Adds can introduce ids referenced by another record in the same rrweb mutation batch.
      const texts = data.texts.filter((mutation) => {
        const state = owner(mutation.id);
        if (state === undefined) return true;
        const edits = record(state);
        change(
          state,
          edits.texts.get(mutation.id) ?? nodeFor(mutation.id)?.textContent ?? "",
          mutation.value ?? "",
        );
        edits.texts.set(mutation.id, mutation.value ?? "");
        return false;
      });
      const attributes = data.attributes.filter((mutation) => owner(mutation.id) === undefined);
      const removes = data.removes.filter((mutation) => {
        const state = owner(mutation.id) ?? owner(mutation.parentId);
        if (state === undefined) return true;
        const edits = record(state);
        const known = edits.texts.get(mutation.id);
        const text = known ?? nodeFor(mutation.id)?.textContent ?? "";
        change(state, text || subtreeText(edits, mutation.id), "");
        forgetSubtree(edits, mutation.id);
        edits.removed.push({ id: mutation.id, text });
        return false;
      });
      // The page took away the text Enter sent: it sent it and cleared the editor. Typing goes
      // on, so waiting for it to settle would show the sent text for as long as it does.
      // With acks, Enter's text counts until the final ack after it, not for SENT_CLEAR_MS.
      for (const [state, { removed, added }] of changed) {
        const sent = sentTexts.get(state.element);
        if (sent === undefined || (!ackMode() && now() - sent.at > SENT_CLEAR_MS)) continue;
        const text = compact(sent.text);
        if (text === "" || !compact(removed).includes(text) || compact(added).includes(text))
          continue;
        sentTexts.delete(state.element);
        if (sentAck?.element === state.element) sentAck = null;
        requestReconcile();
      }
      // A change held back now is not in a catch-up that may already be on its way.
      if (reconcileRequested && changed.size > 0) reconcileAgain = true;

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
        // An earlier change still waiting in the replay buffer would make this one necessary. With
        // acks, it is remembered until a settled ack shows the replay caught up.
        if (at !== undefined && (ackMode() || ctx.nowMs - at < PASSED_TEXT_MEMORY_MS)) return false;
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
    if (active(state, ctx.nowMs)) {
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
    if (ackMode()) {
      state.awaiting = true;
      state.watermark = acks!.lastStamped();
    }
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

  filter.keyDown = (event, focus) => {
    filter.setFocused(focus);
    // Enter is not an acknowledgement of earlier edits. Keep local text protected
    // until the ordinary reconciliation window; a delayed echo may be a prefix.
    // What it may have sent is remembered, to know the page's clearing of it when it comes.
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      focus !== null &&
      isContenteditableEchoField(focus.element)
    )
      sentTexts.set(focus.element, { text: focus.element.textContent ?? "", at: now() });
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      focus !== null &&
      isEchoField(focus.element) &&
      ackMode()
    )
      sentAck = { element: focus.element, nodeId: focus.nodeId, after: acks!.lastStamped() };
  };

  filter.getFocused = () => focused;
  filter.typingWithin = (ms) => {
    const at = now();
    // Unacknowledged input is still typing, up to the liveness ceiling: a replay that lags (a busy
    // viewer) must not hold an editor's catch-up off for good.
    if (ackMode() && (acks?.outstanding() ?? 0) > 0)
      for (const state of nodes.values()) if (at - state.lastKeyTs < ACK_LIVENESS_MS) return true;
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
    // The page changed again after the snapshot this one came from was asked for.
    if (reconcileAgain) {
      reconcileAgain = false;
      requestReconcile();
    }
  };
  filter.reset = () => {
    for (const nodeId of [...nodes.keys()]) clearState(nodeId);
    focused = null;
    // A rebuilt replay has every node of the page again.
    unmapped.clear();
    passedTexts.clear();
    reconcileRequested = false;
    reconcileAgain = false;
    reconcileDeferred = false;
    sentAck = null;
    if (reconcileRetry !== null) cancel(reconcileRetry);
    reconcileRetry = null;
    reconcileRetries = 0;
  };

  /** Ack mode: the final ack after a field's last input settled; the replay has its effects. */
  const closeWindow = (nodeId: number, state: EditingState, settled: SettledAck) => {
    state.awaiting = false;
    const edit = settled.mode === "page" ? settled.edit : undefined;
    if (
      edit === undefined ||
      edit === null ||
      edit.node !== nodeId ||
      edit.hash === "" ||
      isPasswordField(state.element)
    ) {
      reconcile(nodeId);
      return;
    }
    if (editHash(localFieldText(state.element)) === edit.hash) {
      // Provably in step: what was held back changes nothing this field shows.
      clearState(nodeId);
      state.suppressed = undefined;
      unmapped.clear();
      passedTexts.clear();
      return;
    }
    if (isValueEchoField(state.element)) {
      reconcile(nodeId);
      return;
    }
    clearState(nodeId);
    requestReconcile();
  };

  acks?.subscribe((settled) => {
    if (!ackMode()) return;
    if (reconcileDeferred) {
      reconcileDeferred = false;
      requestReconcile();
    }
    // Enter sent the field, and the page has emptied it while this replay still shows text.
    if (sentAck !== null && settled.iseq > sentAck.after) {
      const sent = sentAck;
      const edit = settled.mode === "page" ? settled.edit : undefined;
      if (
        edit !== undefined &&
        edit !== null &&
        edit.node === sent.nodeId &&
        edit.len === 0 &&
        sent.element.isConnected !== false &&
        normalizeEditableText(localFieldText(sent.element)).trim() !== ""
      ) {
        sentAck = null;
        if (!isValueEchoField(sent.element)) {
          clearState(sent.nodeId);
          requestReconcile();
        }
      } else if (settled.final) {
        sentTexts.delete(sent.element);
        sentAck = null;
      }
    }
    if (!settled.final || (acks?.outstanding() ?? 0) > 0) return;
    for (const [nodeId, state] of [...nodes]) {
      if (state.awaiting !== true || settled.iseq < (state.watermark ?? 0)) continue;
      closeWindow(nodeId, state, settled);
    }
  });

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

/** A serialized node's text, as far as the record carries it. */
function serializedText(node: SerializedNode): string {
  if (node.type === SERIALIZED_TEXT) return node.textContent ?? "";
  return (node.childNodes ?? []).map((child) => serializedText(child as SerializedNode)).join("");
}

/** The text the page had added below a node this replay never got. */
function subtreeText(edits: SuppressedEdits, id: number): string {
  let text = "";
  for (const [node, value] of edits.texts) {
    for (let at: number | undefined = node; at !== undefined; at = edits.parents.get(at)) {
      if (at === id) {
        text += value;
        break;
      }
    }
  }
  return text;
}

/** Text without its whitespace, which editors spread over blocks and spaces as they like. */
function compact(text: string): string {
  return text.replace(/[\s\u00a0]+/g, "");
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
