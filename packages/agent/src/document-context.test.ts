import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";
import { expect, it } from "vitest";
import { captureDocumentContext } from "./document-context";

it("keeps each document's URL and base through snapshots and late iframe documents", () => {
  const root = { type: 0, id: 1, childNodes: [{ type: 0, id: 2 }] };
  const child = { type: 0, id: 3 };
  const urls = new Map([
    [1, ["https://icloud.example/", "https://icloud.example/"]],
    [2, ["https://icloud.example/embedded", "https://cdn.example/"]],
    [3, ["https://appleid.example/widget/", "https://appleid.example/widget/"]],
  ]);
  const nodeFor = (id: number) => {
    const [URL, baseURI] = urls.get(id)!;
    return { nodeType: 9, URL, baseURI } as Document;
  };
  captureDocumentContext(
    { type: EventType.FullSnapshot, data: { node: root } } as eventWithTime,
    nodeFor,
  );
  captureDocumentContext(
    {
      type: EventType.IncrementalSnapshot,
      data: { source: IncrementalSource.Mutation, adds: [{ node: child }] },
    } as eventWithTime,
    nodeFor,
  );
  expect(root).toMatchObject({ documentUrl: urls.get(1)![0], baseUrl: urls.get(1)![1] });
  expect(root.childNodes[0]).toMatchObject({
    documentUrl: urls.get(2)![0],
    baseUrl: urls.get(2)![1],
  });
  expect(child).toMatchObject({ documentUrl: urls.get(3)![0], baseUrl: urls.get(3)![1] });
});

it("returns the frames of each tree it walks, so they need no second walk", () => {
  const frame = (id: number, ...childNodes: unknown[]) => ({
    type: 2,
    id,
    tagName: "iframe",
    childNodes,
  });
  const none = () => null;
  expect(
    captureDocumentContext(
      {
        type: EventType.FullSnapshot,
        data: { node: { type: 0, id: 1, childNodes: [frame(5), { type: 2, id: 6 }] } },
      } as unknown as eventWithTime,
      none,
    ),
  ).toEqual([[5]]);
  expect(
    captureDocumentContext(
      {
        type: EventType.IncrementalSnapshot,
        data: {
          source: IncrementalSource.Mutation,
          adds: [
            { node: { type: 2, id: 7, tagName: "div", childNodes: [frame(8)] } },
            { node: { type: 3, id: 9 } },
          ],
        },
      } as unknown as eventWithTime,
      none,
    ),
  ).toEqual([[8], []]);
  expect(
    captureDocumentContext({ type: EventType.Meta, data: {} } as unknown as eventWithTime, none),
  ).toBeUndefined();
});
