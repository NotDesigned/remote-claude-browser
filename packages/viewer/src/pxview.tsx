/**
 * Pixel fallback view.
 *
 * The mirror host is an imperative surface already (rrweb owns its iframe), so pixel mode uses
 * the same ownership model. The controller does not claim that surface until the first px frame.
 * Returning to dom removes an owned canvas; P2-PX-G immediately follows the mode message with a
 * canonical join snapshot, which rebuilds a fresh Replayer.
 */
import { GRID_COLUMNS, changedTiles, type TileGrid } from "./px-tiles";
import { Mod, type Down, type TabId, type Up } from "@mirror/protocol";
import { attachPxKeyboard } from "./px-ime";
import { createTouchMouseFilter } from "./input/pointer";

type ModeMessage = Extract<Down, { t: "mode" }>;
type PxFrame = Extract<Down, { t: "px" }>;
type PointerMessage = Extract<Up, { t: "ptr" }>;

export interface PxViewOptions {
  container: HTMLElement;
  send(message: Up): void;
  onEnterPx(tab: TabId): void;
  onEnterDom?(tab: TabId): void;
  createImage?: () => HTMLImageElement;
}

export interface PxView {
  handle(message: ModeMessage | PxFrame): void;
  selectTab(tab: TabId): void;
  getCanvas(): HTMLCanvasElement | null;
  destroy(): void;
}

export function createPxView(options: PxViewOptions): PxView {
  const modes = new Map<TabId, "dom" | "px">();
  let activeTab: TabId | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let detachInput = () => {};
  let painter: ReturnType<typeof createPxFramePainter> | null = null;
  let destroyed = false;

  const removeCanvas = () => {
    painter?.dispose();
    painter = null;
    detachInput();
    detachInput = () => {};
    canvas?.remove();
    canvas = null;
  };

  const enterPx = (tab: TabId): HTMLCanvasElement => {
    if (canvas !== null) return canvas;
    options.onEnterPx(tab);
    const next = options.container.ownerDocument.createElement("canvas");
    next.className = "px-canvas";
    next.tabIndex = 0;
    next.setAttribute("aria-label", "Pixel browser view");
    options.container.replaceChildren(next);
    options.container.dataset.mirrorState = "px";
    canvas = next;
    painter = createPxFramePainter(next, options.createImage);
    detachInput = attachPxInput({ canvas: next, tab, send: options.send });
    return next;
  };

  const enterDom = (tab: TabId) => {
    removeCanvas();
    options.container.dataset.mirrorState = "building";
    options.onEnterDom?.(tab);
  };

  return {
    handle(message) {
      if (destroyed) return;
      if (message.t === "mode") {
        modes.set(message.tab, message.mode);
        if (message.tab !== activeTab) return;
        // A mode announcement alone must not disturb rrweb's live iframe or its document-set
        // observers. Pixel mode claims the shared host only when an actual frame is available.
        if (message.mode === "dom" && canvas !== null) enterDom(message.tab);
        return;
      }
      if (message.tab !== activeTab || modes.get(message.tab) !== "px") return;
      enterPx(message.tab);
      painter?.enqueue(message);
    },
    selectTab(tab) {
      if (destroyed || tab === activeTab) return;
      removeCanvas();
      activeTab = tab;
    },
    getCanvas: () => canvas,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      removeCanvas();
      modes.clear();
      activeTab = null;
    },
  };
}

export function paintPxFrame(
  canvas: HTMLCanvasElement,
  frame: Pick<PxFrame, "data" | "w" | "h" | "sharp">,
  createImage: () => HTMLImageElement = () => new Image(),
): () => void {
  return decodePxFrame(canvas, frame, createImage, () => {});
}

/** One decoder keeps making progress while only the newest waiting frame is retained. */
function createPxFramePainter(
  canvas: HTMLCanvasElement,
  createImage: () => HTMLImageElement = () => new Image(),
) {
  let disposed = false;
  let pending: Pick<PxFrame, "data" | "w" | "h" | "sharp"> | null = null;
  let active: { cancel: () => void } | null = null;

  const drain = () => {
    if (disposed || active !== null || pending === null) return;
    const frame = pending;
    pending = null;
    const decoding = { cancel: () => {} };
    active = decoding;
    decoding.cancel = decodePxFrame(canvas, frame, createImage, () => {
      if (active !== decoding) return;
      active = null;
      drain();
    });
  };

  return {
    enqueue(frame: Pick<PxFrame, "data" | "w" | "h" | "sharp">) {
      if (disposed) return;
      pending = { data: frame.data, w: frame.w, h: frame.h, sharp: frame.sharp };
      drain();
    },
    dispose() {
      disposed = true;
      pending = null;
      active?.cancel();
      active = null;
    },
  };
}

const logicalSizes = new WeakMap<HTMLCanvasElement, { width: number; height: number }>();
const sharpGrids = new WeakMap<HTMLCanvasElement, TileGrid>();

/** The page's size in CSS pixels, which pointer coordinates are expressed in. */
function logicalSize(canvas: HTMLCanvasElement): { width: number; height: number } {
  return logicalSizes.get(canvas) ?? { width: canvas.width, height: canvas.height };
}

function imageGrid(canvas: HTMLCanvasElement, image: HTMLImageElement): TileGrid | null {
  try {
    const columns = GRID_COLUMNS;
    const rows = Math.max(1, Math.round((columns * image.naturalHeight) / image.naturalWidth));
    const small = canvas.ownerDocument.createElement("canvas");
    small.width = columns;
    small.height = rows;
    const context = small.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, columns, rows);
    return { columns, rows, pixels: context.getImageData(0, 0, columns, rows).data };
  } catch {
    return null;
  }
}

function decodePxFrame(
  canvas: HTMLCanvasElement,
  frame: Pick<PxFrame, "data" | "w" | "h" | "sharp">,
  createImage: () => HTMLImageElement,
  settled: () => void,
): () => void {
  const context = canvas.getContext("2d");
  if (context === null) {
    settled();
    return () => {};
  }
  const image = createImage();
  let live = true;
  // Binary frames arrive as a JPEG Blob; JSON frames as base64 or a data: URL.
  const objectUrl = typeof frame.data === "string" ? null : URL.createObjectURL(frame.data);
  const cancel = () => {
    live = false;
    image.onload = null;
    image.onerror = null;
    if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
  };
  const complete = () => {
    if (!live) return;
    cancel();
    settled();
  };
  image.onload = () => {
    if (!live) return;
    try {
      // Resizing clears the canvas, even when assigned its current dimensions. Keep the last
      // painted frame until a replacement is decoded, then resize and draw in the same task.
      // The canvas holds every device pixel received; page coordinates stay in `frame.w`/`h`.
      logicalSizes.set(canvas, {
        width: positiveDimension(frame.w),
        height: positiveDimension(frame.h),
      });
      const width = positiveDimension(image.naturalWidth || frame.w);
      const height = positiveDimension(image.naturalHeight || frame.h);
      const previous =
        canvas.width === width && canvas.height === height ? sharpGrids.get(canvas) : undefined;
      const grid = previous || frame.sharp ? imageGrid(canvas, image) : null;
      const tiles = !frame.sharp && previous && grid ? changedTiles(previous, grid) : null;
      if (tiles && tiles.length <= (grid!.columns * grid!.rows) / 4) {
        // A small change, such as a blinking caret, leaves the sharp picture around it intact.
        const tileWidth = width / grid!.columns;
        const tileHeight = height / grid!.rows;
        for (const { column, row } of tiles) {
          const x = Math.floor(column * tileWidth);
          const y = Math.floor(row * tileHeight);
          const w = Math.ceil(tileWidth);
          const h = Math.ceil(tileHeight);
          context.drawImage(image, x, y, w, h, x, y, w, h);
        }
        sharpGrids.set(canvas, grid!);
      } else {
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        context.drawImage(image, 0, 0, width, height);
        if (frame.sharp && grid) sharpGrids.set(canvas, grid);
        else sharpGrids.delete(canvas);
      }
    } finally {
      complete();
    }
  };
  image.onerror = complete;
  image.src =
    objectUrl ??
    (typeof frame.data === "string" && frame.data.startsWith("data:")
      ? frame.data
      : `data:image/jpeg;base64,${frame.data as string}`);
  return cancel;
}

interface PxInputOptions {
  canvas: HTMLCanvasElement;
  tab: TabId;
  send(message: Up): void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

type PxPointerEvent = Pick<
  MouseEvent,
  | "clientX"
  | "clientY"
  | "button"
  | "buttons"
  | "detail"
  | "altKey"
  | "ctrlKey"
  | "metaKey"
  | "shiftKey"
> & { deltaX?: number; deltaY?: number };

/** Attach input directly to the canvas; nodeId=-1 is the frozen wire's node-less sentinel. */
export function attachPxInput(options: PxInputOptions): () => void {
  const now = options.now ?? Date.now;
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  let lastMoveAt = Number.NEGATIVE_INFINITY;
  let trailing: MouseEvent | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const keyboard = attachPxKeyboard(options);
  const mouseFilter = createTouchMouseFilter(now);
  let touch: {
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null = null;

  const sendPointer = (event: PxPointerEvent, kind: PointerMessage["kind"]) => {
    const { vx, vy } = rawCanvasPoint(options.canvas, event);
    options.send({
      t: "ptr",
      tab: options.tab,
      kind,
      nodeId: -1,
      rx: 0,
      ry: 0,
      vx,
      vy,
      button: mouseButton(event.button),
      buttons: event.buttons,
      mods: eventMods(event),
      clicks: event.detail >= 2 ? 2 : 1,
      ...(kind === "wheel" ? { dx: event.deltaX ?? 0, dy: event.deltaY ?? 0 } : {}),
    });
  };
  const flushMove = () => {
    timer = null;
    const event = trailing;
    trailing = null;
    if (event === null) return;
    lastMoveAt = now();
    sendPointer(event, "move");
  };
  const onMove = (event: MouseEvent) => {
    if (!event.isTrusted || mouseFilter.ignore(event)) return;
    const elapsed = now() - lastMoveAt;
    if (elapsed >= 50) {
      if (timer !== null) cancel(timer);
      timer = null;
      trailing = null;
      lastMoveAt = now();
      sendPointer(event, "move");
    } else {
      trailing = event;
      if (timer === null) timer = schedule(flushMove, Math.max(0, 50 - elapsed));
    }
  };
  const onDown = (event: MouseEvent) => {
    if (!event.isTrusted || mouseFilter.ignore(event)) return;
    event.preventDefault();
    keyboard.focus(event);
    sendPointer(event, "down");
  };
  const onUp = (event: MouseEvent) => {
    if (event.isTrusted && !mouseFilter.ignore(event)) sendPointer(event, "up");
  };
  const onWheel = (event: WheelEvent) => {
    if (!event.isTrusted) return;
    event.preventDefault();
    sendPointer(event, "wheel");
  };
  const onContextMenu = (event: MouseEvent) => {
    if (event.isTrusted) event.preventDefault();
  };
  const scrollTouch = (current: NonNullable<typeof touch>, point: Touch, event: TouchEvent) => {
    if (current.lastX === point.clientX && current.lastY === point.clientY) return;
    const rect = options.canvas.getBoundingClientRect();
    sendPointer(
      {
        clientX: current.startX,
        clientY: current.startY,
        button: 0,
        buttons: 0,
        detail: 1,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        deltaX:
          rect.width > 0
            ? ((current.lastX - point.clientX) * logicalSize(options.canvas).width) / rect.width
            : 0,
        deltaY:
          rect.height > 0
            ? ((current.lastY - point.clientY) * logicalSize(options.canvas).height) / rect.height
            : 0,
      },
      "wheel",
    );
    current.lastX = point.clientX;
    current.lastY = point.clientY;
  };
  const onTouchStart = (event: TouchEvent) => {
    if (!event.isTrusted) return;
    touch = null;
    if (event.touches.length !== 1) return;
    const point = event.touches[0]!;
    mouseFilter.touch(point);
    touch = {
      startX: point.clientX,
      startY: point.clientY,
      lastX: point.clientX,
      lastY: point.clientY,
      moved: false,
    };
    event.preventDefault();
  };
  const onTouchMove = (event: TouchEvent) => {
    if (!event.isTrusted || touch === null) return;
    if (event.touches.length !== 1) {
      touch = null;
      return;
    }
    const point = event.touches[0]!;
    mouseFilter.touch(point);
    event.preventDefault();
    if (
      !touch.moved &&
      Math.hypot(point.clientX - touch.startX, point.clientY - touch.startY) <= 10
    )
      return;
    touch.moved = true;
    scrollTouch(touch, point, event);
  };
  const onTouchEnd = (event: TouchEvent) => {
    if (!event.isTrusted) return;
    const current = touch;
    touch = null;
    const point = event.changedTouches[0];
    if (point) mouseFilter.touch(point);
    if (current === null || !point) return;
    event.preventDefault();
    if (
      current.moved ||
      Math.hypot(point.clientX - current.startX, point.clientY - current.startY) > 10
    ) {
      scrollTouch(current, point, event);
      return;
    }
    keyboard.focus(point);
    const pointer = {
      clientX: point.clientX,
      clientY: point.clientY,
      button: 0,
      buttons: 0,
      detail: 1,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    };
    sendPointer(pointer, "move");
    sendPointer({ ...pointer, buttons: 1 }, "down");
    sendPointer(pointer, "up");
  };
  const onTouchCancel = (event: TouchEvent) => {
    if (!event.isTrusted) return;
    if (event.changedTouches[0]) mouseFilter.touch(event.changedTouches[0]);
    touch = null;
  };

  options.canvas.addEventListener("mousemove", onMove);
  options.canvas.addEventListener("mousedown", onDown);
  options.canvas.addEventListener("mouseup", onUp);
  options.canvas.addEventListener("wheel", onWheel, { passive: false });
  options.canvas.addEventListener("contextmenu", onContextMenu);
  const touchOptions = { passive: false } as const;
  options.canvas.addEventListener("touchstart", onTouchStart, touchOptions);
  options.canvas.addEventListener("touchmove", onTouchMove, touchOptions);
  options.canvas.addEventListener("touchend", onTouchEnd, touchOptions);
  options.canvas.addEventListener("touchcancel", onTouchCancel, touchOptions);
  return () => {
    options.canvas.removeEventListener("mousemove", onMove);
    options.canvas.removeEventListener("mousedown", onDown);
    options.canvas.removeEventListener("mouseup", onUp);
    options.canvas.removeEventListener("wheel", onWheel);
    keyboard.dispose();
    options.canvas.removeEventListener("contextmenu", onContextMenu);
    options.canvas.removeEventListener("touchstart", onTouchStart);
    options.canvas.removeEventListener("touchmove", onTouchMove);
    options.canvas.removeEventListener("touchend", onTouchEnd);
    options.canvas.removeEventListener("touchcancel", onTouchCancel);
    touch = null;
    if (timer !== null) cancel(timer);
  };
}

function rawCanvasPoint(
  canvas: HTMLCanvasElement,
  event: Pick<MouseEvent, "clientX" | "clientY">,
): { vx: number; vy: number } {
  const rect = canvas.getBoundingClientRect();
  const size = logicalSize(canvas);
  return {
    vx: scalePoint(event.clientX - rect.left, rect.width, size.width),
    vy: scalePoint(event.clientY - rect.top, rect.height, size.height),
  };
}

function scalePoint(offset: number, rendered: number, intrinsic: number): number {
  if (!Number.isFinite(rendered) || rendered <= 0) return 0;
  return Math.max(0, Math.min(intrinsic - Number.EPSILON, (offset / rendered) * intrinsic));
}

function positiveDimension(value: number): number {
  return Math.max(1, Math.round(Number.isFinite(value) ? value : 1));
}

function eventMods(
  event: Pick<MouseEvent | KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
): number {
  return (
    (event.altKey ? Mod.Alt : 0) |
    (event.ctrlKey ? Mod.Ctrl : 0) |
    (event.metaKey ? Mod.Meta : 0) |
    (event.shiftKey ? Mod.Shift : 0)
  );
}

function mouseButton(button: number): 0 | 1 | 2 | undefined {
  return button === 0 || button === 1 || button === 2 ? button : undefined;
}
