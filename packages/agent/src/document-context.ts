import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";

interface SerializedNode {
  type: number;
  id: number;
  childNodes?: SerializedNode[];
  documentUrl?: string;
  baseUrl?: string;
}

/** Capture before rrweb remaps child-frame ids into the top document's namespace. */
export function captureDocumentContext(
  event: eventWithTime,
  nodeFor: (id: number) => Node | null,
): void {
  const visit = (node: SerializedNode): void => {
    if (node.type === 0) {
      const document = nodeFor(node.id);
      if (document?.nodeType === 9) {
        node.documentUrl = (document as Document).URL;
        node.baseUrl = document.baseURI;
      }
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  if (event.type === EventType.FullSnapshot) visit(event.data.node);
  else if (
    event.type === EventType.IncrementalSnapshot &&
    event.data.source === IncrementalSource.Mutation
  ) {
    for (const addition of event.data.adds) visit(addition.node);
  }
}
