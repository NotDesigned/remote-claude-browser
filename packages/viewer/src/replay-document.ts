/**
 * Ends the parser rrweb opens for each rebuilt replay document.
 *
 * rrweb rebuilds a full snapshot with `document.open()` and then appends the page's nodes,
 * doctype included, through the DOM. The parser never sees that doctype: closing it at that point
 * hands it end-of-file in its initial state, which puts the document in quirks mode. A page in
 * standards mode then lays out differently in the mirror; in particular a percentage height inside
 * an auto-height block (`min-height: 100%` under a scroll pane) resolves against an ancestor and
 * leaves blank, scrollable space below a pinned composer. Writing the page's own doctype first
 * lets the parser pick the same mode as the page; the existing doctype node stays the only one.
 * Closing also lets SVG animation timelines start.
 */
export function closeReplayDocument(doc: Document | null | undefined): void {
  if (!doc) return;
  // Only a parser that is still open may be written to: a write without one reopens the document,
  // which would wipe it.
  const doctype = doc.doctype;
  if (doc.readyState === "loading" && doctype !== null) {
    const Serializer = doc.defaultView?.XMLSerializer ?? globalThis.XMLSerializer;
    doc.write(new Serializer().serializeToString(doctype));
  }
  doc.close();
}
