/**
 * Completed remote downloads are handed to this browser right away instead of waiting for a
 * "save" click; the gateway then keeps the file only for a short retry window.
 */
export const DOWNLOAD_NOTICE_MS = 15_000;

export function startClientDownload(href: string, name: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.rel = "noopener";
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}
