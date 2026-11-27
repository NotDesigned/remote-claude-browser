/**
 * Single-writer input: turns an edit of the local proxy (proxy-input.ts) into the presses and text
 * the remote page gets as trusted input. Pure: no DOM.
 *
 * `prev` is what the page holds around its caret as far as the viewer knows (the proxy's model),
 * `next` what the proxy holds now. Their common prefix and suffix leave a deleted range [a, b) of
 * `prev` and an inserted string. The page is told the way a keyboard would tell it: Backspaces up
 * to the caret, Deletes after it, the new text, then arrows to where the proxy's caret ended up.
 * The range is widened to take in the caret, so an edit away from it (autocorrect of the word
 * before, an IME re-composing the previous word) is deleted and typed again from the caret.
 */

export interface ProxyState {
  value: string;
  selStart: number;
  selEnd: number;
}

export type EditKey = "Backspace" | "Delete" | "ArrowLeft" | "ArrowRight";

export type PlanOp =
  /** One press of a key that types nothing. */
  | { t: "press"; key: EditKey }
  /** One grapheme typed by the key just pressed: goes to the page as that key, with its text. */
  | { t: "char"; text: string }
  /** Any other text (an IME's commit, a soft keyboard's word, a paste): Input.insertText. */
  | { t: "insert"; text: string };

/** More presses than this for one edit and the edit is not replayed (the caller falls back). */
export const MAX_PLAN_PRESSES = 48;

type Segmenter = { segment(text: string): Iterable<unknown> };
let segmenter: Segmenter | null | undefined;

/** Grapheme clusters in `text`, by Intl.Segmenter where there is one, else code points. */
export function graphemeCount(text: string): number {
  if (text === "") return 0;
  if (segmenter === undefined) {
    const Intl_ = (globalThis as { Intl?: { Segmenter?: new (...args: unknown[]) => Segmenter } })
      .Intl;
    segmenter =
      Intl_?.Segmenter === undefined
        ? null
        : new Intl_.Segmenter(undefined, { granularity: "grapheme" });
  }
  if (segmenter === null) return [...text].length;
  let count = 0;
  for (const _ of segmenter.segment(text)) count++;
  return count;
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The common prefix and suffix of a and b, never splitting a surrogate pair. */
export function commonEnds(a: string, b: string): { prefix: number; suffix: number } {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  // The prefix is the same in both: ending on a high half splits a pair.
  if (prefix > 0 && isHigh(a.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
  )
    suffix++;
  // Starting on a low half splits a pair whose high halves differ (or lie in the prefix).
  if (suffix > 0 && isLow(a.charCodeAt(a.length - suffix))) suffix--;
  return { prefix, suffix };
}

/**
 * The ops that make the page's text go from `prev` to `next`, or "fallback" when the edit cannot
 * be told as a keyboard would (too far from the caret, or a selection the page may not have).
 * `lastKey` is the printable key pressed just before this edit, if any.
 */
export function planEdit(
  prev: ProxyState,
  next: ProxyState,
  lastKey?: string,
): PlanOp[] | "fallback" {
  if (prev.value === next.value) return [];
  const { prefix, suffix } = commonEnds(prev.value, next.value);
  let a = prefix;
  let b = prev.value.length - suffix;
  let inserted = next.value.slice(prefix, next.value.length - suffix);
  const ops: PlanOp[] = [];
  let presses = 0;
  const press = (key: EditKey, count: number) => {
    for (let index = 0; index < count; index++) ops.push({ t: "press", key });
    presses += count;
  };

  if (prev.selStart !== prev.selEnd) {
    // The page has this selection too (the proxy was seeded with it): what replaces it exactly
    // is typed over it; anything else cannot be told.
    const [start, end] = [
      Math.min(prev.selStart, prev.selEnd),
      Math.max(prev.selStart, prev.selEnd),
    ];
    if (a < start || b > end) return "fallback";
    inserted = prev.value.slice(start, a) + inserted + prev.value.slice(b, end);
    a = start;
    b = end;
    // Typing over a selection replaces it; deleting it is one press.
    if (inserted === "") press("Backspace", 1);
    else ops.push(textOp(inserted, lastKey));
    return finish(ops, presses, a + inserted.length, next);
  }

  const caret = Math.max(0, Math.min(prev.selStart, prev.value.length));
  const from = Math.min(a, caret);
  const to = Math.max(b, caret);
  inserted = prev.value.slice(from, a) + inserted + prev.value.slice(b, to);
  press("Backspace", graphemeCount(prev.value.slice(from, caret)));
  press("Delete", graphemeCount(prev.value.slice(caret, to)));
  if (inserted !== "") ops.push(textOp(inserted, lastKey));
  return finish(ops, presses, from + inserted.length, next);
}

/** The arrows that take the page's caret from `at` to where the proxy's caret is. */
function finish(
  ops: PlanOp[],
  presses: number,
  at: number,
  next: ProxyState,
): PlanOp[] | "fallback" {
  const target = Math.max(0, Math.min(next.selEnd, next.value.length));
  if (target < at) {
    const count = graphemeCount(next.value.slice(target, at));
    for (let index = 0; index < count; index++) ops.push({ t: "press", key: "ArrowLeft" });
    presses += count;
  } else if (target > at) {
    const count = graphemeCount(next.value.slice(at, target));
    for (let index = 0; index < count; index++) ops.push({ t: "press", key: "ArrowRight" });
    presses += count;
  }
  return presses > MAX_PLAN_PRESSES ? "fallback" : ops;
}

function textOp(text: string, lastKey: string | undefined): PlanOp {
  return lastKey !== undefined && text === lastKey && graphemeCount(text) === 1
    ? { t: "char", text }
    : { t: "insert", text };
}

/** Applies ops to a text and caret as the page would (a press per grapheme). */
export function applyOps(
  state: { text: string; caret: number; anchor?: number },
  ops: readonly PlanOp[],
): { text: string; caret: number } {
  let { text, caret } = state;
  caret = Math.max(0, Math.min(caret, text.length));
  // A selection (anchor to caret): the first op replaces it, deletes it or collapses it.
  let anchor =
    state.anchor === undefined ? caret : Math.max(0, Math.min(state.anchor, text.length));
  for (const op of ops) {
    if (anchor !== caret) {
      const [from, to] = [Math.min(anchor, caret), Math.max(anchor, caret)];
      anchor = caret;
      if (op.t === "press" && (op.key === "ArrowLeft" || op.key === "ArrowRight")) {
        caret = anchor = op.key === "ArrowLeft" ? from : to;
        continue;
      }
      text = text.slice(0, from) + text.slice(to);
      caret = anchor = from;
      if (op.t === "press") continue;
    }
    if (op.t === "press") {
      if (op.key === "Backspace" || op.key === "ArrowLeft") {
        const step = previousGrapheme(text, caret);
        if (op.key === "Backspace") text = text.slice(0, caret - step) + text.slice(caret);
        caret -= step;
      } else {
        const step = nextGrapheme(text, caret);
        if (op.key === "Delete") text = text.slice(0, caret) + text.slice(caret + step);
        else caret += step;
      }
    } else {
      text = text.slice(0, caret) + op.text + text.slice(caret);
      caret += op.text.length;
    }
    anchor = caret;
  }
  return { text, caret };
}

/** Code units of the grapheme before `at` (0 at the start). */
export function previousGrapheme(text: string, at: number): number {
  if (at <= 0) return 0;
  const before = text.slice(Math.max(0, at - 64), at);
  const last = lastSegment(before);
  return last === 0 ? 0 : last;
}

/** Code units of the grapheme after `at` (0 at the end). */
export function nextGrapheme(text: string, at: number): number {
  if (at >= text.length) return 0;
  return firstSegment(text.slice(at, at + 64));
}

function segments(text: string): string[] {
  graphemeCount("x");
  if (segmenter) {
    const out: string[] = [];
    for (const part of segmenter.segment(text) as Iterable<{ segment: string }>)
      out.push(part.segment);
    return out;
  }
  return [...text];
}

function lastSegment(text: string): number {
  const parts = segments(text);
  return parts.length === 0 ? 0 : parts[parts.length - 1]!.length;
}

function firstSegment(text: string): number {
  const parts = segments(text);
  return parts.length === 0 ? 0 : parts[0]!.length;
}
