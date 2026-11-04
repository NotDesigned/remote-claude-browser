/**
 * Fonts a page adds from script exist only in that document's font set, not in its markup.
 *
 * rrweb starts watching for them at DOMContentLoaded, after module scripts have usually run, and its
 * replayer adds them to the top document whichever frame they came from. So each document remembers
 * its own from the start, and its snapshots carry them as an ordinary stylesheet.
 */

const SYNTHETIC_STYLE_ID = 1_000_000_000;
/** Lets several fonts arriving together cost one more snapshot. */
const LATE_FONT_SNAPSHOT_DELAY_MS = 500;
const ENCODE_CHUNK_BYTES = 0x8000;

const DESCRIPTORS: Record<string, string> = {
  style: "font-style",
  weight: "font-weight",
  stretch: "font-stretch",
  unicodeRange: "unicode-range",
  display: "font-display",
  featureSettings: "font-feature-settings",
  variationSettings: "font-variation-settings",
};

export interface CapturedFontSource {
  family: string;
  source: string | Uint8Array;
  descriptors?: Record<string, unknown> | undefined;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += ENCODE_CHUNK_BYTES)
    binary += String.fromCharCode(...bytes.subarray(at, at + ENCODE_CHUNK_BYTES));
  return btoa(binary);
}

/** The stylesheet rule equivalent to a `new FontFace(family, source, descriptors)`. */
export function fontFaceRule(font: CapturedFontSource): string {
  const src =
    typeof font.source === "string"
      ? font.source
      : `url("data:font/woff2;base64,${encodeBase64(font.source)}")`;
  const family = font.family.replace(/^["']|["']$/g, "").replace(/["\\]/g, "\\$&");
  const lines = [`font-family: "${family}"`, `src: ${src}`];
  for (const [name, property] of Object.entries(DESCRIPTORS)) {
    const value = font.descriptors?.[name];
    if (typeof value === "string" && value !== "") lines.push(`${property}: ${value}`);
  }
  return `@font-face { ${lines.join("; ")}; }`;
}

const absoluteUrls = (source: string, base: string): string =>
  source.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (whole, _quote: string, url: string) => {
    try {
      return `url("${new URL(url, base).href}")`;
    } catch {
      return whole;
    }
  });

function capturedSource(source: unknown, base: string): string | Uint8Array | null {
  if (typeof source === "string") return absoluteUrls(source, base);
  // Copied now: the page may transfer or reuse its buffer afterwards.
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  if (ArrayBuffer.isView(source))
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
  return null;
}

export interface FontCapture {
  /** The rules for fonts this document has now, or an empty string. */
  css(): string;
}

export interface FontCaptureOptions {
  /** A font arrived after a snapshot went out. Called once per burst. */
  onLateFont?(): void;
  setTimer?(callback: () => void, ms: number): unknown;
}

/** Must run before the page's own scripts. */
export function installFontCapture(target: Window, options: FontCaptureOptions = {}): FontCapture {
  const win = target as Window & typeof globalThis;
  const sources = new WeakMap<object, CapturedFontSource>();
  const added = new Map<object, string>();
  let lateTimer: unknown = null;
  let snapshotTaken = false;
  const schedule = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));

  if (typeof win.FontFace === "function")
    win.FontFace = new Proxy(win.FontFace, {
      construct(constructor, args: unknown[], newTarget) {
        const face = Reflect.construct(constructor, args, newTarget) as object;
        const source = capturedSource(args[1], target.location.href);
        if (source !== null)
          sources.set(face, {
            family: String(args[0]),
            source,
            descriptors: args[2] as Record<string, unknown> | undefined,
          });
        return face;
      },
    });

  const prototype = (win as unknown as { FontFaceSet?: { prototype: FontFaceSet } }).FontFaceSet
    ?.prototype;
  if (prototype) {
    const add = prototype.add;
    prototype.add = function (this: FontFaceSet, face: FontFace) {
      const result = add.call(this, face);
      const source = sources.get(face);
      if (source && !added.has(face)) {
        added.set(face, fontFaceRule(source));
        if (snapshotTaken && options.onLateFont && lateTimer === null)
          lateTimer = schedule(() => {
            lateTimer = null;
            options.onLateFont?.();
          }, LATE_FONT_SNAPSHOT_DELAY_MS);
      }
      return result;
    };
  }

  return {
    css() {
      snapshotTaken = true;
      return [...added.values()].join("\n");
    },
  };
}

interface SerializedNode {
  type?: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SerializedNode[];
  id?: number;
}

const ELEMENT_NODE = 2;

/** Puts the rules in the head of a serialized document. Its recorder never sees this element. */
export function addFontsToSnapshot(root: unknown, css: string): void {
  if (css === "") return;
  const html = (root as SerializedNode).childNodes?.find(
    (node) => node.type === ELEMENT_NODE && node.tagName === "html",
  );
  const head = html?.childNodes?.find(
    (node) => node.type === ELEMENT_NODE && node.tagName === "head",
  );
  head?.childNodes?.push({
    type: ELEMENT_NODE,
    tagName: "style",
    attributes: { _cssText: css },
    childNodes: [],
    id: SYNTHETIC_STYLE_ID,
  });
}
