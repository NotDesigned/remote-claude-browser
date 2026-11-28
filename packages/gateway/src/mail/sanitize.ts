/**
 * Strict allowlist HTML and CSS sanitizer for received emails.
 *
 * Goals:
 * 1. Preserve email typography, tables, colors, spacing and styled CTA buttons so HTML emails are
 *    easy to read.
 * 2. Guarantee zero open-tracking or device-IP leaks: strip all external resources (images, CSS
 *    url()/image-set()/@import/@font-face, resource hints, SVG, media, frames, scripts, forms) and
 *    turn <a href="https://..."> into <button type="button" class="mail-remote-link" data-mail-url="...">
 *    with no href attribute so links can only open in the remote proxied browser.
 */

const MAX_RAW_HTML_CHARS = 512_000;

/** Tags whose entire subtree (including text children) must be discarded. */
const DROP_SUBTREE_TAGS = new Set([
  "script",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "audio",
  "video",
  "source",
  "track",
  "svg",
  "math",
  "canvas",
  "map",
  "area",
  "form",
  "select",
  "option",
  "optgroup",
  "textarea",
  "button",
  "datalist",
  "head-ignored",
  "style",
  "title",
  "template",
  "portal",
  "slot",
]);

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const ALLOWED_TAGS = new Set([
  "div",
  "span",
  "p",
  "br",
  "wbr",
  "hr",
  "blockquote",
  "pre",
  "code",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "del",
  "ins",
  "small",
  "sub",
  "sup",
  "mark",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "center",
  "font",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "figure",
  "figcaption",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "colgroup",
  "col",
]);

const SAFE_CSS_PROPERTIES = new Set([
  "background",
  "background-color",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-style",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-width",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-radius",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "border-collapse",
  "border-spacing",
  "box-sizing",
  "color",
  "display",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "gap",
  "height",
  "letter-spacing",
  "line-height",
  "list-style",
  "list-style-position",
  "list-style-type",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "max-height",
  "max-width",
  "min-height",
  "min-width",
  "opacity",
  "overflow",
  "overflow-wrap",
  "overflow-x",
  "overflow-y",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "table-layout",
  "text-align",
  "text-decoration",
  "text-decoration-color",
  "text-decoration-line",
  "text-decoration-style",
  "text-indent",
  "text-transform",
  "vertical-align",
  "white-space",
  "width",
  "word-break",
  "word-spacing",
  "word-wrap",
]);

const FORBIDDEN_CSS_VALUE =
  /\\|url\s*\(|image\s*\(|image-set|cross-fade|src\s*\(|expression|javascript:|vbscript:|data:|-moz-binding|behavior|@import|@font-face|<!--|-->|<\/?/i;

const ALLOWED_CSS_FUNCTIONS = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "linear-gradient",
  "radial-gradient",
  "calc",
  "min",
  "max",
  "clamp",
  "minmax",
  "var",
]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos" || lower === "#39") return "'";
    if (lower === "nbsp") return "\u00a0";
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    }
    return full;
  });
}

export function sanitizeCssDeclarations(css: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (const part of withoutComments.split(";")) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    const val = part.slice(colon + 1).trim();
    if (!SAFE_CSS_PROPERTIES.has(prop) || !val || val.length > 400) continue;
    if (FORBIDDEN_CSS_VALUE.test(val) || /[{}]/.test(val)) continue;
    if (prop !== "font-family" && /["']/.test(val)) continue;
    let unknownFn = false;
    for (const fnMatch of val.matchAll(/([A-Za-z0-9_-]+)\s*\(/g)) {
      if (!ALLOWED_CSS_FUNCTIONS.has(fnMatch[1]!.toLowerCase())) {
        unknownFn = true;
        break;
      }
    }
    if (unknownFn) continue;
    if (prop === "display" && /\bfixed\b|\babsolute\b/i.test(val)) continue;
    out.push(`${prop}:${val}`);
  }
  return out.join(";");
}

function sanitizeSelector(selector: string): string | null {
  const cleaned = selector.trim().replace(/\s+/g, " ");
  if (!cleaned || cleaned.length > 240) return null;
  if (/\\|@|[{}<>]|javascript:/i.test(cleaned)) return null;
  const parts = cleaned
    .split(",")
    .map((item) =>
      item
        .trim()
        .replace(/\b(?:html|body)\b/gi, ".mail-canvas")
        .replace(/(^|[\s>+~])a(?=[\s>+~.#[:]|$)/gi, "$1.mail-remote-link"),
    )
    .filter((item) => item.length > 0 && /^[A-Za-z0-9_\-.#:\s>+~[\]="'*^$|()]+$/.test(item));
  return parts.length > 0 ? parts.join(", ") : null;
}

export function sanitizeStylesheet(css: string): string {
  const stripped = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--|-->/g, "")
    .slice(0, 64_000);
  const rules: string[] = [];
  let pos = 0;
  while (pos < stripped.length && rules.length < 400) {
    while (pos < stripped.length && /\s/.test(stripped[pos]!)) pos++;
    if (pos >= stripped.length) break;
    if (stripped[pos] === "@") {
      const semi = stripped.indexOf(";", pos);
      const brace = stripped.indexOf("{", pos);
      if (semi !== -1 && (brace === -1 || semi < brace)) {
        // Drop @import, @charset, @namespace, etc.
        pos = semi + 1;
        continue;
      }
      if (brace === -1) break;
      const header = stripped.slice(pos, brace).trim();
      let depth = 1;
      let end = brace + 1;
      while (end < stripped.length && depth > 0) {
        if (stripped[end] === "{") depth++;
        else if (stripped[end] === "}") depth--;
        end++;
      }
      const body = stripped.slice(brace + 1, Math.max(brace + 1, end - 1));
      if (
        /^@media\s+[A-Za-z0-9\s(),:\-]+$/i.test(header) &&
        !/prefers-color-scheme:\s*dark/i.test(header)
      ) {
        const inner = sanitizeStylesheet(body);
        if (inner) rules.push(`${header}{${inner}}`);
      }
      pos = end;
      continue;
    }
    const brace = stripped.indexOf("{", pos);
    if (brace === -1) break;
    const rawSelector = stripped.slice(pos, brace);
    const close = stripped.indexOf("}", brace + 1);
    if (close === -1) break;
    const rawBody = stripped.slice(brace + 1, close);
    pos = close + 1;
    const selector = sanitizeSelector(rawSelector);
    if (!selector) continue;
    const declarations = sanitizeCssDeclarations(rawBody);
    if (declarations) rules.push(`${selector}{${declarations}}`);
  }
  return rules.join("\n");
}

function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const name = match[1]!.toLowerCase();
    const val = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
    if (!attrs.has(name)) attrs.set(name, val);
  }
  return attrs;
}

function isPrivateIpv4(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (
    host === "" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    /^(?:0+:){0,7}0*1$/i.test(host) ||
    /^(?:0+:){1,7}0*$/i.test(host) ||
    /^(?:fe[89ab][0-9a-f]|fc[0-9a-f]{2}|fd[0-9a-f]{2}|64:ff9b):/i.test(host)
  ) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    return isPrivateIpv4(Number(ipv4[1]), Number(ipv4[2]));
  }
  const mappedHex =
    /^(?:::(?:ffff:)?|(?:0+:){5}(?:ffff:|0+:))([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1]!, 16);
    return isPrivateIpv4((hi >> 8) & 0xff, hi & 0xff);
  }
  const mappedDot =
    /^(?:::(?:ffff:)?|(?:0+:){5}(?:ffff:|0+:))(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(
      host,
    );
  if (mappedDot) {
    return isPrivateIpv4(Number(mappedDot[1]), Number(mappedDot[2]));
  }
  return false;
}

function safeHttpUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (isPrivateOrLocalHostname(parsed.hostname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function sanitizeAllowedAttrs(tag: string, attrs: Map<string, string>): string {
  const out: string[] = [];
  const cls = attrs.get("class")?.trim();
  if (cls && cls.length <= 200) {
    const safeClasses = cls
      .split(/\s+/)
      .filter((token) => /^[A-Za-z0-9_-]{1,64}$/.test(token) && !token.startsWith("mail-"));
    if (safeClasses.length > 0) out.push(`class="${escapeHtml(safeClasses.join(" "))}"`);
  }
  for (const attr of ["align", "valign", "dir", "lang"]) {
    const val = attrs.get(attr)?.trim();
    if (val && /^[A-Za-z-]{1,20}$/.test(val)) out.push(`${attr}="${escapeHtml(val)}"`);
  }
  for (const attr of [
    "width",
    "height",
    "cellpadding",
    "cellspacing",
    "border",
    "colspan",
    "rowspan",
  ]) {
    const val = attrs.get(attr)?.trim();
    if (val && /^\d{1,4}%?$/.test(val)) out.push(`${attr}="${escapeHtml(val)}"`);
  }
  const extraStyles: string[] = [];
  const bgcolor = attrs.get("bgcolor")?.trim();
  if (bgcolor && /^(?:#[0-9a-fA-F]{3,8}|[A-Za-z]{3,20})$/.test(bgcolor)) {
    extraStyles.push(`background-color:${bgcolor}`);
  }
  if (tag === "font") {
    const color = attrs.get("color")?.trim();
    if (color && /^(?:#[0-9a-fA-F]{3,8}|[A-Za-z]{3,20})$/.test(color)) {
      extraStyles.push(`color:${color}`);
    }
  }
  const rawStyle = attrs.get("style");
  const cleanStyle = [...extraStyles, ...(rawStyle ? [sanitizeCssDeclarations(rawStyle)] : [])]
    .filter(Boolean)
    .join(";");
  if (cleanStyle) out.push(`style="${escapeHtml(cleanStyle)}"`);
  return out.length > 0 ? " " + out.join(" ") : "";
}

function linkifyPlainText(rawText: string): string {
  const decoded = decodeEntities(rawText);
  let result = "";
  let last = 0;
  for (const match of decoded.matchAll(/https?:\/\/[^\s<>"'\]]+/gi)) {
    const index = match.index!;
    result += escapeHtml(decoded.slice(last, index));
    let candidate = match[0];
    while (candidate.length > 0 && /[.,;:!?]/.test(candidate[candidate.length - 1]!)) {
      candidate = candidate.slice(0, -1);
    }
    const url = safeHttpUrl(candidate);
    if (url) {
      result += `<button type="button" class="mail-remote-link" data-mail-url="${escapeHtml(url)}">${escapeHtml(candidate)}</button>`;
      last = index + candidate.length;
    } else {
      result += escapeHtml(match[0]);
      last = index + match[0].length;
    }
  }
  result += escapeHtml(decoded.slice(last));
  return result;
}

export function sanitizeEmailHtml(input: string | undefined): string | undefined {
  if (!input || !input.trim()) return undefined;
  const bounded = input
    .slice(0, MAX_RAW_HTML_CHARS)
    .replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>/gi, "");
  const styles: string[] = [];
  const out: string[] = [];
  const openStack: Array<{ emitted: string }> = [];
  const findLastOpen = (predicate: (emitted: string) => boolean): number => {
    for (let i = openStack.length - 1; i >= 0; i--) {
      if (predicate(openStack[i]!.emitted)) return i;
    }
    return -1;
  };
  let droppedDepth = 0;
  let droppedTag = "";
  let insideAnchor = 0;

  // Extract <style> blocks first so head/body placement doesn't matter, then strip them from markup.
  const withoutStyles = bounded.replace(
    /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi,
    (_m, css: string) => {
      const clean = sanitizeStylesheet(css);
      if (clean) styles.push(clean);
      return "";
    },
  );

  const tagRe = /<\/?([A-Za-z][A-Za-z0-9:-]*)(\s(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*(\/?)>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  const emitText = (chunk: string) => {
    if (!chunk || droppedDepth > 0) return;
    out.push(insideAnchor > 0 ? escapeHtml(decodeEntities(chunk)) : linkifyPlainText(chunk));
  };

  while ((match = tagRe.exec(withoutStyles)) !== null) {
    emitText(withoutStyles.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const full = match[0];
    const isClosing = full.startsWith("</");
    const rawTag = match[1]!.toLowerCase();
    const attrText = match[2] ?? "";
    const selfClosing = match[3] === "/" || VOID_TAGS.has(rawTag);

    if (droppedDepth > 0) {
      if (!isClosing && rawTag === droppedTag && !selfClosing) droppedDepth++;
      else if (isClosing && rawTag === droppedTag) droppedDepth--;
      continue;
    }

    if (!isClosing && DROP_SUBTREE_TAGS.has(rawTag)) {
      if (!selfClosing) {
        droppedDepth = 1;
        droppedTag = rawTag;
      }
      continue;
    }

    if (rawTag === "img") {
      if (!isClosing) {
        const attrs = parseAttributes(attrText);
        const w = Number.parseInt(attrs.get("width") ?? "", 10);
        const h = Number.parseInt(attrs.get("height") ?? "", 10);
        const isPixel = (Number.isFinite(w) && w <= 2) || (Number.isFinite(h) && h <= 2);
        const alt = (attrs.get("alt") ?? "").trim();
        if (!isPixel && alt.length > 0 && alt.length <= 80) {
          out.push(`<span class="mail-img-alt">${escapeHtml(alt)}</span>`);
        }
      }
      continue;
    }

    if (rawTag === "a") {
      if (isClosing) {
        const idx = findLastOpen((emitted) => emitted === "a-btn" || emitted === "a-span");
        if (idx !== -1) {
          while (openStack.length > idx) {
            const popped = openStack.pop()!;
            if (popped.emitted === "a-btn") {
              insideAnchor = Math.max(0, insideAnchor - 1);
              out.push("</button>");
            } else if (popped.emitted === "a-span") {
              insideAnchor = Math.max(0, insideAnchor - 1);
              out.push("</span>");
            } else {
              out.push(`</${popped.emitted}>`);
            }
          }
        }
      } else if (!selfClosing) {
        const attrs = parseAttributes(attrText);
        const url = safeHttpUrl(attrs.get("href") ?? "");
        const styleAttr = sanitizeAllowedAttrs("a", attrs);
        // Merge class="mail-remote-link ..." if the email's <a> already had classes
        if (url) {
          const withClass = styleAttr.includes('class="')
            ? styleAttr.replace('class="', 'class="mail-remote-link ')
            : ` class="mail-remote-link"${styleAttr}`;
          out.push(`<button type="button"${withClass} data-mail-url="${escapeHtml(url)}">`);
          openStack.push({ emitted: "a-btn" });
          insideAnchor++;
        } else {
          out.push(`<span${styleAttr}>`);
          openStack.push({ emitted: "a-span" });
          insideAnchor++;
        }
      }
      continue;
    }

    if (rawTag === "html" || rawTag === "body") {
      if (!isClosing && !selfClosing) {
        const attrs = parseAttributes(attrText);
        const styleAttr = sanitizeAllowedAttrs("div", attrs);
        out.push(`<div${styleAttr}>`);
        openStack.push({ emitted: "div" });
      } else if (isClosing) {
        const idx = findLastOpen((emitted) => emitted === "div");
        if (idx !== -1) {
          while (openStack.length > idx) {
            const popped = openStack.pop()!;
            if (popped.emitted === "a-btn") {
              insideAnchor = Math.max(0, insideAnchor - 1);
              out.push("</button>");
            } else if (popped.emitted === "a-span") {
              insideAnchor = Math.max(0, insideAnchor - 1);
              out.push("</span>");
            } else {
              out.push(`</${popped.emitted}>`);
            }
          }
        }
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(rawTag)) continue;

    if (isClosing) {
      if (VOID_TAGS.has(rawTag)) continue;
      const idx = findLastOpen((emitted) => emitted === rawTag);
      if (idx !== -1) {
        while (openStack.length > idx) {
          const popped = openStack.pop()!;
          if (popped.emitted === "a-btn") {
            insideAnchor = Math.max(0, insideAnchor - 1);
            out.push("</button>");
          } else if (popped.emitted === "a-span") {
            insideAnchor = Math.max(0, insideAnchor - 1);
            out.push("</span>");
          } else {
            out.push(`</${popped.emitted}>`);
          }
        }
      }
      continue;
    }

    const attrs = parseAttributes(attrText);
    const serializedAttrs = sanitizeAllowedAttrs(rawTag, attrs);
    if (VOID_TAGS.has(rawTag)) {
      out.push(`<${rawTag}${serializedAttrs}>`);
    } else if (!selfClosing) {
      out.push(`<${rawTag}${serializedAttrs}>`);
      openStack.push({ emitted: rawTag });
    }
  }

  emitText(withoutStyles.slice(cursor));
  while (openStack.length > 0) {
    const popped = openStack.pop()!;
    if (popped.emitted === "a-btn") out.push("</button>");
    else if (popped.emitted === "a-span") out.push("</span>");
    else out.push(`</${popped.emitted}>`);
  }

  const bodyHtml = out.join("").trim();
  if (!bodyHtml) return undefined;
  const styleBlock = styles.length > 0 ? `<style>${styles.join("\n")}</style>` : "";
  return `${styleBlock}<div class="mail-canvas">${bodyHtml}</div>`;
}
