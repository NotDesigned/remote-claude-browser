/**
 * Keep the interactive rrweb document inert as a navigation surface.
 *
 * Pointer/key relay is attached separately: cancelling these browser defaults must never cancel
 * the semantic input message sent to the authoritative remote browser.
 */
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
  const onSubmit = (event: SubmitEvent) => event.preventDefault();
  const onDrop = (event: DragEvent) => {
    const types = event.dataTransfer?.types;
    if (types !== undefined && (types.includes("text/uri-list") || types.includes("Files"))) {
      event.preventDefault();
    }
  };

  options.doc.addEventListener("click", onLinkActivation, true);
  options.doc.addEventListener("auxclick", onLinkActivation, true);
  options.doc.addEventListener("submit", onSubmit, true);
  options.doc.addEventListener("drop", onDrop, true);
  return () => {
    options.doc.removeEventListener("click", onLinkActivation, true);
    options.doc.removeEventListener("auxclick", onLinkActivation, true);
    options.doc.removeEventListener("submit", onSubmit, true);
    options.doc.removeEventListener("drop", onDrop, true);
  };
}

/**
 * A link to somewhere else, for opening in this device's own browser. Claude's own links are left to
 * the remote browser, which has the login they need, and so is moving around within a site.
 */
export function externalLink(
  target: EventTarget | null,
  pageUrl: string | undefined,
): string | null {
  const href = (closestNavigationLink(target) as HTMLAnchorElement | null)?.href;
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === "claude.ai" || url.hostname.endsWith(".claude.ai")) return null;
  try {
    if (pageUrl !== undefined && new URL(pageUrl).origin === url.origin) return null;
  } catch {
    // An address the tab has not settled on yet says nothing about this link.
  }
  return url.href;
}

/** Includes image-map areas; anchor descendants are the ordinary rrweb replay case. */
export function closestNavigationLink(target: EventTarget | null): Element | null {
  return isElement(target) ? target.closest("a[href],area[href]") : null;
}
