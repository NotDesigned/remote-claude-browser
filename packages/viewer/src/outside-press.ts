/**
 * Close-on-outside-press for menus and popovers.
 *
 * The mirrored page lives in an iframe (and its own frames in iframes inside that), and a press
 * there never reaches this document's listeners, so a menu would stay open over the page. Listen
 * in every same-origin frame too; a press in a frame we cannot reach still moves focus out of
 * this window, which `blur` reports.
 */
export function onOutsidePress(
  isInside: (target: EventTarget | null) => boolean,
  close: () => void,
  root: Document = document,
): () => void {
  const onPointer = (event: Event) => {
    if (!isInside(event.target)) close();
  };
  const documents = new Set<Document>();
  const collect = (doc: Document) => {
    if (documents.has(doc)) return;
    documents.add(doc);
    for (const frame of doc.querySelectorAll("iframe")) {
      try {
        if (frame.contentDocument) collect(frame.contentDocument);
      } catch {
        // Cross-origin: the window's blur covers it.
      }
    }
  };
  collect(root);
  for (const doc of documents) doc.addEventListener("pointerdown", onPointer, true);
  const view = root.defaultView;
  const onBlur = () => {
    // Focus went into a frame (or another window): only a frame press means "outside".
    if (root.activeElement instanceof HTMLIFrameElement) close();
  };
  view?.addEventListener("blur", onBlur);
  return () => {
    for (const doc of documents) doc.removeEventListener("pointerdown", onPointer, true);
    view?.removeEventListener("blur", onBlur);
  };
}
