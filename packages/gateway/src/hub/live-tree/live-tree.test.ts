import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EventType,
  IncrementalSource,
  REMOTE_FOCUS_EVENT,
  WORKING_MARK_ANIMATION,
  type AgentMsg,
  type eventWithTime,
} from "@mirror/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveTree, TreeBroken } from "./live-tree";
import { subtreeEvents, synthesize, synthesizeFresh } from "./synthesize";

type N = Record<string, unknown>;
const el = (id: number, tagName: string, attributes: N = {}, childNodes: N[] = []): N => ({
  type: 2,
  id,
  tagName,
  attributes,
  childNodes,
});
const text = (id: number, textContent: string, extra: N = {}): N => ({
  type: 3,
  id,
  textContent,
  ...extra,
});
const doc = (id: number, childNodes: N[]): N => ({ type: 0, id, childNodes });
const doctype = (id: number): N => ({ type: 1, id, name: "html", publicId: "", systemId: "" });

let clock = 100;
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
const meta = (width = 800, height = 600) =>
  deepFreeze({
    type: EventType.Meta,
    timestamp: 1,
    data: { href: "https://example.test/", width, height },
  } as eventWithTime);
const full = (node: N, left = 0, top = 0) =>
  deepFreeze({
    type: EventType.FullSnapshot,
    timestamp: 2,
    data: { node, initialOffset: { left, top } },
  } as unknown as eventWithTime);
const incremental = (source: number, data: N): eventWithTime =>
  deepFreeze({
    type: EventType.IncrementalSnapshot,
    timestamp: ++clock,
    data: { source, ...data },
  } as unknown as eventWithTime);
const mutation = (data: N) =>
  incremental(IncrementalSource.Mutation, {
    texts: [],
    attributes: [],
    removes: [],
    adds: [],
    ...data,
  });
const add = (parentId: number, node: N, nextId: number | null = null, previousId?: number) => ({
  parentId,
  nextId,
  ...(previousId === undefined ? {} : { previousId }),
  node,
});

/** html > head, body#4 > [div#5 > text#6 "a", p#7] */
function basicPage(): N {
  return doc(1, [
    doctype(2),
    el(3, "html", {}, [
      el(10, "head", {}, []),
      el(4, "body", {}, [el(5, "div", { class: "a" }, [text(6, "a")]), el(7, "p")]),
    ]),
  ]);
}

function seeded(node: N = basicPage(), opts = {}) {
  return LiveTree.seed(meta(), full(node), { checkInvariants: true, ...opts });
}

/** The synthesized FullSnapshot's root node, as a plain object. */
function shown(tree: LiveTree): N {
  return JSON.parse(JSON.stringify(synthesizeFresh(tree).events[1]!.data)).node as N;
}

function find(node: N, id: number): N | undefined {
  if (node.id === id) return node;
  for (const child of (node.childNodes as N[] | undefined) ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return undefined;
}
const nodeOf = (event: eventWithTime) => (event.data as unknown as { node: N }).node;
const childIds = (node: N | undefined) => ((node?.childNodes as N[]) ?? []).map((n) => n.id);

/** A tree built from the synthesized events equals the tree it came from. */
function roundTrip(tree: LiveTree): void {
  const events = synthesizeFresh(tree).events;
  const again = LiveTree.seed(events[0]!, events[1]!, { checkInvariants: true });
  for (const event of events.slice(2)) again.apply(event);
  expect(JSON.parse(JSON.stringify(synthesizeFresh(again).events.slice(0, 2)))).toEqual(
    JSON.parse(JSON.stringify(events.slice(0, 2))),
  );
  expect(tree.compare(events[0]!, events[1]!, events.slice(2))).toEqual([]);
}

afterEach(() => vi.useRealTimers());

describe("LiveTree seed and synthesize", () => {
  it("synthesizes exactly what it was seeded with", () => {
    const page = basicPage();
    const tree = seeded(page);
    expect(shown(tree)).toEqual(page);
    const events = synthesizeFresh(tree).events;
    expect(events.map((event) => event.type)).toEqual([EventType.Meta, EventType.FullSnapshot]);
    expect(events[0]!.data).toEqual({ href: "https://example.test/", width: 800, height: 600 });
    roundTrip(tree);
  });

  it("never writes to the events it ingests, and its output never changes afterwards", () => {
    const tree = seeded();
    const before = synthesizeFresh(tree);
    const frozen = JSON.stringify(before.events);
    tree.apply(mutation({ adds: [add(4, el(20, "span", { id: "x" }))] }));
    tree.apply(mutation({ attributes: [{ id: 5, attributes: { class: "b" } }] }));
    tree.apply(mutation({ texts: [{ id: 6, value: "changed" }] }));
    tree.apply(mutation({ removes: [{ parentId: 4, id: 7 }] }));
    expect(JSON.stringify(before.events)).toBe(frozen);
    // And the added node is the tree's own copy.
    const added = tree.nodes.get(20)!;
    expect(Object.isFrozen(added)).toBe(false);
  });

  it("keeps the recorder's snapshot-only synthetic font style", () => {
    const fontStyle = el(1_000_000_000, "style", { _cssText: "@font-face{font-family:x}" }, []);
    const page = basicPage();
    ((page.childNodes as N[])[1]!.childNodes as N[])[0]!.childNodes = [fontStyle];
    const tree = seeded(page);
    tree.apply(mutation({ adds: [add(10, el(21, "meta"))] }));
    expect(find(shown(tree), 1_000_000_000)).toEqual(fontStyle);
    roundTrip(tree);
  });

  it("memoizes until something a snapshot holds changes", () => {
    vi.useFakeTimers();
    const tree = seeded();
    const first = synthesize(tree);
    tree.apply(incremental(IncrementalSource.MouseMove, { positions: [{ x: 1, y: 1 }] }));
    expect(synthesize(tree)).toBe(first);
    tree.apply(mutation({ texts: [{ id: 6, value: "b" }] }));
    const second = synthesize(tree);
    expect(second).not.toBe(first);
    expect(find(nodeOf(second.events[1]!), 6)!.textContent).toBe("b");
    vi.advanceTimersByTime(2_500);
    expect(synthesize(tree)).not.toBe(second);
  });

  it("externalizes large sheets of the top document by hash", () => {
    const big = "a{color:red}".repeat(2_000);
    const page = basicPage();
    ((page.childNodes as N[])[1]!.childNodes as N[])[0]!.childNodes = [
      el(30, "style", { _cssText: big }, []),
    ];
    const tree = seeded(page);
    const { events, sheets } = synthesizeFresh(tree);
    const style = find(nodeOf(events[1]!), 30)!;
    expect((style.attributes as N)._cssText).toBeUndefined();
    const hash = (style.attributes as N)._cssRef as string;
    expect(sheets.get(hash)).toBe(big);
  });
});

describe("LiveTree mutations", () => {
  it("places adds by next sibling, waiting for siblings and parents that come later", () => {
    const tree = seeded();
    // Recorded order: a child before its parent, a node before the next sibling it names.
    tree.apply(
      mutation({
        adds: [
          add(21, text(22, "inner")),
          add(4, el(23, "b"), 24),
          add(4, el(24, "i"), 7),
          add(4, el(21, "section"), 5),
        ],
      }),
    );
    expect(childIds(find(shown(tree), 4))).toEqual([21, 5, 23, 24, 7]);
    expect(childIds(find(shown(tree), 21))).toEqual([22]);
    expect(tree.anomalies.orphanAdd).toBe(0);
    roundTrip(tree);
  });

  it("places by previous sibling when it has a next one", () => {
    const tree = seeded();
    tree.apply(mutation({ adds: [add(4, el(20, "hr"), null, 5)] }));
    expect(childIds(find(shown(tree), 4))).toEqual([5, 20, 7]);
  });

  it("drops quietly what was added under a node removed in the same batch", () => {
    const tree = seeded();
    tree.apply(
      mutation({
        removes: [{ parentId: 4, id: 5 }],
        adds: [add(5, el(20, "span")), add(20, text(21, "x"))],
      }),
    );
    expect(tree.has(5)).toBe(false);
    expect(tree.has(6)).toBe(false);
    expect(tree.has(20)).toBe(false);
    expect(tree.anomalies.orphanAdd).toBe(0);
  });

  it("counts adds whose parent never arrives, and breaks past the limit", () => {
    const tree = seeded(basicPage(), { maxOrphans: 2 });
    tree.apply(mutation({ adds: [add(999, el(20, "span"))] }));
    expect(tree.anomalies.orphanAdd).toBe(1);
    expect(tree.has(20)).toBe(false);
    // A next sibling that never arrives either.
    tree.apply(mutation({ adds: [add(4, el(21, "span"), 998)] }));
    expect(tree.anomalies.orphanAdd).toBe(2);
    expect(() => tree.apply(mutation({ adds: [add(997, el(22, "span"))] }))).toThrow(TreeBroken);
  });

  it("removes subtrees and lets ids be used again", () => {
    const tree = seeded();
    tree.apply(mutation({ removes: [{ parentId: 4, id: 5 }] }));
    expect(tree.has(6)).toBe(false);
    tree.apply(mutation({ adds: [add(4, el(5, "div", { class: "new" }))] }));
    expect(find(shown(tree), 5)).toEqual(el(5, "div", { class: "new" }));
    roundTrip(tree);
  });

  it("moves a node it already has", () => {
    const tree = seeded();
    tree.apply(mutation({ adds: [add(7, el(5, "div", { class: "a" }))] }));
    expect(tree.anomalies.move).toBe(1);
    expect(childIds(find(shown(tree), 4))).toEqual([7]);
    expect(childIds(find(shown(tree), 7))).toEqual([5]);
    expect(childIds(find(shown(tree), 5))).toEqual([6]);
    expect(() => tree.apply(mutation({ adds: [add(5, el(4, "body"))] }))).toThrow("cycle");
  });

  it("applies texts (last value wins) and attributes, null deleting", () => {
    const tree = seeded();
    tree.apply(
      mutation({
        texts: [
          { id: 6, value: "first" },
          { id: 6, value: "last" },
        ],
        attributes: [{ id: 5, attributes: { class: null, "data-x": "1" } }],
      }),
    );
    expect(find(shown(tree), 6)!.textContent).toBe("last");
    expect(find(shown(tree), 5)!.attributes).toEqual({ "data-x": "1" });
    roundTrip(tree);
  });

  it("applies inline style diffs and counts the uncertain ones", () => {
    const tree = seeded();
    tree.apply(
      mutation({ attributes: [{ id: 5, attributes: { style: "margin: 0; color: red" } }] }),
    );
    tree.apply(
      mutation({
        attributes: [
          { id: 5, attributes: { style: { color: "blue", width: ["2px", "important"] } } },
        ],
      }),
    );
    expect((find(shown(tree), 5)!.attributes as N).style).toBe(
      "margin: 0; color: blue; width: 2px !important;",
    );
    expect(tree.anomalies.styleUncertain).toBe(0);
    tree.apply(
      mutation({ attributes: [{ id: 5, attributes: { style: { "margin-left": false } } }] }),
    );
    expect(tree.anomalies.styleUncertain).toBe(1);
    expect((find(shown(tree), 5)!.attributes as N).style).toBe(
      "color: blue; width: 2px !important;",
    );
  });

  it("gives a textarea one text, and its value attribute replaces its text", () => {
    const page = basicPage();
    ((page.childNodes as N[])[1]!.childNodes as N[])[1]!.childNodes = [
      el(30, "textarea", {}, [text(31, "old")]),
    ];
    const tree = seeded(page);
    tree.apply(mutation({ adds: [add(30, text(32, "new"))] }));
    expect(childIds(find(shown(tree), 30))).toEqual([32]);
    tree.apply(mutation({ attributes: [{ id: 30, attributes: { value: "typed" } }] }));
    expect(find(shown(tree), 30)).toEqual(el(30, "textarea", { value: "typed" }, []));
  });

  it("gives a style built from its sheet text its parts before they change", () => {
    const page = basicPage();
    ((page.childNodes as N[])[1]!.childNodes as N[])[0]!.childNodes = [
      el(30, "style", { _cssText: "a{}/* rr_split */b{}" }, [
        text(31, "", { isStyle: true }),
        text(32, "", { isStyle: true }),
      ]),
      el(33, "style", { _cssText: "c{}" }, []),
    ];
    const tree = seeded(page);
    tree.apply(mutation({ texts: [{ id: 32, value: "b{color:red}" }] }));
    const style = find(shown(tree), 30)!;
    expect(style.attributes).toEqual({});
    expect((style.childNodes as N[]).map((child) => child.textContent)).toEqual([
      "a{}",
      "b{color:red}",
    ]);
    // A text added to a style with none takes the style's unmapped text.
    tree.apply(mutation({ adds: [add(33, text(34, "ignored", { isStyle: true }))] }));
    const other = find(shown(tree), 33)!;
    expect(other.attributes).toEqual({});
    expect((other.childNodes as N[])[0]!.textContent).toBe("c{}");
    roundTrip(tree);
  });

  it("replaces a document's doctype and <html>", () => {
    const tree = seeded();
    tree.apply(mutation({ adds: [add(1, doctype(40), 3), add(1, el(41, "html"))] }));
    expect(childIds(shown(tree))).toEqual([40, 41]);
    expect(tree.has(4)).toBe(false);
  });

  it("does not place rrweb's legacy -1 siblings", () => {
    const tree = seeded();
    tree.apply(mutation({ adds: [add(4, el(20, "span"), -1)] }));
    expect(tree.has(20)).toBe(false);
    expect(tree.anomalies.legacy).toBe(1);
  });

  it("skips changes to unknown nodes, as the Replayer does", () => {
    const tree = seeded();
    tree.apply(
      mutation({
        texts: [{ id: 500, value: "x" }],
        attributes: [{ id: 501, attributes: { a: "b" } }],
        removes: [{ parentId: 4, id: 502 }],
      }),
    );
    expect(tree.anomalies.unknownTarget).toBe(3);
  });

  it("breaks where the Replayer would throw or the tree cannot follow", () => {
    const broken = (data: N, kind: string) => {
      const tree = seeded();
      try {
        tree.apply(mutation(data));
      } catch (error) {
        expect(error).toBeInstanceOf(TreeBroken);
        expect((error as TreeBroken).kind).toBe(kind);
        return;
      }
      throw new Error(`no TreeBroken(${kind})`);
    };
    broken({ removes: [{ parentId: 3, id: 5 }] }, "remove-parent");
    broken({ adds: [add(6, el(20, "span"))] }, "non-container");
    broken({ adds: [add(3, el(20, "span"), null, 5)] }, "insert");
    broken({ adds: [add(4, el(20, "span"), 6)] }, "insert");
    broken({ attributes: [{ id: 6, attributes: { a: "b" } }] }, "attribute-on-non-element");
    broken({ texts: [{ id: 5, value: "x" }] }, "text-on-container");
    broken({ adds: [add(4, { type: 2, tagName: "x" })] }, "malformed-node");
  });
});

describe("LiveTree shadow roots and frames", () => {
  it("keeps shadow children apart from the host's own, nested too", () => {
    const tree = seeded();
    tree.apply(
      mutation({
        adds: [
          add(7, el(20, "slot", {}, []), null),
          add(7, { ...el(21, "span"), isShadow: true }),
          add(21, { ...el(22, "b"), isShadow: false }),
          add(22, { ...text(23, "deep"), isShadow: true }),
        ],
      }),
    );
    const host = find(shown(tree), 7)!;
    expect(host.isShadowHost).toBe(true);
    expect(childIds(host)).toEqual([20, 21]);
    expect((host.childNodes as N[])[1]!.isShadow).toBe(true);
    const nested = find(shown(tree), 22)!;
    expect(nested.isShadowHost).toBe(true);
    // Placing before a light child from inside the shadow root appends instead.
    tree.apply(mutation({ adds: [add(7, { ...el(24, "i"), isShadow: true }, 20)] }));
    expect(childIds(find(shown(tree), 7))).toEqual([20, 21, 24]);
    tree.apply(mutation({ removes: [{ parentId: 7, id: 21, isShadow: true }] }));
    expect(tree.has(23)).toBe(false);
    roundTrip(tree);
  });

  it("attaches frame documents, outer first, and replaces them on reattach", () => {
    const tree = seeded();
    tree.apply(mutation({ adds: [add(4, el(50, "iframe", { src: "about:blank" }))] }));
    tree.apply(
      mutation({
        isAttachIframe: true,
        adds: [
          add(50, doc(51, [el(52, "html", {}, [el(53, "body", {}, [el(54, "iframe", {}, [])])])])),
        ],
      }),
    );
    // The inner frame's document arrives before its iframe exists in one test, after in another.
    tree.apply(
      mutation({ isAttachIframe: true, adds: [add(54, doc(55, [el(56, "html", {}, [])]))] }),
    );
    let events = synthesizeFresh(tree).events;
    const attaches = events.slice(2).map((event) => (event.data as N).adds as N[]);
    expect(attaches.map((adds) => adds[0]!.parentId)).toEqual([50, 54]);
    expect(find(nodeOf(events[1]!), 50)!.childNodes).toEqual([]);
    roundTrip(tree);

    tree.apply(mutation({ isAttachIframe: true, adds: [add(50, doc(60, [el(61, "html")]))] }));
    expect(tree.has(51)).toBe(false);
    expect(tree.has(56)).toBe(false);
    events = synthesizeFresh(tree).events;
    expect(events).toHaveLength(3);
    tree.apply(mutation({ removes: [{ parentId: 4, id: 50 }] }));
    expect(tree.has(60)).toBe(false);
    expect(tree.frames.size).toBe(0);
  });

  it("attaches a document that arrived before its iframe", () => {
    const tree = seeded();
    tree.apply(mutation({ isAttachIframe: true, adds: [add(70, doc(71, [el(72, "html")]))] }));
    tree.apply(mutation({ adds: [add(4, el(70, "iframe"))] }));
    expect(tree.frames.get(70)?.id).toBe(71);
  });
});

describe("LiveTree folds", () => {
  it("folds input into form state as a snapshot records it", () => {
    const page = basicPage();
    ((page.childNodes as N[])[1]!.childNodes as N[])[1]!.childNodes = [
      el(30, "input", { type: "text" }),
      el(31, "input", { type: "checkbox", checked: true }),
      el(32, "select", {}, [
        el(33, "option", { value: "a", selected: true }),
        el(34, "option", {}, [text(35, " b ")]),
      ]),
    ];
    const tree = seeded(page);
    const input = (id: number, text: string, isChecked = false) =>
      tree.apply(incremental(IncrementalSource.Input, { id, text, isChecked }));
    input(30, "hello");
    input(31, "on", false);
    input(32, "b");
    const out = shown(tree);
    expect((find(out, 30)!.attributes as N).value).toBe("hello");
    expect((find(out, 31)!.attributes as N).checked).toBeUndefined();
    expect((find(out, 33)!.attributes as N).selected).toBeUndefined();
    expect((find(out, 34)!.attributes as N).selected).toBe(true);
    input(30, "");
    expect((find(shown(tree), 30)!.attributes as N).value).toBeUndefined();
  });

  it("folds scrolls of the document, elements and frame documents", () => {
    const tree = seeded();
    tree.apply(incremental(IncrementalSource.Scroll, { id: 1, x: 0, y: 300 }));
    tree.apply(incremental(IncrementalSource.Scroll, { id: 5, x: 4, y: 9 }));
    tree.apply(mutation({ adds: [add(4, el(50, "iframe"))] }));
    tree.apply(mutation({ isAttachIframe: true, adds: [add(50, doc(51, [el(52, "html")]))] }));
    tree.apply(incremental(IncrementalSource.Scroll, { id: 51, x: 0, y: 7 }));
    tree.apply(incremental(IncrementalSource.Scroll, { id: 51, x: 0, y: 8 }));
    const { events } = synthesizeFresh(tree);
    expect((events[1]!.data as N).initialOffset).toEqual({ left: 0, top: 300 });
    expect(find(nodeOf(events[1]!), 5)!.attributes).toEqual({
      class: "a",
      rr_scrollLeft: 4,
      rr_scrollTop: 9,
    });
    const scrolls = events.filter(
      (event) =>
        event.type === EventType.IncrementalSnapshot &&
        event.data.source === IncrementalSource.Scroll,
    );
    expect(scrolls.map((event) => (event.data as N).y)).toEqual([8]);
    tree.apply(incremental(IncrementalSource.Scroll, { id: 5, x: 0, y: 0 }));
    expect(find(shown(tree), 5)!.attributes).toEqual({ class: "a" });
  });

  it("folds media state and viewport size", () => {
    const page = basicPage();
    ((page.childNodes as N[])[1]!.childNodes as N[])[1]!.childNodes = [
      el(30, "video", { rr_mediaState: "paused" }),
    ];
    const tree = seeded(page);
    tree.apply(
      incremental(IncrementalSource.MediaInteraction, {
        id: 30,
        type: 0,
        currentTime: 3,
        volume: 0.5,
        muted: true,
        playbackRate: 2,
        loop: false,
      }),
    );
    tree.apply(incremental(IncrementalSource.ViewportResize, { width: 390, height: 844 }));
    const { events } = synthesizeFresh(tree);
    expect(events[0]!.data).toEqual({ href: "https://example.test/", width: 390, height: 844 });
    expect(find(nodeOf(events[1]!), 30)!.attributes).toEqual({
      rr_mediaState: "played",
      rr_mediaCurrentTime: 3,
      rr_mediaVolume: 0.5,
      rr_mediaMuted: true,
      rr_mediaPlaybackRate: 2,
      rr_mediaLoop: false,
    });
  });

  it("keeps sheet edits in order, pruned with their element or by replace", () => {
    const page = basicPage();
    ((page.childNodes as N[])[1]!.childNodes as N[])[0]!.childNodes = [
      el(30, "style", {}, [text(31, "a{}", { isStyle: true })]),
      el(32, "style", {}, [text(33, "b{}", { isStyle: true })]),
    ];
    const tree = seeded(page);
    const rule = (data: N) => tree.apply(incremental(IncrementalSource.StyleSheetRule, data));
    rule({ id: 30, adds: [{ rule: "x{}", index: 0 }] });
    rule({ id: 32, adds: [{ rule: "y{}", index: 0 }] });
    tree.apply(
      incremental(IncrementalSource.AdoptedStyleSheet, {
        id: 1,
        styleIds: [1],
        styles: [{ styleId: 1, rules: [{ rule: "z{}" }] }],
      }),
    );
    rule({ styleId: 1, adds: [{ rule: "w{}", index: 1 }] });
    tree.apply(incremental(IncrementalSource.StyleDeclaration, { id: 30, index: [0], set: {} }));
    const sources = () =>
      synthesizeFresh(tree)
        .events.slice(2)
        .map((event) => [
          (event.data as N).source,
          (event.data as N).id ?? (event.data as N).styleId,
        ]);
    expect(sources()).toEqual([
      [8, 30],
      [8, 32],
      [15, 1],
      [8, 1],
      [13, 30],
    ]);
    rule({ styleId: 1, replaceSync: "v{}" });
    expect(sources()).toEqual([
      [8, 30],
      [8, 32],
      [15, 1],
      [13, 30],
      [8, 1],
    ]);
    // Removing the element, or changing its text, forgets its edits.
    tree.apply(mutation({ removes: [{ parentId: 10, id: 32 }] }));
    tree.apply(mutation({ texts: [{ id: 31, value: "a{color:red}" }] }));
    expect(sources()).toEqual([
      [15, 1],
      [8, 1],
    ]);
    expect(tree.stats().sidecar).toBe(2);
  });

  it("keeps each canvas's latest full picture and the commands after it", () => {
    const page = basicPage();
    ((page.childNodes as N[])[1]!.childNodes as N[])[1]!.childNodes = [el(30, "canvas")];
    const tree = seeded(page, { maxCanvasCommands: 3 });
    const frame = (n: number) =>
      incremental(IncrementalSource.CanvasMutation, {
        id: 30,
        type: 0,
        commands: [
          { property: "clearRect", args: [0, 0, 1, 1] },
          { property: "drawImage", args: [n] },
        ],
      });
    const command = () =>
      incremental(IncrementalSource.CanvasMutation, {
        id: 30,
        type: 0,
        commands: [{ property: "fillRect", args: [0, 0, 1, 1] }],
      });
    tree.apply(frame(1));
    tree.apply(command());
    tree.apply(frame(2));
    tree.apply(command());
    const canvas = synthesizeFresh(tree).events.slice(2);
    expect(canvas).toHaveLength(2);
    expect(((canvas[0]!.data as N).commands as N[])[1]!.args).toEqual([2]);
    tree.apply(command());
    expect(() => tree.apply(command())).toThrow(TreeBroken);
  });

  it("keeps the latest selection and sticky custom events, dropping other ones", () => {
    const tree = seeded();
    const custom = (tag: string, payload: unknown) =>
      tree.apply(
        deepFreeze({
          type: EventType.Custom,
          timestamp: ++clock,
          data: { tag, payload },
        } as eventWithTime),
      );
    expect(custom("other", 1)).toBe("ignored");
    custom(REMOTE_FOCUS_EVENT, { id: 1 });
    custom(REMOTE_FOCUS_EVENT, { id: 5 });
    custom(WORKING_MARK_ANIMATION, { id: 1, tracks: [] });
    custom(WORKING_MARK_ANIMATION, { id: 2, tracks: [] });
    custom(WORKING_MARK_ANIMATION, { id: 1, tracks: [1] });
    tree.apply(
      incremental(IncrementalSource.Selection, {
        ranges: [{ start: 6, startOffset: 0, end: 6, endOffset: 1 }],
      }),
    );
    const rest = synthesizeFresh(tree).events.slice(2);
    expect(rest.map((event) => event.type)).toEqual([
      EventType.IncrementalSnapshot,
      EventType.Custom,
      EventType.Custom,
      EventType.Custom,
    ]);
    expect(rest.slice(1).map((event) => (event.data as N).payload)).toEqual([
      { id: 5 },
      { id: 2, tracks: [] },
      { id: 1, tracks: [1] },
    ]);
    // All carry the last ingested timestamp.
    expect(new Set(synthesizeFresh(tree).events.map((event) => event.timestamp))).toEqual(
      new Set([clock]),
    );
  });
});

describe("LiveTree subtree", () => {
  it("carries the path through a shadow root and a frame", () => {
    const tree = seeded();
    tree.apply(
      mutation({
        adds: [
          add(7, { ...el(20, "div", { id: "host-child" }), isShadow: true }),
          add(4, el(50, "iframe")),
        ],
      }),
    );
    tree.apply(
      mutation({
        isAttachIframe: true,
        adds: [
          add(
            50,
            doc(51, [
              el(52, "html", {}, [
                el(53, "body", {}, [
                  el(54, "div", { contenteditable: "true" }, [text(55, "typed")]),
                ]),
              ]),
            ]),
          ),
        ],
      }),
    );
    const inShadow = subtreeEvents(tree, 20)!;
    expect(inShadow).toHaveLength(2);
    const host = find(nodeOf(inShadow[1]!), 7)!;
    expect(host.isShadowHost).toBe(true);
    expect(childIds(host)).toEqual([20]);
    expect((host.childNodes as N[])[0]!.isShadow).toBe(true);
    // Siblings off the path are left out.
    expect(childIds(find(nodeOf(inShadow[1]!), 4))).toEqual([7]);

    const inFrame = subtreeEvents(tree, 54)!;
    expect(inFrame).toHaveLength(3);
    expect(childIds(find(nodeOf(inFrame[1]!), 4))).toEqual([50]);
    const attached = ((inFrame[2]!.data as N).adds as N[])[0]!;
    expect(attached.parentId).toBe(50);
    expect(find(attached.node as N, 54)).toEqual(
      el(54, "div", { contenteditable: "true" }, [text(55, "typed")]),
    );
  });

  it("declines what a hidden replay cannot carry over", () => {
    const tree = seeded();
    tree.apply(mutation({ adds: [add(7, el(30, "canvas")), add(5, el(31, "iframe"))] }));
    expect(subtreeEvents(tree, 999)).toBeNull();
    expect(subtreeEvents(tree, 1)).toBeNull();
    expect(subtreeEvents(tree, 3)).toBeNull();
    expect(subtreeEvents(tree, 7)).toBeNull();
    expect(subtreeEvents(tree, 5)).toBeNull();
    tree.apply(
      mutation({ adds: [add(4, el(40, "pre", {}, [])), add(40, text(41, "x".repeat(300_000)))] }),
    );
    expect(subtreeEvents(tree, 40)).toBeNull();
  });
});

describe("LiveTree compare", () => {
  it("finds no difference with a snapshot of the same state, ignoring volatile media time", () => {
    const tree = seeded();
    tree.apply(mutation({ adds: [add(4, el(20, "video", { rr_mediaCurrentTime: 1 }))] }));
    const page = basicPage();
    (((page.childNodes as N[])[1]!.childNodes as N[])[1]!.childNodes as N[]).push(
      el(20, "video", { rr_mediaCurrentTime: 9 }),
    );
    expect(tree.compare(meta(), full(page), [])).toEqual([]);
    // Adopted sheets are not part of it: the recorder mints their ids again.
    tree.apply(
      incremental(IncrementalSource.AdoptedStyleSheet, { id: 1, styleIds: [4], styles: [] }),
    );
    expect(tree.compare(meta(), full(page), [])).toEqual([]);
  });

  it("reports what differs", () => {
    const tree = seeded();
    const changed = (extra: boolean) => {
      const page = basicPage();
      const body = ((page.childNodes as N[])[1]!.childNodes as N[])[1]!;
      (body.childNodes as N[])[0]!.attributes = { class: "b" };
      ((body.childNodes as N[])[0]!.childNodes as N[])[0]!.textContent = "z";
      if (extra) (body.childNodes as N[]).push(el(99, "span"));
      return page;
    };
    expect(tree.compare(meta(640), full(changed(true)), [])).toEqual([
      { id: 0, kind: "meta" },
      { id: 4, kind: "children" },
    ]);
    expect(tree.compare(meta(), full(changed(false)), [])).toEqual([
      { id: 5, kind: "attr:class" },
      { id: 6, kind: "text" },
    ]);
  });
});

describe("LiveTree on a recorded stream", () => {
  it("replays the wikipedia fixture to the state its second snapshot shows", () => {
    const path = fileURLToPath(
      new URL("../../../../viewer/fixtures/wikipedia.agentmsgs.json", import.meta.url),
    );
    const messages = JSON.parse(readFileSync(path, "utf8")) as AgentMsg[];
    const events = messages
      .filter(
        (message): message is Extract<AgentMsg, { kind: "rrweb" }> => message.kind === "rrweb",
      )
      .map((message) => deepFreeze(message.e));
    const firstFull = events.findIndex((event) => event.type === EventType.FullSnapshot);
    const tree = LiveTree.seed(events[firstFull - 1]!, events[firstFull]!, {
      checkInvariants: true,
    });
    const secondMeta = events.findIndex(
      (event, index) => index > firstFull && event.type === EventType.Meta,
    );
    for (const event of events.slice(firstFull + 1, secondMeta)) tree.apply(event);
    expect(tree.has(30)).toBe(true);
    // The recorder's own later snapshot of the same document agrees with the tree.
    const mismatches = tree.compare(events[secondMeta]!, events[secondMeta + 1]!, []);
    expect(mismatches.filter((mismatch) => mismatch.kind !== "meta")).toEqual([]);
    for (const event of events.slice(secondMeta + 2)) tree.apply(event);
    expect(tree.has(18)).toBe(false);
    roundTrip(tree);
    expect(tree.stats().nodes).toBeGreaterThan(10);
  });
});
