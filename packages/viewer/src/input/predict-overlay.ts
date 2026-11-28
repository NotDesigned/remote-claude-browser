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
import {
  caretRect,
  isValueField,
  localCaret,
  offsetAtPoint,
  rangeRects,
  selectionRects,
  type CaretBox,
} from "./caret";

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
  /** Measurement (caret.ts); replaced in tests. */
  measure?: {
    caret: typeof caretRect;
    rects: typeof rangeRects;
    selection?: typeof selectionRects;
    /** Where offset `offset` of a span of the prediction line is (viewer coordinates). */
    span?(span: HTMLElement, offset: number): { left: number; top: number; height: number } | null;
  };
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
  /**
   * A predicted selection (a caret key, a press, a drag) until the ack of input `iseq` says where
   * the page has it. One right after another for the same input replaces it (a drag's moves).
   */
  select(anchor: number, head: number, iseq: number): void;
  preedit(text: string | null): void;
  settled(ack: SettledAck): void;
  /** The connection went: what was not acknowledged may not have arrived. */
  connectionLost(): void;
  /** A planned edit that could not be sent as keys: offered in the chip. */
  undelivered(text: string, maybe: boolean): void;
  /** Enter's submit guard: the field as the page will hold it once every edit so far arrived. */
  expectFor(): EditExpect | null;
  /** The page's text and selection with every edit applied (null without a target). */
  predicted(): { text: string; caret: number; anchor: number } | null;
  /** The caret where the page's next text goes, for the proxy's own position. */
  caret(): CaretBox | null;
  /** The proxy has focus: the caret and selection are drawn (and kept measured). */
  setFocused(focused: boolean): void;
  /**
   * The offset a line up or down from `head` on screen, keeping its x (null: not measurable, or
   * no line there; also while text typed is not in the replay yet).
   */
  vertical(head: number, direction: -1 | 1): number | null;
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

/** The selection highlight drawn over a replay field. */
const SELECTION_COLOR = "rgba(0, 117, 255, 0.3)";
/** While the proxy has focus and nothing is pending, the caret is measured again this often. */
export const IDLE_REDRAW_MS = 120;

/** The caret's blink, once per document. */
function ensureCaretStyle(doc: Document): void {
  if (typeof doc.querySelector !== "function") return; // a test DOM
  if (doc.querySelector("style[data-proxy-caret]") !== null) return;
  const style = doc.createElement("style");
  style.setAttribute("data-proxy-caret", "true");
  style.textContent =
    "@keyframes proxy-caret-blink{0%{opacity:1}50%{opacity:0}}" +
    ".proxy-caret{animation:proxy-caret-blink 1.06s steps(1,end) 0.5s infinite}" +
    "@media (prefers-reduced-motion: reduce){.proxy-caret{animation:none}}";
  (doc.head ?? doc.body).appendChild(style);
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
  const measureCaret = options.measure?.caret ?? caretRect;
  const measureRects = options.measure?.rects ?? rangeRects;
  const measureSelection = options.measure?.selection ?? selectionRects;
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
  // The replay's fields never take focus (read-only.ts), so nothing draws their caret or
  // selection: the overlay does, at the selection the page reported with the predictions applied.
  const highlight = doc.createElement("div");
  highlight.className = "proxy-selection";
  const caretMark = doc.createElement("div");
  caretMark.className = "proxy-caret";
  Object.assign(caretMark.style, { position: "fixed", display: "none", pointerEvents: "none" });
  ensureCaretStyle(doc);
  layer.append(highlight, masks, line, caretMark, chip, failChip);
  doc.body.appendChild(layer);

  let target: OverlayTarget | null = null;
  /** The proxy has focus: the caret and selection are drawn. */
  let focused = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let caretBox: CaretBox | null = null;
  let caretKey = "";
  let edits: PendingEdit[] = [];
  let preedit: string | null = null;
  /** The field's text and caret at the newest page acknowledgement (or when it was targeted). */
  let base: { text: string; caret: number; anchor?: number } | null = null;
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
        start: {
          text,
          caret: Math.min(base.caret, text.length),
          anchor: Math.min(base.anchor ?? base.caret, text.length),
        },
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
      const box = measureCaret(near, 0, doc);
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
      hideCaret();
      caretBox = null;
      hide();
      last = { ...last, shown: [], text: "", visible: null, intended: null, pending: 0 };
      return;
    }
    const pendingText = edits.map((edit) => edit.text).join("");
    if (element === null) {
      // Cross-origin field, or not in the replay: only the chip can show the prediction.
      const text = (password ? "•".repeat(pendingText.length) : pendingText) + (preedit ?? "");
      hideCaret();
      caretBox = null;
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
    const insertLength = predicted.text.length - suffix - prefix;
    if (hiddenUntilSettled) {
      hide();
      hideCaret();
      return;
    }
    if (drawn === "" && from === to) {
      hide();
      drawCaret(element, start, predicted, from, insertLength, false);
      return;
    }
    const caret = measureCaret(element, from, doc);
    const late = remaining.some((edit) => edit.dispatch?.late === true);
    if (caret === null || (!isValueField(element) && getComputedDirection(element) === "rtl")) {
      line.style.display = "none";
      masks.replaceChildren();
      showChip(drawn, element);
      last.chip = drawn;
      drawCaret(element, start, predicted, from, insertLength, false);
      return;
    }
    chip.style.display = "none";
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    const scale = caret.scale;
    const color = style?.color ?? "#000";
    const fill = background(element);
    // Deleted text: covered with the field's own background.
    const rects = measureRects(element, from, to, doc);
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
    drawCaret(element, start, predicted, from, insertLength, line.style.display !== "none");
  };

  const hideCaret = () => {
    caretMark.style.display = "none";
    highlight.replaceChildren();
    highlight.setAttribute("data-selected", "");
    caretKey = "";
  };

  /** The caret at `offset` of a span of the prediction line (null: not measurable). */
  const spanCaret = (span: HTMLElement, offset: number, near: CaretBox): CaretBox | null => {
    if (options.measure?.span !== undefined) {
      const at = options.measure.span(span, offset);
      return at === null ? null : { ...at, box: near.box, scale: near.scale };
    }
    const node = span.firstChild;
    if (!node || node.nodeType !== 3) return null;
    try {
      const range = doc.createRange();
      range.setStart(node, offset);
      range.collapse(true);
      let rect: DOMRect | undefined = [...range.getClientRects()].find((r) => r.height > 0);
      let left = rect?.left;
      if (rect === undefined && offset > 0) {
        range.setStart(node, offset - 1);
        range.setEnd(node, offset);
        rect = [...range.getClientRects()].filter((r) => r.height > 0).at(-1);
        left = rect?.right;
      }
      if (rect === undefined || left === undefined) return null;
      return { left, top: rect.top, height: rect.height, box: near.box, scale: near.scale };
    } catch {
      return null;
    }
  };

  /**
   * The caret and selection, where the page reported them with every prediction applied: in the
   * prediction line for a caret inside text not in the replay yet, else in the replay's field (an
   * offset after the predicted text maps back to where the replay has it).
   */
  const drawCaret = (
    element: HTMLElement,
    start: { text: string },
    predicted: { text: string; caret: number; anchor?: number },
    from: number,
    insertLength: number,
    lineShown: boolean,
  ) => {
    const head = predicted.caret;
    const anchor = predicted.anchor ?? head;
    const delta = predicted.text.length - start.text.length;
    const toReplay = (offset: number) =>
      offset <= from
        ? offset
        : offset >= from + insertLength
          ? Math.max(from, offset - delta)
          : from;
    let box: CaretBox | null = null;
    if (lineShown) {
      const near = measureCaret(element, from, doc);
      if (near !== null && preedit !== null && preeditSpan.textContent !== "")
        box = spanCaret(preeditSpan, preeditSpan.textContent!.length, near);
      else if (near !== null && insertLength > 0 && head >= from && head <= from + insertLength)
        box = head === from ? near : spanCaret(inserted, head - from, near);
    }
    box ??= measureCaret(element, toReplay(head), doc);
    caretBox = box;
    if (!focused || box === null) {
      hideCaret();
      return;
    }
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (anchor === head || (preedit !== null && preedit !== "")) {
      const width = Math.max(1, Math.round(box.scale * 1.5));
      const caretColor = style?.caretColor;
      const color =
        caretColor && caretColor !== "auto" && !/rgba\(.*,\s*0\)$/.test(caretColor)
          ? caretColor
          : (style?.color ?? "#000");
      const left = box.left - width / 2;
      Object.assign(caretMark.style, {
        display: "block",
        left: `${left}px`,
        top: `${box.top}px`,
        width: `${width}px`,
        height: `${box.height}px`,
        background: color,
      });
      const key = `${left},${box.top},${box.height}`;
      if (key !== caretKey) {
        // A caret that moved shows at once, then blinks again.
        caretKey = key;
        caretMark.style.animation = "none";
        void caretMark.offsetWidth;
        caretMark.style.animation = "";
      }
    } else {
      caretMark.style.display = "none";
      caretKey = "";
    }
    if (anchor !== head) {
      const lo = Math.min(anchor, head);
      const hi = Math.max(anchor, head);
      const rects = measureSelection(element, toReplay(lo), toReplay(hi), doc);
      highlight.replaceChildren(
        ...rects.map((rect) => {
          const mark = doc.createElement("div");
          Object.assign(mark.style, {
            position: "fixed",
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            background: SELECTION_COLOR,
          });
          return mark;
        }),
      );
      highlight.setAttribute("data-selected", target?.password ? "" : predicted.text.slice(lo, hi));
    } else {
      highlight.replaceChildren();
      highlight.setAttribute("data-selected", "");
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
    if (edits.length === 0) {
      const caret = Math.min(selection?.[1] ?? base?.caret ?? text.length, text.length);
      const anchor = Math.min(selection?.[0] ?? base?.anchor ?? caret, text.length);
      base = { text, caret, anchor };
    }
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
      // Nothing pending: the caret still follows the replay (a page scrolling, a field growing).
      if (focused && target !== null && idleTimer === null)
        idleTimer = setTimeout(() => {
          idleTimer = null;
          if (frame !== null) return;
          draw();
          schedule();
        }, IDLE_REDRAW_MS);
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
    select(anchor, head, iseq) {
      const op = { t: "select" as const, anchor, head };
      const previous = edits.at(-1);
      if (
        previous !== undefined &&
        previous.last === iseq &&
        previous.ops.length === 1 &&
        previous.ops[0]!.t === "select"
      )
        previous.ops = [op];
      else edits.push({ first: iseq, last: iseq, ops: [op], iseqs: [iseq], text: "" });
      draw();
      schedule();
    },
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
          const caretAt = (value: string) => ({
            caret: Math.min(edit.sel[1], value.length),
            anchor: Math.min(edit.sel[0], value.length),
          });
          if (edit.hash === "") {
            // A password: the replay shows a mask, never its text.
            const value = expected?.text ?? text ?? "";
            base = { text: value, ...caretAt(value) };
          } else if (expected !== null && editHash(expected.text) === edit.hash) {
            base = { text: expected.text, ...caretAt(expected.text) };
          } else {
            // The page made something else of it (an input rule, a page of its own mind).
            if (options.lab) options.lab.hashMismatch += 1;
            if (text !== null && editHash(text) === edit.hash) base = { text, ...caretAt(text) };
            else if (expected !== null) base = { ...expected, ...caretAt(expected.text) };
            else if (text !== null) base = { text, ...caretAt(text) };
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
      let state: { text: string; caret: number; anchor?: number } = start;
      for (const edit of edits.slice(shown)) state = applyOps(state, edit.ops);
      return { text: state.text, caret: state.caret, anchor: state.anchor ?? state.caret };
    },
    caret() {
      if (caretBox !== null) return caretBox;
      const element = field();
      if (element === null) return null;
      const state = overlay.predicted();
      return state === null ? null : measureCaret(element, state.caret, doc);
    },
    setFocused(next) {
      if (focused === next) return;
      focused = next;
      if (!focused && idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      draw();
      schedule();
    },
    vertical(head, direction) {
      const element = field();
      const state = overlay.predicted();
      if (element === null || state === null || state.text !== replayFieldText(element))
        return null;
      try {
        const at = localCaret(element, head);
        if (at === null || at.height <= 0) return null;
        const y = direction < 0 ? at.top - at.height / 2 : at.top + at.height * 1.5;
        const rect = element.getBoundingClientRect();
        if (y < rect.top || y > rect.bottom) return null;
        return offsetAtPoint(element, at.left, y);
      } catch {
        // A field that cannot be laid out (gone, or not a real DOM).
        return null;
      }
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
      hideCaret();
      last = { ...last, shown: [], text: "", visible: null, intended: null, pending: 0 };
    },
    dispose() {
      overlay.clear();
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = null;
      if (frame !== null) doc.defaultView?.cancelAnimationFrame(frame);
      frame = null;
      layer.remove();
    },
  };
  return overlay;
}
