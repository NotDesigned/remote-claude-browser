import { describe, expect, it } from "vitest";
import {
  CAP_LIVE_TREE,
  decodeCursorTriples,
  decodeResumeCursors,
  encodeMsg,
  MAX_HELD_TABS,
  REMOTE_FOCUS_EVENT,
  resyncNode,
  STICKY_CUSTOM_TAGS,
  tryDecodeDown,
  tryDecodeUp,
  WORKING_MARK_ANIMATION,
  type Down,
  type Up,
} from "../src/index";

describe("live tree wire messages", () => {
  it("knows held, caught-up, subtree and a resync-req's node", () => {
    expect(CAP_LIVE_TREE).toBe("tree1");
    const downs: Down[] = [
      { t: "caught-up", tab: "T1", epoch: 4, seq: 90 },
      {
        t: "subtree",
        tab: "T1",
        epoch: 4,
        seq: 90,
        node: 12,
        data: [{ type: 4, timestamp: 1, data: { href: "https://x/", width: 1, height: 1 } }],
      },
    ];
    for (const down of downs) expect(tryDecodeDown(encodeMsg(down))).toEqual(down);
    const ups: Up[] = [
      { t: "held", tabs: [["T1", 4, 91]] },
      { t: "resync-req", tab: "T1", reason: "editable", node: 12 },
    ];
    for (const up of ups) expect(tryDecodeUp(encodeMsg(up))).toEqual(up);
  });

  it("decodes held cursors as resume cursors, dropping what is malformed", () => {
    const raw = [
      ["T1", 4, 91],
      ["bad tab!", 1, 1],
      ["T2", -1, 3],
      ["T3", 1.5, 3],
      ["T4", 2, "3"],
      ["T5", 2, 3, 4],
      "T6",
      ["T7", 9, 10],
    ];
    expect(decodeCursorTriples(raw)).toEqual([
      { tab: "T1", epoch: 4, nextSeq: 91 },
      { tab: "T7", epoch: 9, nextSeq: 10 },
    ]);
    expect(decodeCursorTriples("nope")).toEqual([]);
    expect(decodeCursorTriples(null)).toEqual([]);
    const many = Array.from({ length: 20 }, (_, index) => [`T${index}`, 1, 1]);
    expect(decodeCursorTriples(many)).toHaveLength(MAX_HELD_TABS);
    // The resume parameter reads the same way.
    expect(decodeResumeCursors(JSON.stringify(raw))).toEqual(decodeCursorTriples(raw));
  });

  it("takes only a positive safe integer as a resync-req node", () => {
    expect(resyncNode(12)).toBe(12);
    for (const value of [0, -3, 1.5, "12", null, undefined, Number.MAX_SAFE_INTEGER + 2, NaN])
      expect(resyncNode(value)).toBeUndefined();
  });

  it("names the sticky custom events by their tags", () => {
    expect([...STICKY_CUSTOM_TAGS].sort()).toEqual(
      [REMOTE_FOCUS_EVENT, WORKING_MARK_ANIMATION].sort(),
    );
  });
});
