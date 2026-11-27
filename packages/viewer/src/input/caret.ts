/**
 * Where a replay field's caret is, in the viewer's own coordinates (single-writer input).
 *
 * The replay is an iframe (possibly scaled, possibly with frames inside it); the prediction
 * overlay and the proxy input live in the viewer document above it. An editing host is measured
 * with a Range at editablePoint; a text input or textarea, whose text a Range cannot reach, with a
 * clone that copies its box and font, measured and removed again in the same task.
 */
import { editablePoint as protocolPoint, type EditableTextNode } from "@mirror/protocol";

/** editablePoint over real DOM nodes. */
function editablePoint(
  root: HTMLElement,
  offset: number,
): { container: Node; offset: number } | null {
  const point = protocolPoint(root as unknown as EditableTextNode, offset);
  return point === null
    ? null
    : { container: point.container as unknown as Node, offset: point.offset };
}

export interface CaretBox {
  /** The caret, in viewer client coordinates. */
  left: number;
  top: number;
  height: number;
  /** The field's content box, in viewer client coordinates. */
  box: { left: number; top: number; right: number; bottom: number };
  /** Replay CSS pixels to viewer pixels. */
  scale: number;
}

/** The ratio of painted to layout size of each frame from `doc` up to `top`, and its offset. */
export function frameTransform(
  doc: Document,
  top: Document,
): { x: number; y: number; scale: number } | null {
  let x = 0;
  let y = 0;
  let scale = 1;
  let current = doc;
  const seen = new Set<Document>();
  while (current !== top) {
    if (seen.has(current)) return null;
    seen.add(current);
    let frame: Element | null;
    try {
      frame = current.defaultView?.frameElement ?? null;
    } catch {
      return null;
    }
    if (frame === null) return null;
    const rect = frame.getBoundingClientRect();
    const layout = frame as HTMLElement;
    const ratio = layout.offsetWidth > 0 ? rect.width / layout.offsetWidth : 1;
    x = rect.left + (x + layout.clientLeft) * ratio;
    y = rect.top + (y + layout.clientTop) * ratio;
    scale *= ratio;
    current = frame.ownerDocument;
  }
  // x, y map (0, 0) of `doc`; a point p maps to (x + p * scale).
  return { x, y, scale };
}

/** Maps a rect in `doc`'s client coordinates to `top`'s. */
function mapper(doc: Document, top: Document) {
  const transform = frameTransform(doc, top);
  if (transform === null) return null;
  return {
    scale: transform.scale,
    x: (value: number) => transform.x + value * transform.scale,
    y: (value: number) => transform.y + value * transform.scale,
  };
}

const COPIED_STYLES = [
  "boxSizing",
  "width",
  "height",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderTopStyle",
  "borderRightStyle",
  "borderBottomStyle",
  "borderLeftStyle",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontWeight",
  "fontVariant",
  "fontStretch",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "tabSize",
  "direction",
  "overflowWrap",
  "wordBreak",
] as const;

/** The caret in a text input or textarea at `offset` of its value, in its own document. */
function valueCaret(
  field: HTMLInputElement | HTMLTextAreaElement,
  offset: number,
): { left: number; top: number; height: number } | null {
  const doc = field.ownerDocument;
  const view = doc.defaultView;
  const host = doc.documentElement;
  if (view === null || host === null) return null;
  const style = view.getComputedStyle(field);
  const clone = doc.createElement("div");
  for (const name of COPIED_STYLES) clone.style[name] = style[name];
  const textarea = field.tagName.toLowerCase() === "textarea";
  Object.assign(clone.style, {
    position: "absolute",
    visibility: "hidden",
    top: "0px",
    left: "-9999px",
    overflow: "hidden",
    whiteSpace: textarea ? "pre-wrap" : "pre",
  });
  const value = field.type === "password" ? "•".repeat(field.value.length) : field.value;
  const before = doc.createTextNode(value.slice(0, offset));
  const marker = doc.createElement("span");
  marker.textContent = value.slice(offset) || ".";
  clone.append(before, marker);
  host.appendChild(clone);
  try {
    const cloneRect = clone.getBoundingClientRect();
    const markerRect = marker.getClientRects()[0] ?? marker.getBoundingClientRect();
    const fieldRect = field.getBoundingClientRect();
    return {
      left: fieldRect.left + (markerRect.left - cloneRect.left) - field.scrollLeft,
      top: fieldRect.top + (markerRect.top - cloneRect.top) - field.scrollTop,
      height: markerRect.height || parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2,
    };
  } finally {
    clone.remove();
  }
}

/** The caret in an editing host at `offset` of editableText(host), in its own document. */
function editableCaret(
  host: HTMLElement,
  offset: number,
): { left: number; top: number; height: number } | null {
  const point = editablePoint(host, offset);
  if (point === null) return null;
  const doc = host.ownerDocument;
  const range = doc.createRange();
  const container = point.container;
  try {
    range.setStart(container, point.offset);
    range.collapse(true);
  } catch {
    return null;
  }
  const rect = firstRect(range);
  if (rect !== null) return { left: rect.left, top: rect.top, height: rect.height };
  // A collapsed range at an element boundary or in an empty line often has no rect: use the
  // character before or after it, or the line's own element.
  if (container.nodeType === 3) {
    const length = container.textContent?.length ?? 0;
    if (point.offset > 0) {
      range.setStart(container, point.offset - 1);
      range.setEnd(container, point.offset);
      const before = lastRect(range);
      if (before !== null) return { left: before.right, top: before.top, height: before.height };
    }
    if (point.offset < length) {
      range.setStart(container, point.offset);
      range.setEnd(container, point.offset + 1);
      const after = firstRect(range);
      if (after !== null) return { left: after.left, top: after.top, height: after.height };
    }
  }
  const element = (
    container.nodeType === 1 ? container : container.parentElement
  ) as Element | null;
  if (element === null) return null;
  const box = element.getBoundingClientRect();
  const view = doc.defaultView;
  const style = view?.getComputedStyle(element);
  const padLeft = style ? parseFloat(style.paddingLeft) || 0 : 0;
  const padTop = style ? parseFloat(style.paddingTop) || 0 : 0;
  const line = style
    ? parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 16) * 1.2
    : 16;
  return { left: box.left + padLeft, top: box.top + padTop, height: line };
}

function firstRect(range: Range): DOMRect | null {
  for (const rect of range.getClientRects()) if (rect.height > 0) return rect;
  return null;
}
function lastRect(range: Range): DOMRect | null {
  const rects = [...range.getClientRects()].filter((rect) => rect.height > 0);
  return rects[rects.length - 1] ?? null;
}

/** The field's content box in its own document. */
function contentBox(field: HTMLElement) {
  const rect = field.getBoundingClientRect();
  const style = field.ownerDocument.defaultView?.getComputedStyle(field);
  const px = (value: string | undefined) => (value ? parseFloat(value) || 0 : 0);
  return {
    left: rect.left + px(style?.borderLeftWidth) + px(style?.paddingLeft),
    top: rect.top + px(style?.borderTopWidth) + px(style?.paddingTop),
    right: rect.right - px(style?.borderRightWidth) - px(style?.paddingRight),
    bottom: rect.bottom - px(style?.borderBottomWidth) - px(style?.paddingBottom),
  };
}

export function isValueField(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  const tag = element.tagName.toLowerCase();
  return tag === "textarea" || tag === "input";
}

/**
 * The caret of `field` (a replay text field or editing host) at `offset` of its text, in the
 * coordinates of `top` (the viewer document). Null when it cannot be measured (a detached field,
 * a frame not reachable from here, nothing laid out).
 */
export function caretRect(field: HTMLElement, offset: number, top: Document): CaretBox | null {
  if (!field.isConnected) return null;
  const map = mapper(field.ownerDocument, top);
  if (map === null) return null;
  const local = isValueField(field) ? valueCaret(field, offset) : editableCaret(field, offset);
  if (local === null) return null;
  const box = contentBox(field);
  if (box.right <= box.left && local.height <= 0) return null;
  return {
    left: map.x(local.left),
    top: map.y(local.top),
    height: local.height * map.scale,
    box: {
      left: map.x(box.left),
      top: map.y(box.top),
      right: map.x(box.right),
      bottom: map.y(box.bottom),
    },
    scale: map.scale,
  };
}

/** Rects covering [from, to) of an editing host's text, in viewer coordinates (deletion masks). */
export function rangeRects(field: HTMLElement, from: number, to: number, top: Document): DOMRect[] {
  if (isValueField(field) || from >= to) return [];
  const map = mapper(field.ownerDocument, top);
  if (map === null) return [];
  const start = editablePoint(field, from);
  const end = editablePoint(field, to);
  if (start === null || end === null) return [];
  const range = field.ownerDocument.createRange();
  try {
    range.setStart(start.container, start.offset);
    range.setEnd(end.container, end.offset);
  } catch {
    return [];
  }
  return [...range.getClientRects()]
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map(
      (rect) =>
        new DOMRect(
          map.x(rect.left),
          map.y(rect.top),
          rect.width * map.scale,
          rect.height * map.scale,
        ),
    );
}
