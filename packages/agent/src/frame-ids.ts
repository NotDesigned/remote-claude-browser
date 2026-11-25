/**
 * Keeps the ids a cross-origin frame's document had before it was sent again.
 *
 * rrweb gives a child frame's nodes new ids in the parent each time the child sends its whole
 * document, and forgets the old ones. A frame inside a frame does that at each level, and every
 * snapshot of the page above has the frames below send theirs again. The viewer keeps showing the
 * old ids until the new document reaches it, so a scroll or press made in that moment named nodes
 * no frame knew any more, and was dropped: the mirror then went back to where the page still was.
 *
 * When a child sends the same document again (a checkout), its own ids still name the same nodes.
 * The parent keeps the old id -> remote id maps of the last few documents for it, and resolves a
 * stale id through them. A child that loaded a new document starts its ids again, so its frame's
 * old maps are dropped instead: an old id must not reach a different node.
 */

/** The parts of rrweb's CrossOriginIframeMirror this uses. */
export interface ResettableIframeMirror {
  iframeRemoteIdToIdMap?: WeakMap<HTMLIFrameElement, Map<number, number>>;
  getRemoteId(iframe: HTMLIFrameElement, id: number, map?: Map<number, number>): number;
  reset(iframe?: HTMLIFrameElement, sameDocument?: boolean): void;
}

/** Documents sent before the current one whose ids still resolve. */
export const RETAINED_DOCUMENTS = 2;

const retaining = new WeakSet<object>();

export function retainCheckoutIds<T extends ResettableIframeMirror>(mirror: T): T {
  if (retaining.has(mirror)) return mirror;
  retaining.add(mirror);
  let retired = new WeakMap<HTMLIFrameElement, Map<number, number>[]>();
  const reset = mirror.reset.bind(mirror);
  const getRemoteId = mirror.getRemoteId.bind(mirror);
  mirror.reset = (iframe, sameDocument = false) => {
    if (iframe === undefined) retired = new WeakMap();
    else if (!sameDocument) retired.delete(iframe);
    else {
      const current = mirror.iframeRemoteIdToIdMap?.get(iframe);
      const kept = retired.get(iframe) ?? [];
      if (current !== undefined && current.size > 0)
        retired.set(iframe, [current, ...kept].slice(0, RETAINED_DOCUMENTS));
    }
    reset(iframe);
  };
  mirror.getRemoteId = (iframe, id, map) => {
    const remoteId = getRemoteId(iframe, id, map);
    // A caller's own map asks about that map alone.
    if (remoteId !== -1 || map !== undefined || typeof id !== "number") return remoteId;
    for (const old of retired.get(iframe) ?? []) {
      const found = old.get(id);
      if (found !== undefined) return found;
    }
    return -1;
  };
  return mirror;
}
