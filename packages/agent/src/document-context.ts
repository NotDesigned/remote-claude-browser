import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";

interface SerializedNode {
  type: number;
  id: number;
  tagName?: string;
  childNodes?: SerializedNode[];
  documentUrl?: string;
  baseUrl?: string;
}

/**
 * Capture before rrweb remaps child-frame ids into the top document's namespace. The same walk
 * notes the frames it passes: the snapshot's, or each added tree's, in order. They are returned so
 * that nothing walks the trees again (see createReturnedDocumentCheck).
 */
export function captureDocumentContext(
  event: eventWithTime,
  nodeFor: (id: number) => Node | null,
): number[][] | undefined {
  const visit = (node: SerializedNode, frames: number[]): number[] => {
    if (node.type === 0) {
      const document = nodeFor(node.id);
      if (document?.nodeType === 9) {
        node.documentUrl = (document as Document).URL;
        node.baseUrl = document.baseURI;
      }
    } else if (node.tagName === "iframe") frames.push(node.id);
    for (const child of node.childNodes ?? []) visit(child, frames);
    return frames;
  };
  if (event.type === EventType.FullSnapshot)
    return [visit(event.data.node as unknown as SerializedNode, [])];
  if (
    event.type === EventType.IncrementalSnapshot &&
    event.data.source === IncrementalSource.Mutation
  ) {
    return event.data.adds.map((addition) => visit(addition.node as unknown as SerializedNode, []));
  }
  return undefined;
}
