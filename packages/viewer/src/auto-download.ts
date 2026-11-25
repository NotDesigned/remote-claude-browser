/**
 * Completed remote downloads are handed to this browser right away instead of waiting for a
 * "save" click; the gateway then keeps the file only for a short retry window.
 */
export const DOWNLOAD_NOTICE_MS = 15_000;

/**
 * A download link from the gateway, if it is one: same origin and under a session (`/s/…`). Anything
 * else is never followed, whatever the message says.
 */
export function safeDownloadHref(
  href: string | undefined,
  origin: string = globalThis.location?.origin ?? "http://localhost",
): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || !url.pathname.startsWith("/s/")) return null;
  return `${url.pathname}${url.search}`;
}

export function startClientDownload(href: string, name: string): void {
  const safe = safeDownloadHref(href);
  if (safe === null) return;
  const link = document.createElement("a");
  link.href = safe;
  link.download = name;
  link.rel = "noopener";
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}
