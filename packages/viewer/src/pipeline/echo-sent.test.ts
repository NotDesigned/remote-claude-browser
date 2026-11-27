// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";
import { createEchoFilter } from "./echo";

/** An editor whose text nodes are known by rrweb id. */
class FakeEditor {
  readonly nodeType = 1;
  readonly tagName = "DIV";
  readonly isContentEditable = true;
  textContent = "";
  readonly children = new Map<number, { textContent: string }>();
  contains(node: unknown): boolean {
    return [...this.children.values()].includes(node as { textContent: string });
  }
  nodeFor = (id: number) => (this.children.get(id) ?? null) as Node | null;
}

function batch(data: {
  texts?: Array<{ id: number; value: string }>;
  removes?: Array<{ parentId: number; id: number }>;
  adds?: Array<{ parentId: number; nextId: number | null; node: object }>;
}): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: 1,
    data: {
      source: IncrementalSource.Mutation,
      texts: data.texts ?? [],
      attributes: [],
      removes: data.removes ?? [],
      adds: data.adds ?? [],
    },
  } as eventWithTime;
}

function setup() {
  let time = 0;
  const reconcile = vi.fn(() => true);
  const editor = new FakeEditor();
  const echo = createEchoFilter({
    now: () => time,
    onContenteditableReconcile: reconcile,
    nodeFor: editor.nodeFor,
  });
  const focus = {
    element: editor as unknown as HTMLElement,
    nodeId: 20,
    subtreeNodeIds: new Set([20, 21, 22]),
  };
  editor.children.set(22, { textContent: "first question" });
  editor.textContent = "first question";
  echo.setFocused(focus);
  echo.input(focus);
  const at = (ms: number) => {
    time = ms;
    return { tab: "T1", nowMs: ms };
  };
  return { echo, editor, focus, reconcile, at };
}

describe("the page clearing an editor after Enter sent its text", () => {
  it("asks for the page's editor at once instead of after typing settles", () => {
    const { echo, editor, focus, reconcile, at } = setup();
    at(200);
    echo.keyDown({ key: "Enter" } as KeyboardEvent, focus);
    // Typing goes straight on while the page's clear is on its way.
    at(250);
    editor.textContent = "first questionn";
    echo.input(focus);
    const cleared = batch({
      removes: [{ parentId: 21, id: 22 }],
      adds: [
        { parentId: 21, nextId: null, node: { id: 30, type: 2, tagName: "br", childNodes: [] } },
      ],
    });
    expect(echo(cleared, at(300))).toBeNull();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("knows the text the page had put in nodes this replay never got", () => {
    const { echo, editor, focus, reconcile, at } = setup();
    // The page's own text node for what was typed, held back as an echo.
    expect(
      echo(
        batch({
          adds: [
            {
              parentId: 21,
              nextId: null,
              node: {
                id: 31,
                type: 2,
                tagName: "span",
                childNodes: [{ id: 32, type: 3, textContent: "first question" }],
              },
            },
          ],
        }),
        at(100),
      ),
    ).toBeNull();
    echo.keyDown({ key: "Enter" } as KeyboardEvent, focus);
    editor.textContent = "first question";
    expect(echo(batch({ removes: [{ parentId: 21, id: 31 }] }), at(300))).toBeNull();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("waits as before when the page keeps the text, or without Enter", () => {
    const { echo, focus, reconcile, at } = setup();
    // The page re-renders the text in new nodes: not a clear.
    echo.keyDown({ key: "Enter" } as KeyboardEvent, focus);
    echo(
      batch({
        removes: [{ parentId: 21, id: 22 }],
        adds: [
          { parentId: 21, nextId: null, node: { id: 33, type: 3, textContent: "first question" } },
        ],
      }),
      at(100),
    );
    // Shift+Enter is a new line, not a send.
    const other = setup();
    other.echo.keyDown({ key: "Enter", shiftKey: true } as KeyboardEvent, other.focus);
    other.echo(batch({ removes: [{ parentId: 21, id: 22 }] }), other.at(100));
    // Enter too long ago.
    const late = setup();
    late.echo.keyDown({ key: "Enter" } as KeyboardEvent, late.focus);
    late.echo.input(late.focus);
    late.at(6_000);
    late.echo.input(late.focus);
    late.echo(batch({ removes: [{ parentId: 21, id: 22 }] }), late.at(6_100));
    expect(
      [reconcile, other.reconcile, late.reconcile].map((spy) => spy.mock.calls.length),
    ).toEqual([0, 0, 0]);
  });

  it("asks again once a reconcile already on its way has settled", () => {
    const { echo, editor, focus, reconcile, at } = setup();
    echo.keyDown({ key: "Enter" } as KeyboardEvent, focus);
    echo(batch({ removes: [{ parentId: 21, id: 22 }] }), at(100));
    expect(reconcile).toHaveBeenCalledOnce();
    // The next message is sent and cleared before that reconcile has come back.
    editor.children.set(23, { textContent: "second" });
    editor.textContent = "second";
    focus.subtreeNodeIds.add(23);
    echo.input(focus);
    echo.keyDown({ key: "Enter" } as KeyboardEvent, focus);
    echo(batch({ removes: [{ parentId: 21, id: 23 }] }), at(300));
    expect(reconcile).toHaveBeenCalledOnce();
    echo.settled();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("asks again for a clear held back while a reconcile was on its way, though not seen as one", () => {
    const { echo, editor, focus, reconcile, at } = setup();
    echo.keyDown({ key: "Enter" } as KeyboardEvent, focus);
    echo(batch({ removes: [{ parentId: 21, id: 22 }] }), at(100));
    expect(reconcile).toHaveBeenCalledOnce();
    // The catch-up is late (typing went on): this replay's editor still holds every message since,
    // so the page clearing only the last of them is not the text Enter sent here.
    editor.children.set(23, { textContent: "fifth" });
    editor.textContent = "first questionfifth";
    focus.subtreeNodeIds.add(23);
    at(900);
    echo.input(focus);
    echo.keyDown({ key: "Enter" } as KeyboardEvent, focus);
    expect(echo(batch({ texts: [{ id: 23, value: "" }] }), at(1_000))).toBeNull();
    expect(reconcile).toHaveBeenCalledOnce();
    // The catch-up asked for before that clear is applied, and drops what was held back: the
    // replay would show "fifth" in a composer the page has cleared.
    echo.settled();
    expect(reconcile).toHaveBeenCalledTimes(2);
    // That one comes from after the clear, and nothing more is held: no third.
    echo.settled();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
