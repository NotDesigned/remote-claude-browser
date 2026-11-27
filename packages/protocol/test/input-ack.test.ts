import { describe, expect, it } from "vitest";
import {
  CAP_ACK_ECHO,
  CAP_INPUT_ACKS,
  CAP_PROXY_INPUT,
  MAX_KEY_TEXT,
  decodeDown,
  decodeUp,
  editableOffset,
  editableText,
  editHash,
  encodeMsg,
  expectTail,
  isAckedInput,
  isInputUp,
  isIseq,
  normalizeEditableText,
  sameEditableText,
  tryDecodeDown,
  UNKNOWN_FENCE_ERROR,
  type AgentCmd,
  type AgentMsg,
  type Down,
  type EditableTextNode,
  type Up,
} from "../src/index";

describe("input acknowledgements on the wire", () => {
  it("round-trips an input-ack, which a viewer of this build knows", () => {
    const ack: Down = {
      t: "input-ack",
      tab: "T1",
      iseq: 12,
      mode: "page",
      epoch: 7,
      seq: 33,
      edit: { node: 9, len: 5, hash: editHash("hello"), sel: [5, 5] },
      failed: [11],
      final: true,
    };
    expect(decodeDown(encodeMsg(ack))).toEqual(ack);
    expect(tryDecodeDown(encodeMsg(ack))).toEqual(ack);
    const dispatchOnly: Down = { t: "input-ack", tab: "T1", iseq: 3, mode: "dispatch" };
    expect(decodeDown(encodeMsg(dispatchOnly))).toEqual(dispatchOnly);
  });

  it("is a Down tag only", () => {
    expect(() => decodeUp(JSON.stringify({ t: "input-ack", tab: "T1", iseq: 1 }))).toThrow(
      /unknown tag/,
    );
  });

  it("keeps an ack within 160 bytes on the wire", async () => {
    // The gateway's sockets use permessage-deflate; a message alone in a fresh compression
    // context is the most an ack can cost (later ones in a burst cost a fraction of this).
    const { deflateRawSync } = await import("node:zlib");
    const ack: Down = {
      t: "input-ack",
      tab: "8F1A3C0E2B4D6F8091A2B3C4D5E6F708",
      iseq: 1234,
      mode: "page",
      epoch: 1099511627776,
      seq: 98765,
      edit: { node: 1234, len: 512, hash: "deadbeef", sel: [512, 512] },
      final: true,
    };
    expect(deflateRawSync(encodeMsg(ack)).length).toBeLessThanOrEqual(160);
  });

  it("carries iseq on every input and expect on a key", () => {
    const messages: Up[] = [
      {
        t: "ptr",
        tab: "T",
        kind: "down",
        nodeId: 1,
        rx: 0,
        ry: 0,
        vx: 1,
        vy: 1,
        buttons: 1,
        mods: 0,
        iseq: 1,
      },
      {
        t: "key",
        tab: "T",
        kind: "down",
        key: "Enter",
        code: "Enter",
        mods: 0,
        iseq: 2,
        expect: { node: 4, len: 2, hash: editHash("hi"), head: editHash("") },
      },
      { t: "text", tab: "T", insert: "x", iseq: 3 },
      { t: "value", tab: "T", nodeId: 4, value: "x", iseq: 4 },
      { t: "ime", tab: "T", text: "n", selStart: 1, selEnd: 1, iseq: 5 },
      { t: "scroll", tab: "T", nodeId: 0, x: 0, y: 10, iseq: 6 },
    ];
    for (const message of messages) {
      expect(decodeUp(encodeMsg(message))).toEqual(message);
      expect(isInputUp(message)).toBe(true);
    }
    expect(isInputUp({ t: "ping", id: 1, sentTs: 0 })).toBe(false);
    expect(isInputUp({ t: "view", tab: "T", w: 1, h: 1, dpr: 1 })).toBe(false);
    expect(isInputUp({ t: "resync-req", tab: "T", reason: "x" })).toBe(false);
  });

  it("acknowledges only input that can change a field, not hovers, drags, wheel or scroll", () => {
    const ptr = (kind: "move" | "down" | "up" | "wheel", buttons = 0): Up => ({
      t: "ptr",
      tab: "T",
      kind,
      nodeId: 1,
      rx: 0,
      ry: 0,
      vx: 1,
      vy: 1,
      buttons,
      mods: 0,
    });
    expect(isAckedInput(ptr("down", 1))).toBe(true);
    expect(isAckedInput(ptr("up"))).toBe(true);
    expect(isAckedInput(ptr("move"))).toBe(false);
    expect(isAckedInput(ptr("move", 1))).toBe(false);
    expect(isAckedInput(ptr("wheel"))).toBe(false);
    expect(isAckedInput({ t: "scroll", tab: "T", nodeId: 0, x: 0, y: 1 })).toBe(false);
    expect(isAckedInput({ t: "text", tab: "T", insert: "x" })).toBe(true);
    expect(isAckedInput({ t: "value", tab: "T", nodeId: 1, value: "x" })).toBe(true);
    expect(isAckedInput({ t: "ime", tab: "T", text: "n", selStart: 1, selEnd: 1 })).toBe(true);
    expect(isAckedInput({ t: "ping", id: 1, sentTs: 0 })).toBe(false);
  });

  it("lets the page rewrite at most half of a short text at Enter", () => {
    expect(expectTail(0)).toBe(0);
    expect(expectTail(3)).toBe(1);
    expect(expectTail(20)).toBe(10);
    expect(expectTail(32)).toBe(16);
    expect(expectTail(500)).toBe(16);
  });

  it("accepts only positive safe integers as iseq", () => {
    expect(isIseq(1)).toBe(true);
    expect(isIseq(2 ** 40)).toBe(true);
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, "1", null, undefined, 2 ** 60])
      expect(isIseq(bad)).toBe(false);
  });

  it("names the capabilities and the old agent's answer", () => {
    expect(CAP_INPUT_ACKS).toBe("ack1");
    expect(CAP_ACK_ECHO).toBe("ackecho1");
    expect(UNKNOWN_FENCE_ERROR).toBe("unknown command: fence");
    const hello: Down = {
      t: "hello",
      viewerId: "v",
      role: "driver",
      sessionId: "s",
      caps: [CAP_INPUT_ACKS, CAP_ACK_ECHO],
    };
    expect(decodeDown(encodeMsg(hello))).toEqual(hello);
  });

  it("names single-writer input and carries a key's typed text", () => {
    expect(CAP_PROXY_INPUT).toBe("proxyin1");
    expect(MAX_KEY_TEXT).toBe(8);
    const key: Up = {
      t: "key",
      tab: "T1",
      kind: "down",
      key: "é",
      code: "Digit2",
      mods: 0,
      text: "é",
      iseq: 4,
    };
    expect(decodeUp(encodeMsg(key))).toEqual(key);
  });

  it("round-trips the fence command and message", () => {
    const command: AgentCmd = { cmd: "fence", reqId: 3, n: 9, text: true };
    expect(JSON.parse(JSON.stringify(command))).toEqual(command);
    const message: AgentMsg = {
      kind: "fence",
      docId: 5,
      n: 9,
      edit: { node: 2, len: 0, hash: editHash(""), sel: [0, 0] },
    };
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
    const none: AgentMsg = { kind: "fence", docId: 5, n: 10, edit: null };
    expect(JSON.parse(JSON.stringify(none))).toEqual(none);
  });
});

describe("edit hashes", () => {
  it("is 8 hex digits and stable", () => {
    expect(editHash("")).toBe("811c9dc5");
    expect(editHash("hello")).toMatch(/^[0-9a-f]{8}$/);
    expect(editHash("hello")).toBe(editHash("hello"));
    expect(editHash("hello")).not.toBe(editHash("hellp"));
  });

  it("does not see what no reader can: NBSP, CRLF, a trailing newline", () => {
    expect(editHash("a\u00a0b")).toBe(editHash("a b"));
    expect(editHash("a\r\nb")).toBe(editHash("a\nb"));
    expect(editHash("a\rb")).toBe(editHash("a\nb"));
    expect(editHash("text\n")).toBe(editHash("text"));
    expect(editHash("text\n\n")).toBe(editHash("text"));
    expect(editHash("text ")).not.toBe(editHash("text"));
    expect(editHash("\ntext")).not.toBe(editHash("text"));
  });

  it("hashes UTF-16 code units, so astral characters are stable too", () => {
    expect(editHash("😃")).toBe(editHash("😃"));
    expect(editHash("分析")).not.toBe(editHash("析分"));
  });

  it("keeps the normalization shared with the agent", () => {
    expect(normalizeEditableText("x\u00a0\r\n\n")).toBe("x ");
    expect(sameEditableText("hello world\n", "hello world")).toBe(true);
    expect(sameEditableText("a\nb", "ab")).toBe(false);
  });
});

describe("editable offsets", () => {
  let next = 0;
  const node = (
    nodeType: number,
    nodeName: string,
    textContent: string | null,
    children: EditableTextNode[] = [],
    className = "",
  ): EditableTextNode & { id: number } => ({
    id: next++,
    nodeType,
    nodeName,
    textContent,
    childNodes: children,
    getAttribute: (name: string) => (name === "class" ? className : null),
  });
  const text = (value: string) => node(3, "#text", value);
  const el = (name: string, ...children: EditableTextNode[]) => node(1, name, null, children);
  const trailing = () => node(1, "BR", null, [], "ProseMirror-trailingBreak");

  /** Every DOM point in the tree, mapped and checked against the flattened text. */
  const points = (root: EditableTextNode) => {
    const all: Array<[EditableTextNode, number]> = [];
    const walk = (current: EditableTextNode) => {
      if (current.nodeType === 3)
        for (let at = 0; at <= (current.textContent ?? "").length; at++) all.push([current, at]);
      else {
        const children = Array.from(current.childNodes);
        children.forEach((child, at) => {
          all.push([current, at]);
          walk(child);
        });
        all.push([current, children.length]);
      }
    };
    walk(root);
    return all;
  };

  it("maps text offsets across ProseMirror paragraphs", () => {
    const first = text("hello");
    const second = text("world");
    const root = el("DIV", el("P", first), el("P", second, trailing()));
    expect(editableText(root)).toBe("hello\nworld");
    expect(editableOffset(root, first, 0)).toBe(0);
    expect(editableOffset(root, first, 5)).toBe(5);
    expect(editableOffset(root, second, 0)).toBe(6);
    expect(editableOffset(root, second, 5)).toBe(11);
    // Between the two paragraphs is the start of the second; the end is the end.
    expect(editableOffset(root, root, 1)).toBe(6);
    expect(editableOffset(root, root, 2)).toBe(11);
  });

  it("puts an empty ProseMirror paragraph's caret on its own line", () => {
    const placeholder = trailing();
    const empty = el("P", placeholder);
    const root = el("DIV", el("P", text("ab")), empty);
    expect(editableText(root)).toBe("ab\n");
    expect(editableOffset(root, empty, 0)).toBe(3);
    expect(editableOffset(root, placeholder, 0)).toBe(3);
  });

  it("counts a BR as a line break and nested blocks as lines", () => {
    const after = text("after");
    const nested = text("deep");
    const root = el(
      "DIV",
      el("P", text("before"), el("BR"), after),
      el("BLOCKQUOTE", el("P", nested)),
    );
    expect(editableText(root)).toBe("before\nafter\ndeep");
    expect(editableOffset(root, after, 2)).toBe(9);
    expect(editableOffset(root, nested, 4)).toBe(17);
  });

  it("round-trips: every point lands inside the text, in document order", () => {
    const root = el(
      "DIV",
      el("P", text("one"), el("STRONG", text("two"))),
      el("P", el("BR")),
      el("DIV", text("three"), el("BR"), text("four")),
      el("UL", el("LI", text("five"))),
    );
    const flat = editableText(root);
    let previous = 0;
    for (const [container, offset] of points(root)) {
      const at = editableOffset(root, container, offset);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(flat.length);
      expect(at).toBeGreaterThanOrEqual(previous);
      previous = at;
    }
    expect(previous).toBe(flat.length);
  });

  it("is -1 for a point outside the root", () => {
    const root = el("DIV", text("x"));
    expect(editableOffset(root, text("elsewhere"), 0)).toBe(-1);
  });
});
