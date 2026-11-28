import { useEffect, useRef } from "preact/hooks";

const ALLOWED_CLIENT_TAGS = new Set([
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
  "button",
]);

const ALLOWED_CLIENT_ATTRS = new Set([
  "class",
  "style",
  "align",
  "valign",
  "dir",
  "lang",
  "width",
  "height",
  "cellpadding",
  "cellspacing",
  "border",
  "colspan",
  "rowspan",
]);

const FORBIDDEN_CLIENT_CSS =
  /\\|url\s*\(|image\s*\(|image-set|cross-fade|src\s*\(|expression|javascript:|vbscript:|data:|-moz-binding|behavior|@import|@font-face/i;

const BASE_SHADOW_CSS = `
:host {
  display: block;
  color-scheme: light;
}
.mail-canvas {
  background: #ffffff;
  color: #1f2328;
  border: 1px solid rgba(127, 127, 127, 0.28);
  border-radius: 6px;
  padding: 14px 16px;
  overflow-x: auto;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: anywhere;
  user-select: text;
}
.mail-canvas table {
  max-width: 100%;
}
.mail-img-alt {
  display: inline-block;
  padding: 1px 6px;
  border: 1px dashed #cbd5e1;
  border-radius: 4px;
  color: #475569;
  font-size: 12px;
}
:where(button.mail-remote-link) {
  appearance: none;
  font: inherit;
  color: #0969da;
  background: transparent;
  border: none;
  padding: 0;
  margin: 0;
  text-align: inherit;
  text-decoration: underline;
  cursor: pointer;
  display: inline;
}
button.mail-remote-link {
  cursor: pointer;
}
button.mail-remote-link:hover {
  opacity: 0.88;
}
button.mail-remote-link:focus-visible {
  outline: 2px solid #0969da;
  outline-offset: 2px;
}
`;

export function isPrivateMailHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    /^(?:fe80|fc[0-9a-f]{2}|fd[0-9a-f]{2}):/i.test(host)
  ) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    ) {
      return true;
    }
  }
  return false;
}

function validRemoteUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (isPrivateMailHostname(parsed.hostname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function cloneSafeNode(source: Node, doc: Document): Node | null {
  if (source.nodeType === Node.TEXT_NODE) {
    return doc.createTextNode(source.textContent ?? "");
  }
  if (source.nodeType !== Node.ELEMENT_NODE) return null;
  const el = source as Element;
  const tag = el.tagName.toLowerCase();

  if (tag === "style") {
    const css = el.textContent ?? "";
    if (!css.trim() || FORBIDDEN_CLIENT_CSS.test(css)) return null;
    const styleEl = doc.createElement("style");
    styleEl.textContent = css;
    return styleEl;
  }

  if (tag === "a") {
    // Defense in depth: even if an <a> reached the client, convert it to a remote-only button.
    const url = validRemoteUrl(el.getAttribute("href"));
    const replacement = doc.createElement(url ? "button" : "span");
    if (url) {
      replacement.setAttribute("type", "button");
      replacement.className = "mail-remote-link";
      replacement.setAttribute("data-mail-url", url);
      replacement.setAttribute("title", `在远程浏览器打开：${url}`);
    }
    const style = el.getAttribute("style");
    if (style && !FORBIDDEN_CLIENT_CSS.test(style)) replacement.setAttribute("style", style);
    for (const child of Array.from(el.childNodes)) {
      const cloned = cloneSafeNode(child, doc);
      if (cloned) replacement.appendChild(cloned);
    }
    return replacement;
  }

  if (!ALLOWED_CLIENT_TAGS.has(tag)) return null;

  if (tag === "button") {
    const url = validRemoteUrl(el.getAttribute("data-mail-url"));
    if (!url) {
      const span = doc.createElement("span");
      for (const child of Array.from(el.childNodes)) {
        const cloned = cloneSafeNode(child, doc);
        if (cloned) span.appendChild(cloned);
      }
      return span;
    }
    const btn = doc.createElement("button");
    btn.setAttribute("type", "button");
    btn.setAttribute("data-mail-url", url);
    btn.setAttribute("title", `在远程浏览器打开：${url}`);
    const cls = el.getAttribute("class") ?? "";
    btn.setAttribute(
      "class",
      cls.includes("mail-remote-link") ? cls : `mail-remote-link ${cls}`.trim(),
    );
    const style = el.getAttribute("style");
    if (style && !FORBIDDEN_CLIENT_CSS.test(style)) btn.setAttribute("style", style);
    for (const child of Array.from(el.childNodes)) {
      const cloned = cloneSafeNode(child, doc);
      if (cloned) btn.appendChild(cloned);
    }
    return btn;
  }

  const copy = doc.createElement(tag);
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (!ALLOWED_CLIENT_ATTRS.has(name)) continue;
    if (name === "style" && FORBIDDEN_CLIENT_CSS.test(attr.value)) continue;
    copy.setAttribute(name, attr.value);
  }
  for (const child of Array.from(el.childNodes)) {
    const cloned = cloneSafeNode(child, doc);
    if (cloned) copy.appendChild(cloned);
  }
  return copy;
}

export function extractSanitizedHtmlLinks(html: string | undefined): string[] {
  if (!html) return [];
  const seen = new Set<string>();
  const links: string[] = [];
  for (const match of html.matchAll(/data-mail-url="([^"]+)"/g)) {
    const decoded = match[1]!
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    const valid = validRemoteUrl(decoded);
    if (valid && !seen.has(valid)) {
      seen.add(valid);
      links.push(valid);
    }
  }
  return links;
}

export function MailHtmlView({
  html,
  onActivateLink,
}: {
  html: string;
  onActivateLink(url: string): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onActivateLink);
  callbackRef.current = onActivateLink;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    while (shadow.firstChild) shadow.removeChild(shadow.firstChild);

    const baseStyle = document.createElement("style");
    baseStyle.textContent = BASE_SHADOW_CSS;
    shadow.appendChild(baseStyle);

    // Parse in an inert detached HTMLDocument (zero network fetches, zero script execution),
    // then rebuild clean allowlisted DOM nodes into the isolated ShadowRoot.
    const parsed = new DOMParser().parseFromString(html, "text/html");
    for (const styleNode of Array.from(parsed.head.querySelectorAll("style"))) {
      const cloned = cloneSafeNode(styleNode, document);
      if (cloned) shadow.appendChild(cloned);
    }
    for (const child of Array.from(parsed.body.childNodes)) {
      const cloned = cloneSafeNode(child, document);
      if (cloned) shadow.appendChild(cloned);
    }

    const onClick = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest("[data-mail-url]");
      if (!button) return;
      event.preventDefault();
      const url = validRemoteUrl(button.getAttribute("data-mail-url"));
      if (url) callbackRef.current(url);
    };
    shadow.addEventListener("click", onClick);
    return () => shadow.removeEventListener("click", onClick);
  }, [html]);

  return <div ref={hostRef} class="mailbox-html-host" data-mail-html-view="true" />;
}
