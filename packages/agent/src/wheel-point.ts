/**
 * Where the gateway's trusted wheel for a scroll up should go, decided from the page's live
 * position (hardening; gateway/src/input/scroll-announce.ts sends it).
 *
 * The page's own scroll position is the only authority: a scroll that is not at least
 * SCROLL_UP_MIN_PX above where the scroller is now gets no wheel, however the viewer's earlier
 * reports went (the page may have followed its end since, or this is another document).
 *
 * Chromium hands a real wheel to the innermost element under its point that can scroll that way,
 * so the point must hit-test to the scroller itself, or to something inside it that does not
 * scroll vertically and is not fixed to the viewport, and never into a frame. The visible part of
 * the scroller is searched, centre first; when no point qualifies there is no wheel.
 */

/** Rounding in the mirror moves it this far without anyone scrolling. */
export const SCROLL_UP_MIN_PX = 3;
/** The gateway's wheel for a scroll up is at most one notch. */
export const WHEEL_MAX_PX = 120;

export interface WheelPoint {
  /** In the top-level viewport (same-origin frames are added in), or this frame's for an OOPIF. */
  x: number;
  y: number;
  /** How far up the wheel should go: at most one notch. */
  dy: number;
  /** The page runs as a phone (coarse pointer, touch): a touch scroll fits it better than a wheel. */
  touch?: true;
}

export interface WheelPointDom {
  /** The topmost element at the point, as `root` sees it. */
  hit(root: Document | ShadowRoot, x: number, y: number): Element | null;
  style(element: Element): CSSStyleDeclaration;
  /** Where (x, y) of `document`'s viewport is in the top-level viewport. */
  toRoot(x: number, y: number, document: Document): { x: number; y: number };
  touch(document: Document): boolean;
}

/** Captured when the agent starts, so a page that wraps them later does not see the agent call. */
const nativeDocumentHit =
  typeof Document === "undefined" ? undefined : Document.prototype.elementFromPoint;
const nativeShadowHit =
  typeof ShadowRoot === "undefined" ? undefined : ShadowRoot.prototype.elementFromPoint;
const nativeComputedStyle = typeof getComputedStyle === "undefined" ? undefined : getComputedStyle;
const nativeMatchMedia = typeof matchMedia === "undefined" ? undefined : matchMedia;

function defaultHit(root: Document | ShadowRoot, x: number, y: number): Element | null {
  const isShadow = root.nodeType === 11;
  const native = isShadow ? nativeShadowHit : nativeDocumentHit;
  if (native !== undefined) return Reflect.apply(native, root, [x, y]) as Element | null;
  return root.elementFromPoint(x, y);
}

function defaultStyle(element: Element): CSSStyleDeclaration {
  const view = element.ownerDocument.defaultView;
  if (nativeComputedStyle !== undefined && view !== null)
    return Reflect.apply(nativeComputedStyle, view, [element]) as CSSStyleDeclaration;
  return getComputedStyle(element);
}

function defaultTouch(document: Document): boolean {
  const view = document.defaultView;
  if (view === null || nativeMatchMedia === undefined) return false;
  try {
    const coarse = (Reflect.apply(nativeMatchMedia, view, ["(pointer: coarse)"]) as MediaQueryList)
      .matches;
    return coarse && view.navigator.maxTouchPoints > 0;
  } catch {
    return false;
  }
}

/** Sample positions across the visible part, as fractions, centre first. */
const FRACTIONS = [0.5, 0.25, 0.75, 0.1, 0.9];
const SAMPLES: ReadonlyArray<readonly [number, number]> = FRACTIONS.flatMap((fy) =>
  FRACTIONS.map((fx) => [fx, fy] as const),
).sort((a, b) => Math.hypot(a[0] - 0.5, a[1] - 0.5) - Math.hypot(b[0] - 0.5, b[1] - 0.5));

const FRAME_TAGS = new Set(["iframe", "frame", "embed", "object"]);

function scrollsVertically(element: Element, style: CSSStyleDeclaration): boolean {
  const overflow = style.overflowY;
  if (overflow !== "auto" && overflow !== "scroll" && overflow !== "overlay") return false;
  return element.scrollHeight - element.clientHeight > 1;
}

/** The parent a wheel chains through: the slot a node is shown in, or a shadow root's host. */
function flatParent(element: Element): Element | null {
  const slot = (element as Element & { assignedSlot?: Element | null }).assignedSlot;
  if (slot) return slot;
  if (element.parentElement !== null) return element.parentElement;
  const parent = element.parentNode as (Node & { host?: Element }) | null;
  return parent?.nodeType === 11 && parent.host !== undefined ? parent.host : null;
}

function wheelReaches(
  dom: WheelPointDom,
  scroller: Element,
  isRoot: boolean,
  x: number,
  y: number,
): boolean {
  const document = scroller.ownerDocument;
  const root = isRoot ? document : (scroller.getRootNode() as Document | ShadowRoot);
  let hit = dom.hit(root, x, y);
  // Look through open shadow roots to the element actually there.
  for (let depth = 0; hit !== null && depth < 32; depth++) {
    const shadow = (hit as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (shadow === null || shadow === undefined) break;
    const inner = dom.hit(shadow, x, y);
    if (inner === null || inner === hit) break;
    hit = inner;
  }
  for (let element = hit; element !== null; element = flatParent(element)) {
    if (element === scroller) return true;
    if (FRAME_TAGS.has(element.localName)) return false;
    const style = dom.style(element);
    // A fixed element's wheel goes to the viewport, not to the scroller it sits in.
    if (!isRoot && style.position === "fixed") return false;
    if (scrollsVertically(element, style)) return false;
    if (isRoot && element === document.documentElement) return true;
  }
  return false;
}

/**
 * The point for a wheel that scrolls `scroller` up towards `y`, or null when this is not a scroll
 * up from where the page is now, or when no visible point would wheel `scroller` itself.
 */
export function scrollUpWheelPoint(
  scroller: Element,
  y: number,
  dom: WheelPointDom,
): WheelPoint | null {
  if (!Number.isFinite(y)) return null;
  const above = scroller.scrollTop - y;
  if (above <= SCROLL_UP_MIN_PX) return null;
  const document = scroller.ownerDocument;
  const view = document.defaultView;
  const html = document.documentElement;
  const isRoot = scroller === document.scrollingElement || scroller === html;
  // The viewport without its scrollbars.
  const viewW = html?.clientWidth || view?.innerWidth || 0;
  const viewH = html?.clientHeight || view?.innerHeight || 0;
  let left = 0;
  let top = 0;
  let right = viewW;
  let bottom = viewH;
  if (!isRoot) {
    const rect = scroller.getBoundingClientRect();
    const contentLeft = rect.left + scroller.clientLeft;
    const contentTop = rect.top + scroller.clientTop;
    left = Math.max(left, contentLeft);
    top = Math.max(top, contentTop);
    right = Math.min(right, contentLeft + scroller.clientWidth);
    bottom = Math.min(bottom, contentTop + scroller.clientHeight);
  }
  if (right - left < 2 || bottom - top < 2) return null;
  for (const [fx, fy] of SAMPLES) {
    // Whole pixels, kept a pixel inside the edges.
    const x = Math.round(Math.min(right - 1, Math.max(left + 1, left + (right - left) * fx)));
    const py = Math.round(Math.min(bottom - 1, Math.max(top + 1, top + (bottom - top) * fy)));
    if (!wheelReaches(dom, scroller, isRoot, x, py)) continue;
    const point = dom.toRoot(x, py, document);
    return {
      x: point.x,
      y: point.y,
      dy: Math.min(WHEEL_MAX_PX, above),
      ...(dom.touch(document) ? { touch: true as const } : {}),
    };
  }
  return null;
}

export function defaultWheelPointDom(toRoot: WheelPointDom["toRoot"]): WheelPointDom {
  return { hit: defaultHit, style: defaultStyle, toRoot, touch: defaultTouch };
}
