/**
 * The prediction overlay of single-writer input (mosh-style).
 *
 * What was typed into the proxy (proxy-input.ts) and is not in the replay yet is drawn at the
 * replay field's caret, in one layer above the replay that takes no pointer events: inserted text
 * inline in the field's font, deleted text masked with the field's background, an IME's preedit
 * underlined, a password as dots. Where the caret cannot be measured, a small chip above the field
 * shows the pending text instead.
 *
 * The page stays the only writer. Each edit is dropped when the acknowledgement of its input has
 * settled (input-seq.ts: the replay has just applied the page's changes up to that input), in the
 * same callback, so no frame shows both. Before that, an edit the replay already shows is not
 * drawn: the overlay draws only the edits after the longest run of them whose result is the
 * replay's text. A "dispatch" acknowledgement (an old agent, a fence that timed out) says nothing
 * about the page: its edits go once the replay's field changes, or after max(150 ms, 2 RTT +
 * 500 ms), when they are shown as late for one frame first.
 */
import {
  EXPECT_TAIL,
  editHash,
  editableText,
  normalizeEditableText,
  type EditExpect,
} from "@mirror/protocol";
import type { SettledAck } from "./input-seq";
import { applyOps, commonEnds, type PlanOp } from "./proxy-plan";
import { caretRect, isValueField, rangeRects, type CaretBox } from "./caret";

export interface OverlayTarget {
  nodeId: number;
  password: boolean;
}

export interface PendingEdit {
  /** The iseqs its messages were stamped with. */
  first: number;
  last: number;
  ops: PlanOp[];
  /** Per op, the iseq of the message that has its effect (a key's press, a text). */
  iseqs: number[];
  /** The text it typed, for the chip if it is not delivered. */
  text: string;
  /** Set by a dispatch-only acknowledgement. */
  dispatch?: { deadline: number; hash: string; late?: boolean };
}

/** What the inputlab keeps about single-writer input (window.__mirrorInputLab.proxy). */
export interface ProxyLab {
  /** Event to first frame after the overlay was drawn, ms. */
  echo: number[];
  /** Event to the overlay being in the DOM, ms (inside the handler). */
  echoSync: number[];
  doubleFrames: number;
  /** Frames where the replay and the prediction together did not show what was typed last. */
  gapFrames: number;
  /** Frames where they showed something else (a page's input rule, until its ack). */
  mismatchFrames: number;
  /** Lengths of the runs of such frames, one per run. */
  gapRuns: number[];
  planFallback: number;
  hashMismatch: number;
  late: number;
  failed: number;
  blurs: number;
  reseeds: number;
  ops: number;
  /** Frames sampled by the overlay's own loop. */
  frames: number;
}

export function createProxyLab(): ProxyLab {
  return {
    echo: [],
    echoSync: [],
    doubleFrames: 0,
    gapFrames: 0,
    mismatchFrames: 0,
    gapRuns: [],
    planFallback: 0,
    hashMismatch: 0,
    late: 0,
    failed: 0,
    blurs: 0,
    reseeds: 0,
    ops: 0,
    frames: 0,
  };
}

export interface PredictOverlayOptions {
  /** The viewer document; the layer is appended to its body. */
  doc: Document;
  /** The replay node of a recorder id, in the replay on screen. */
  node(id: number): Node | null;
  rtt(): number | null;
  now?(): number;
  lab?: ProxyLab;
  /** The chip's 「重发」 and 「放回」. */
  resend?(text: string): void;
  putBack?(text: string): void;
}

export interface OverlayState {
  /** iseqs (last of each edit) drawn now. */
  shown: number[];
  /** The newest page-mode acknowledgement settled. */
  settledPage: number;
  /** The text the overlay draws (inserted text and preedit). */
  text: string;
  /** What the person sees in the field: the replay's text with the prediction applied. */
  visible: string | null;
  /** What all edits so far make of the text at the last acknowledgement. */
  intended: string | null;
  pending: number;
  chip: string | null;
}

export interface PredictOverlay {
  setTarget(target: OverlayTarget | null): void;
  target(): OverlayTarget | null;
  push(edit: PendingEdit): void;
  preedit(text: string | null): void;
  settled(ack: SettledAck): void;
  /** The connection went: what was not acknowledged may not have arrived. */
  connectionLost(): void;
  /** A planned edit that could not be sent as keys: offered in the chip. */
  undelivered(text: string, maybe: boolean): void;
  /** Enter's submit guard: the field as the page will hold it once every edit so far arrived. */
  expectFor(): EditExpect | null;
  /** The page's text and caret with every edit applied (null without a target). */
  predicted(): { text: string; caret: number } | null;
  /** The caret where the page's next text goes, for the proxy's own position. */
  caret(): CaretBox | null;
  pending(): number;
  /** The caret the page reported last for the target (offset into its text). */
  lastSelection(): [number, number] | null;
  render(): void;
  state(): OverlayState;
  /** The replay was rebuilt: keep the edits, measure again once it settles. */
  replayChanged(): void;
  clear(): void;
  dispose(): void;
}

/** A replay field's text as the page's hash counts it. */
export function replayFieldText(node: Node): string {
  const element = node as HTMLElement;
  if (isValueField(element)) return normalizeEditableText(element.value ?? "");
  return normalizeEditableText(editableText(element as never));
}

const LAYER_STYLE: Partial<CSSStyleDeclaration> = {
  position: "fixed",
  left: "0px",
  top: "0px",
  width: "0px",
  height: "0px",
  overflow: "visible",
  pointerEvents: "none",
  zIndex: "2147483000",
};

export function createPredictOverlay(options: PredictOverlayOptions): PredictOverlay {
  const now = options.now ?? (() => performance.now());
  const doc = options.doc;
  const layer = doc.createElement("div");
  layer.className = "proxy-predict";
  layer.setAttribute("aria-hidden", "true");
  Object.assign(layer.style, LAYER_STYLE);
  const masks = doc.createElement("div");
  const line = doc.createElement("div");
  const inserted = doc.createElement("span");
  const preeditSpan = doc.createElement("span");
  preeditSpan.style.textDecoration = "underline";
  line.append(inserted, preeditSpan);
  Object.assign(line.style, {
    position: "fixed",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    pointerEvents: "none",
    margin: "0",
    padding: "0",
  });
  const chip = doc.createElement("div");
  Object.assign(chip.style, {
    position: "fixed",
    maxWidth: "min(80vw, 360px)",
    padding: "4px 8px",
    borderRadius: "8px",
    background: "rgba(32,32,32,0.88)",
    color: "#fff",
    font: "13px/1.4 system-ui, sans-serif",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    pointerEvents: "none",
    display: "none",
  });
  const failChip = doc.createElement("div");
  Object.assign(failChip.style, {
    position: "fixed",
    left: "50%",
    bottom: "16px",
    transform: "translateX(-50%)",
    maxWidth: "min(90vw, 420px)",
    padding: "6px 10px",
    borderRadius: "8px",
    background: "#7a2e0e",
    color: "#fff",
    font: "13px/1.4 system-ui, sans-serif",
    pointerEvents: "auto",
    display: "none",
  });
  failChip.className = "proxy-undelivered";
  layer.append(masks, line, chip, failChip);
  doc.body.appendChild(layer);

  let target: OverlayTarget | null = null;
  let edits: PendingEdit[] = [];
  let preedit: string | null = null;
  /** The field's text and caret at the newest page acknowledgement (or when it was targeted). */
  let base: { text: string; caret: number } | null = null;
  let selection: [number, number] | null = null;
  let settledPage = 0;
  let frame: number | null = null;
  let hiddenUntilSettled = false;
  let undelivered: { text: string; maybe: boolean } | null = null;
  let last: OverlayState = {
    shown: [],
    settledPage: 0,
    text: "",
    visible: null,
    intended: null,
    pending: 0,
    chip: null,
  };

  const field = (): HTMLElement | null => {
    if (target === null || target.nodeId < 0) return null;
    const node = options.node(target.nodeId);
    return node !== null && node.nodeType === 1 && (node as Element).isConnected
      ? (node as HTMLElement)
      : null;
  };

  /** The run of edits the replay already shows, and the state after them. */
  const split = (text: string) => {
    if (base !== null) {
      let state = base;
      const states = [state];
      for (const edit of edits) {
        state = applyOps(state, edit.ops);
        states.push(state);
      }
      for (let k = edits.length; k >= 0; k--) {
        if (states[k]!.text === text) return { shown: k, start: states[k]!, intended: state };
      }
      return {
        shown: 0,
        start: { text, caret: Math.min(base.caret, text.length) },
        intended: state,
      };
    }
    const start = { text, caret: text.length };
    let state = start;
    for (const edit of edits) state = applyOps(state, edit.ops);
    return { shown: 0, start, intended: state };
  };

  const hide = () => {
    line.style.display = "none";
    masks.replaceChildren();
    chip.style.display = "none";
  };

  const background = (element: Element): string => {
    let current: Element | null = element;
    while (current !== null) {
      const color = current.ownerDocument.defaultView?.getComputedStyle(current).backgroundColor;
      if (color && color !== "transparent" && !/rgba\(.*,\s*0\)$/.test(color)) return color;
      current = current.parentElement;
    }
    return "#fff";
  };

  const showChip = (text: string, near: HTMLElement | null) => {
    chip.textContent = text;
    chip.style.display = "block";
    let left = 16;
    let top = 16;
    if (near !== null) {
      const box = caretRect(near, 0, doc);
      if (box !== null) {
        left = Math.max(8, box.box.left);
        top = Math.max(8, box.box.top - 32);
      }
    }
    chip.style.left = `${left}px`;
    chip.style.top = `${top}px`;
  };

  const draw = () => {
    const element = field();
    const password = target?.password === true;
    if (target === null) {
      hide();
      last = { ...last, shown: [], text: "", visible: null, intended: null, pending: 0 };
      return;
    }
    const pendingText = edits.map((edit) => edit.text).join("");
    if (element === null) {
      // Cross-origin field, or not in the replay: only the chip can show the prediction.
      const text = (password ? "•".repeat(pendingText.length) : pendingText) + (preedit ?? "");
      if (text === "") hide();
      else showChip(text, null);
      last = {
        shown: edits.flatMap((edit) => edit.iseqs),
        settledPage,
        text,
        visible: null,
        intended: null,
        pending: edits.length,
        chip: text || null,
      };
      return;
    }
    const replayText = replayFieldText(element);
    const { shown, start, intended } = split(replayText);
    const remaining = edits.slice(shown);
    let predicted = start;
    for (const edit of remaining) predicted = applyOps(predicted, edit.ops);
    const { prefix, suffix } = commonEnds(start.text, predicted.text);
    const from = prefix;
    const to = start.text.length - suffix;
    let insert = predicted.text.slice(prefix, predicted.text.length - suffix);
    if (password) insert = "•".repeat(insert.length);
    const drawn =
      insert + (preedit === null ? "" : password ? "•".repeat(preedit.length) : preedit);
    const visible =
      start.text.slice(0, from) +
      predicted.text.slice(prefix, predicted.text.length - suffix) +
      start.text.slice(to);
    last = {
      shown: remaining.flatMap((edit) => edit.iseqs),
      settledPage,
      text: drawn,
      visible,
      intended: intended.text,
      pending: edits.length,
      chip: null,
    };
    if (hiddenUntilSettled || (drawn === "" && from === to)) {
      hide();
      return;
    }
    const caret = caretRect(element, from, doc);
    const late = remaining.some((edit) => edit.dispatch?.late === true);
    if (caret === null || (!isValueField(element) && getComputedDirection(element) === "rtl")) {
      line.style.display = "none";
      masks.replaceChildren();
      showChip(drawn, element);
      last.chip = drawn;
      return;
    }
    chip.style.display = "none";
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    const scale = caret.scale;
    const color = style?.color ?? "#000";
    const fill = background(element);
    // Deleted text: covered with the field's own background.
    const rects = rangeRects(element, from, to, doc);
    masks.replaceChildren(
      ...rects.map((rect) => {
        const mask = doc.createElement("div");
        Object.assign(mask.style, {
          position: "fixed",
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          background: fill,
        });
        return mask;
      }),
    );
    const width = Math.max(1, caret.box.right - caret.box.left);
    Object.assign(line.style, {
      display: drawn === "" ? "none" : "block",
      left: `${caret.box.left}px`,
      top: `${caret.top}px`,
      width: `${width}px`,
      textIndent: `${Math.max(0, caret.left - caret.box.left)}px`,
      fontFamily: style?.fontFamily ?? "inherit",
      fontSize: `${(parseFloat(style?.fontSize ?? "16") || 16) * scale}px`,
      fontWeight: style?.fontWeight ?? "normal",
      fontStyle: style?.fontStyle ?? "normal",
      letterSpacing:
        style?.letterSpacing && style.letterSpacing !== "normal"
          ? `${(parseFloat(style.letterSpacing) || 0) * scale}px`
          : "normal",
      lineHeight: `${caret.height}px`,
      color,
    });
    inserted.textContent = insert;
    inserted.style.background = fill;
    inserted.style.textDecoration = late ? "underline dotted" : "none";
    preeditSpan.textContent =
      password && preedit !== null ? "•".repeat(preedit.length) : (preedit ?? "");
    preeditSpan.style.background = fill;
    // A prediction that runs out of the field is shown in the chip instead.
    if (caret.top + caret.height > caret.box.bottom + caret.height * 4) {
      line.style.display = "none";
      showChip(drawn, element);
      last.chip = drawn;
    }
  };

  const getComputedDirection = (element: Element) =>
    element.ownerDocument.defaultView?.getComputedStyle(element).direction ?? "ltr";

  /** Dispatch-only edits go once the replay's field changed, or after their deadline. */
  const expireDispatched = () => {
    const element = field();
    const hash = element === null ? null : editHash(replayFieldText(element));
    const before = edits.length;
    edits = edits.filter((edit) => {
      if (edit.dispatch === undefined) return true;
      if (hash !== null && hash !== edit.dispatch.hash) return false;
      if (now() < edit.dispatch.deadline) return true;
      if (!edit.dispatch.late) {
        edit.dispatch.late = true;
        options.lab && (options.lab.late += 1);
        return true;
      }
      return false;
    });
    if (edits.length !== before && edits.every((edit) => edit.dispatch === undefined)) rebase();
  };

  /** The replay as it is now becomes the base (nothing is pending against an older one). */
  const rebase = () => {
    const element = field();
    if (element === null) return;
    const text = replayFieldText(element);
    if (edits.length === 0)
      base = { text, caret: Math.min(selection?.[1] ?? base?.caret ?? text.length, text.length) };
  };

  let gapRun = 0;
  const endGapRun = () => {
    if (gapRun === 0 || !options.lab) return;
    options.lab.gapRuns.push(gapRun);
    if (options.lab.gapRuns.length > 10_000) options.lab.gapRuns.shift();
    gapRun = 0;
  };
  const tick = () => {
    frame = null;
    if (options.lab) {
      options.lab.frames += 1;
      if (last.shown.some((iseq) => iseq <= settledPage)) options.lab.doubleFrames += 1;
      const { visible, intended } = last;
      if (preedit === null && visible !== null && intended !== null && visible !== intended) {
        options.lab.mismatchFrames += 1;
        // A gap: what was typed last is missing from the screen (neither replay nor overlay).
        if (intended.startsWith(visible) || (hiddenUntilSettled && edits.length > 0)) {
          options.lab.gapFrames += 1;
          gapRun += 1;
        } else endGapRun();
      } else endGapRun();
    }
    expireDispatched();
    draw();
    schedule();
  };
  const schedule = () => {
    if (frame !== null) return;
    if (edits.length === 0 && preedit === null) {
      endGapRun();
      return;
    }
    frame = doc.defaultView?.requestAnimationFrame(tick) ?? null;
  };

  const renderFailChip = () => {
    if (undelivered === null) {
      failChip.style.display = "none";
      failChip.replaceChildren();
      return;
    }
    const { text, maybe } = undelivered;
    const password = target?.password === true;
    const label = doc.createElement("span");
    label.textContent = password
      ? `未送达 ${[...text].length} 个字符`
      : `${maybe ? "可能未送达" : "未送达"}：${text.length > 60 ? text.slice(0, 60) + "…" : text}`;
    const button = (name: string, action: () => void) => {
      const element = doc.createElement("button");
      element.type = "button";
      element.textContent = name;
      Object.assign(element.style, { marginLeft: "8px", font: "inherit" });
      element.addEventListener("mousedown", (event) => event.preventDefault());
      element.addEventListener("click", () => {
        undelivered = null;
        renderFailChip();
        action();
      });
      return element;
    };
    const buttons = [
      ...(password ? [] : [button("重发", () => options.resend?.(text))]),
      button("放回", () => options.putBack?.(text)),
      button("×", () => undefined),
    ];
    failChip.replaceChildren(label, ...buttons);
    failChip.style.display = "block";
  };

  const overlay: PredictOverlay = {
    setTarget(next) {
      if (next?.nodeId === target?.nodeId && next?.password === target?.password) return;
      target = next;
      selection = null;
      base = null;
      edits = edits.filter(() => next !== null);
      if (next !== null) rebase();
      else {
        // Nothing focused any more: a password's undelivered text is not kept.
        if (undelivered !== null && last.chip === null) renderFailChip();
      }
      draw();
      schedule();
    },
    target: () => target,
    push(edit) {
      edits.push(edit);
      if (options.lab) options.lab.ops += edit.ops.length;
      draw();
      schedule();
    },
    preedit(text) {
      preedit = text === "" ? null : text;
      draw();
      schedule();
    },
    settled(ack) {
      if (ack.failed.length > 0) {
        const failed = edits.filter((edit) =>
          ack.failed.some((iseq) => iseq >= edit.first && iseq <= edit.last),
        );
        // What the page took of a failed edit stays on the page: its text goes to the chip.
        if (failed.length > 0) {
          if (options.lab) options.lab.failed += failed.length;
          edits = edits.filter((edit) => !failed.includes(edit));
          undelivered = { text: failed.map((edit) => edit.text).join(""), maybe: false };
          renderFailChip();
        }
      }
      if (ack.mode === "page") {
        settledPage = Math.max(settledPage, ack.iseq);
        hiddenUntilSettled = false;
        // What the page should hold now, by this viewer's own account: every op whose message
        // the ack covers is on the page (a key's release may not be yet). The replay may already
        // show later ops too (the ack's marker plays after everything the replay was given).
        let expected = base;
        const kept: PendingEdit[] = [];
        for (const edit of edits) {
          const done = edit.iseqs.filter((iseq) => iseq <= ack.iseq).length;
          if (expected !== null && done > 0) expected = applyOps(expected, edit.ops.slice(0, done));
          if (done < edit.ops.length && edit.last > ack.iseq)
            kept.push({ ...edit, ops: edit.ops.slice(done), iseqs: edit.iseqs.slice(done) });
        }
        edits = kept;
        const element = field();
        const text = element === null ? null : replayFieldText(element);
        const edit = ack.edit;
        if (edit && edit.node === target?.nodeId) {
          selection = [edit.sel[0], edit.sel[1]];
          const caretAt = (value: string) => Math.min(edit.sel[1], value.length);
          if (edit.hash === "") {
            // A password: the replay shows a mask, never its text.
            const value = expected?.text ?? text ?? "";
            base = { text: value, caret: caretAt(value) };
          } else if (expected !== null && editHash(expected.text) === edit.hash) {
            base = { text: expected.text, caret: caretAt(expected.text) };
          } else {
            // The page made something else of it (an input rule, a page of its own mind).
            if (options.lab) options.lab.hashMismatch += 1;
            if (text !== null && editHash(text) === edit.hash)
              base = { text, caret: caretAt(text) };
            else if (expected !== null) base = { ...expected, caret: caretAt(expected.text) };
            else if (text !== null) base = { text, caret: caretAt(text) };
          }
        } else if (expected !== null) {
          base = expected;
        } else if (text !== null) {
          base = { text, caret: text.length };
        }
      } else {
        const deadline = now() + Math.max(150, 2 * (options.rtt() ?? 0) + 500);
        const element = field();
        const hash = element === null ? "" : editHash(replayFieldText(element));
        for (const edit of edits)
          if (edit.last <= ack.iseq && edit.dispatch === undefined)
            edit.dispatch = { deadline, hash };
      }
      draw();
      schedule();
    },
    connectionLost() {
      if (edits.length === 0) return;
      undelivered = { text: edits.map((edit) => edit.text).join(""), maybe: true };
      edits = [];
      renderFailChip();
      draw();
    },
    undelivered(text, maybe) {
      if (text === "") return;
      undelivered = { text, maybe };
      renderFailChip();
    },
    expectFor() {
      if (target === null || target.nodeId < 0) return null;
      const element = field();
      if (element === null) return null;
      const { start } = split(replayFieldText(element));
      let state = start;
      for (const edit of edits.slice(split(replayFieldText(element)).shown))
        state = applyOps(state, edit.ops);
      const text = normalizeEditableText(state.text);
      if (target.password)
        return { node: target.nodeId, len: state.text.length, hash: "", head: "" };
      return {
        node: target.nodeId,
        len: text.length,
        hash: editHash(text),
        head: editHash(text.slice(0, Math.max(0, text.length - EXPECT_TAIL))),
      };
    },
    predicted() {
      const element = field();
      if (element === null) return null;
      const { shown, start } = split(replayFieldText(element));
      let state = start;
      for (const edit of edits.slice(shown)) state = applyOps(state, edit.ops);
      return state;
    },
    caret() {
      const element = field();
      if (element === null) return null;
      const state = overlay.predicted();
      return state === null ? null : caretRect(element, state.caret, doc);
    },
    pending: () => edits.length,
    lastSelection: () => selection,
    render: draw,
    state: () => last,
    replayChanged() {
      hiddenUntilSettled = edits.length > 0;
      base = null;
      draw();
    },
    clear() {
      edits = [];
      preedit = null;
      base = null;
      hide();
      last = { ...last, shown: [], text: "", visible: null, intended: null, pending: 0 };
    },
    dispose() {
      overlay.clear();
      if (frame !== null) doc.defaultView?.cancelAnimationFrame(frame);
      frame = null;
      layer.remove();
    },
  };
  return overlay;
}
