/**
 * Pictures of the canvases in a verification challenge, for the page view.
 *
 * Challenges such as hCaptcha draw their images on canvases, which the page view otherwise shows
 * blank, so they could only be solved in picture mode. rrweb's own canvas recording is not used: it
 * starts a Worker from a Blob URL, which made Chromium's origin checks kill renderers, it wraps
 * getContext where a challenge's checks can see it, and it clears WebGL canvases before reading
 * them. This reads each canvas a few times a second instead, touching nothing the page can see,
 * and sends a picture only when it changed. Its events take the shape of rrweb's sampled canvas
 * snapshots, which the viewer paints with a compositor that accepts nothing else.
 */
import {
  DEFAULT_CANVAS_SITES,
  EventType,
  IncrementalSource,
  type eventWithTime,
} from "@mirror/protocol";

export { DEFAULT_CANVAS_SITES };

export function matchesCanvasSite(
  location: Pick<Location, "hostname" | "pathname">,
  sites: readonly string[],
): boolean {
  return sites.some((site) => {
    if (site === "*") return true;
    const slash = site.indexOf("/");
    const host = (slash === -1 ? site : site.slice(0, slash)).toLowerCase();
    const path = slash === -1 ? "" : site.slice(slash);
    const hostname = location.hostname.toLowerCase();
    if (host === "" || (hostname !== host && !hostname.endsWith(`.${host}`))) return false;
    return location.pathname.startsWith(path);
  });
}

export interface CanvasSamplerNatives {
  createImageBitmap: (image: HTMLCanvasElement) => Promise<ImageBitmap>;
  OffscreenCanvas: typeof OffscreenCanvas;
}

/** Taken at document start, before the page can replace them. */
export function captureCanvasSamplerNatives(
  scope: typeof globalThis = globalThis,
): CanvasSamplerNatives | null {
  if (typeof scope.createImageBitmap !== "function" || typeof scope.OffscreenCanvas !== "function")
    return null;
  return {
    createImageBitmap: scope.createImageBitmap.bind(
      scope,
    ) as CanvasSamplerNatives["createImageBitmap"],
    OffscreenCanvas: scope.OffscreenCanvas,
  };
}

export interface CanvasSamplerOptions {
  document: Document;
  natives: CanvasSamplerNatives;
  /** The recorder's id for a node, or -1. */
  getId(node: Node): number;
  emit(event: eventWithTime): void;
  fps?: number;
  quality?: number;
  /** A canvas that has not changed is sent again this often, for viewers that missed it. */
  refreshMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface CanvasSampler {
  /** Send every canvas again, as after a new snapshot, whose canvases are blank. */
  reset(): void;
  stop(): void;
}

interface Sent {
  base64: string;
  at: number;
}

function canvasesIn(root: Document, found: HTMLCanvasElement[] = []): HTMLCanvasElement[] {
  for (const canvas of root.querySelectorAll("canvas")) found.push(canvas);
  // The recorder covers the same-origin documents below this one too.
  for (const frame of root.querySelectorAll("iframe")) {
    let inner: Document | null = null;
    try {
      inner = frame.contentDocument;
    } catch {
      inner = null;
    }
    if (inner !== null) canvasesIn(inner, found);
  }
  return found;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function snapshotEvent(
  id: number,
  width: number,
  height: number,
  base64: string,
  type: string,
  timestamp: number,
): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp,
    data: {
      source: IncrementalSource.CanvasMutation,
      id,
      type: 0,
      commands: [
        { property: "clearRect", args: [0, 0, width, height] },
        {
          property: "drawImage",
          args: [
            {
              rr_type: "ImageBitmap",
              args: [{ rr_type: "Blob", data: [{ rr_type: "ArrayBuffer", base64 }], type }],
            },
            0,
            0,
          ],
        },
      ],
    },
  } as unknown as eventWithTime;
}

export function startCanvasSampler(options: CanvasSamplerOptions): CanvasSampler {
  const interval = 1000 / (options.fps ?? 4);
  const quality = options.quality ?? 0.7;
  const refreshMs = options.refreshMs ?? 10_000;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let sent = new WeakMap<HTMLCanvasElement, Sent>();
  // A canvas with another origin's images drawn on it cannot be read. Try it again only later.
  const unreadable = new WeakMap<HTMLCanvasElement, number>();
  let stopped = false;
  let timer: unknown;

  const sample = async (canvas: HTMLCanvasElement): Promise<void> => {
    const { width, height } = canvas;
    if (width === 0 || height === 0 || !canvas.isConnected) return;
    const box = canvas.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    if ((unreadable.get(canvas) ?? 0) > now()) return;
    const id = options.getId(canvas);
    if (id < 0) return;
    let base64: string;
    let type: string;
    try {
      const bitmap = await options.natives.createImageBitmap(canvas);
      try {
        const copy = new options.natives.OffscreenCanvas(width, height);
        copy.getContext("2d")?.drawImage(bitmap, 0, 0);
        const blob = await copy.convertToBlob({ type: "image/webp", quality });
        base64 = toBase64(await blob.arrayBuffer());
        type = blob.type;
      } finally {
        bitmap.close();
      }
    } catch {
      unreadable.set(canvas, now() + 5_000);
      return;
    }
    const last = sent.get(canvas);
    if (last !== undefined && last.base64 === base64 && now() - last.at < refreshMs) return;
    sent.set(canvas, { base64, at: now() });
    options.emit(snapshotEvent(id, width, height, base64, type, now()));
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      for (const canvas of canvasesIn(options.document)) {
        if (stopped) return;
        await sample(canvas);
      }
    } finally {
      if (!stopped) timer = setTimer(() => void tick(), interval);
    }
  };
  timer = setTimer(() => void tick(), interval);

  return {
    reset() {
      sent = new WeakMap();
    },
    stop() {
      stopped = true;
      clearTimer(timer);
    },
  };
}
