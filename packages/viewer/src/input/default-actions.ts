/**
 * Keep the interactive rrweb document inert as a navigation surface.
 *
 * Pointer/key relay is attached separately: cancelling these browser defaults must never cancel
 * the semantic input message sent to the authoritative remote browser.
 */
import { isTextEditable } from "./keys";
import { isElement } from "./pointer";

export interface DefaultActionContainmentOptions {
  doc: Document;
  /** The address of a link that should leave the mirror instead of being clicked remotely. */
  linkToOpen?(target: EventTarget | null): string | null;
  openLink?(url: string): void;
}

const isPlainPress = (event: MouseEvent): boolean =>
  event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;

/** Install capture-phase guards for browser defaults that can replace or escape the mirror. */
export function attachDefaultActionContainment(
  options: DefaultActionContainmentOptions,
): () => void {
  const onLinkActivation = (event: MouseEvent) => {
    if (closestNavigationLink(event.target) === null) return;
    event.preventDefault();
    if (!event.isTrusted || event.type !== "click" || !isPlainPress(event)) return;
    const url = options.linkToOpen?.(event.target);
    if (url) options.openLink?.(url);
  };
  // The press reaches the remote page, whose answer comes back through the mirror. Toggling here too
  // would send the state as a second change, and a page that toggles on click would flip back.
  const onControlActivation = (event: MouseEvent) => {
    if (togglesLocally(event.target)) event.preventDefault();
  };
  const onSubmit = (event: SubmitEvent) => event.preventDefault();
  const onDrop = (event: DragEvent) => {
    const types = event.dataTransfer?.types;
    if (types !== undefined && (types.includes("text/uri-list") || types.includes("Files"))) {
      event.preventDefault();
    }
  };

  options.doc.addEventListener("click", onLinkActivation, true);
  options.doc.addEventListener("click", onControlActivation, true);
  options.doc.addEventListener("auxclick", onLinkActivation, true);
  options.doc.addEventListener("submit", onSubmit, true);
  options.doc.addEventListener("drop", onDrop, true);
  return () => {
    options.doc.removeEventListener("click", onLinkActivation, true);
    options.doc.removeEventListener("click", onControlActivation, true);
    options.doc.removeEventListener("auxclick", onLinkActivation, true);
    options.doc.removeEventListener("submit", onSubmit, true);
    options.doc.removeEventListener("drop", onDrop, true);
  };
}

/** A checkbox or radio button, or a label that would activate one. */
export function togglesLocally(target: EventTarget | null): boolean {
  if (!isElement(target)) return false;
  const control =
    target.tagName.toLowerCase() === "input"
      ? (target as HTMLInputElement)
      : ((target.closest("label") as HTMLLabelElement | null)?.control ?? null);
  const type = (control as HTMLInputElement | null)?.type?.toLowerCase();
  return type === "checkbox" || type === "radio";
}

const REMOTE_ONLY_DOMAINS = ["claude.ai", "claude.com", "anthropic.com", "stripe.com"];

function staysInRemoteBrowser(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return REMOTE_ONLY_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * A link to somewhere else, for opening in this device's own browser. Claude, Anthropic and billing
 * links stay in the remote browser so neither login state nor the viewer's device IP crosses out.
 */
export function externalLink(
  target: EventTarget | null,
  pageUrl: string | undefined,
): string | null {
  const link = closestNavigationLink(target);
  if (!link) return null;
  const propHref = (link as HTMLAnchorElement & { href?: unknown }).href;
  const rawHref =
    typeof propHref === "string"
      ? propHref
      : typeof (propHref as { baseVal?: unknown } | null | undefined)?.baseVal === "string"
        ? (propHref as { baseVal: string }).baseVal
        : (link.getAttribute?.("href") ?? link.getAttribute?.("xlink:href") ?? "");
  if (!rawHref) return null;
  let url: URL;
  try {
    const base =
      pageUrl ?? (link as { ownerDocument?: { baseURI?: string } }).ownerDocument?.baseURI;
    url = base ? new URL(rawHref, base) : new URL(rawHref);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (staysInRemoteBrowser(url.hostname)) return null;
  try {
    if (pageUrl !== undefined && new URL(pageUrl).origin === url.origin) return null;
  } catch {
    // An address the tab has not settled on yet says nothing about this link.
  }
  return url.href;
}

/** Includes image-map areas and SVG anchors (`href` or `xlink:href`). */
export function closestNavigationLink(target: EventTarget | null): Element | null {
  if (!isElement(target)) return null;
  const standard = target.closest("a[href],area[href]");
  if (standard !== null) return standard;
  let cur: Element | null = target;
  while (cur !== null) {
    const tag = cur.tagName.toLowerCase();
    if (
      (tag === "a" || tag === "area") &&
      (cur.hasAttribute?.("href") === true || cur.hasAttribute?.("xlink:href") === true)
    ) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

/** Ordinary text and local editors can use the device's copy, paste and spelling menu. */
export function opensLocalTextMenu(target: EventTarget | null): boolean {
  if (!isElement(target) || closestNavigationLink(target)) return false;
  if (target.closest("button,summary,select,img,video,audio,canvas,[role=button],[role=menuitem]"))
    return false;
  if (isTextEditable(target)) return true;
  const selection = target.ownerDocument.getSelection();
  return (
    (selection !== null && !selection.isCollapsed && selection.containsNode(target, true)) ||
    Array.from(target.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && !!node.textContent?.trim(),
    )
  );
}
