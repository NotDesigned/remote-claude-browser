/**
 * Single-writer input: where a caret key, a double or triple press puts the selection, predicted
 * here so that the replay shows it at once (proxy-input.ts draws it through the prediction
 * overlay). The page decides for itself: its acknowledgement brings where the selection really
 * is, which replaces the prediction. Pure: no DOM (lines on screen come from `vertical`).
 */
import { nextGrapheme, previousGrapheme } from "./proxy-plan";

/** A selection as offsets into a field's text: the anchor stays, the head moves. */
export interface Sel {
  anchor: number;
  head: number;
}

export interface CaretKey {
  key: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

export type Platform = "mac" | "windows" | "other";

export function platformOf(
  navigator: { platform?: string; userAgent?: string } | undefined,
): Platform {
  const name = `${navigator?.platform ?? ""} ${navigator?.userAgent ?? ""}`;
  if (/Mac|iPhone|iPad|iPod/i.test(name)) return "mac";
  if (/Win/i.test(name)) return "windows";
  return "other";
}

type WordSegmenter = {
  segment(text: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }>;
};
let wordSegmenter: WordSegmenter | null | undefined;
function words(text: string): Array<{ start: number; end: number; word: boolean }> {
  if (wordSegmenter === undefined) {
    const Intl_ = (
      globalThis as { Intl?: { Segmenter?: new (...args: unknown[]) => WordSegmenter } }
    ).Intl;
    wordSegmenter =
      Intl_?.Segmenter === undefined
        ? null
        : new Intl_.Segmenter(undefined, { granularity: "word" });
  }
  const out: Array<{ start: number; end: number; word: boolean }> = [];
  if (wordSegmenter !== null) {
    for (const part of wordSegmenter.segment(text))
      out.push({
        start: part.index,
        end: part.index + part.segment.length,
        word: part.isWordLike ?? /\w/.test(part.segment),
      });
    return out;
  }
  const pattern = /\w+|\s+|[^\w\s]+/gu;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text))
    out.push({ start: match.index, end: match.index + match[0].length, word: /\w/.test(match[0]) });
  return out;
}

/** The word (or the run of spaces or punctuation) at `offset`, as a double press selects it. */
export function wordAt(text: string, offset: number): Sel {
  const at = Math.max(0, Math.min(offset, text.length));
  const parts = words(text);
  const inside =
    parts.find((part) => part.start <= at && at < part.end && part.word) ??
    parts.find((part) => part.start < at && at <= part.end && part.word) ??
    parts.find((part) => part.start <= at && at < part.end);
  return inside === undefined
    ? { anchor: at, head: at }
    : { anchor: inside.start, head: inside.end };
}

/** The line (between line breaks) at `offset`, as a triple press selects it. */
export function lineAt(text: string, offset: number): Sel {
  const at = Math.max(0, Math.min(offset, text.length));
  const start = text.lastIndexOf("\n", at - 1) + 1;
  const newline = text.indexOf("\n", at);
  return { anchor: start, head: newline < 0 ? text.length : newline };
}

/** Where Ctrl/Alt+arrow takes the caret: the start of the word before, or past the word after. */
export function wordStep(text: string, at: number, forward: boolean, platform: Platform): number {
  const parts = words(text);
  if (!forward) {
    for (let index = parts.length - 1; index >= 0; index--) {
      const part = parts[index]!;
      if (part.word && part.start < at) return part.start;
    }
    return 0;
  }
  for (const part of parts) {
    if (!part.word || part.end <= at) continue;
    if (platform !== "windows") return part.end;
    if (part.start > at) return part.start;
  }
  return text.length;
}

/**
 * The selection after a caret key, or null when it is not predicted here (the page's answer
 * places it). `vertical` finds the offset a line up or down on screen (null: not measurable).
 */
export function moveSelection(
  text: string,
  sel: Sel,
  key: CaretKey,
  platform: Platform,
  vertical?: (head: number, direction: -1 | 1) => number | null,
): Sel | null {
  const length = text.length;
  const head = Math.max(0, Math.min(sel.head, length));
  const anchor = Math.max(0, Math.min(sel.anchor, length));
  const mac = platform === "mac";
  const word = mac ? key.alt && !key.meta && !key.ctrl : key.ctrl && !key.alt;
  const lineKey = mac && key.meta && !key.ctrl;
  const collapsed = anchor === head;
  const line = lineAt(text, head);
  let target: number;
  switch (key.key) {
    case "ArrowLeft":
    case "ArrowRight": {
      const forward = key.key === "ArrowRight";
      if (key.alt && !mac) return null; // Alt+arrow is history navigation.
      if (lineKey) target = forward ? line.head : line.anchor;
      else if (word) target = wordStep(text, head, forward, platform);
      else if (!key.shift && !collapsed)
        target = forward ? Math.max(anchor, head) : Math.min(anchor, head);
      else target = forward ? head + nextGrapheme(text, head) : head - previousGrapheme(text, head);
      break;
    }
    case "Home":
    case "End": {
      const end = key.key === "End";
      if (mac && !key.ctrl && !key.meta) return null; // scrolls on a Mac
      target = key.ctrl || key.meta ? (end ? length : 0) : end ? line.head : line.anchor;
      break;
    }
    case "ArrowUp":
    case "ArrowDown": {
      const down = key.key === "ArrowDown";
      if (key.alt && !mac) return null;
      if (lineKey || (mac && key.alt)) {
        target = down ? length : 0;
        break;
      }
      if (key.ctrl) return null;
      const measured = vertical?.(head, down ? 1 : -1) ?? null;
      if (measured !== null) target = measured;
      else if (!down && line.anchor === 0) target = 0;
      else if (down && line.head === length) target = length;
      else {
        const column = head - line.anchor;
        const next = down ? lineAt(text, line.head + 1) : lineAt(text, line.anchor - 1);
        target = Math.min(next.anchor + column, next.head);
      }
      break;
    }
    default:
      return null;
  }
  target = Math.max(0, Math.min(target, length));
  return key.shift ? { anchor, head: target } : { anchor: target, head: target };
}
