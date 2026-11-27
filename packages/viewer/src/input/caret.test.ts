// @vitest-environment node
import { describe, expect, it } from "vitest";
import { caretRect, frameTransform } from "./caret";

/** A document shown in a frame at (left, top), painted at `scale` of its layout size. */
function frameDoc(parent: object, left: number, top: number, scale: number, border = 0) {
  const frame = {
    ownerDocument: parent,
    offsetWidth: 400,
    clientLeft: border,
    clientTop: border,
    getBoundingClientRect: () => ({ left, top, width: 400 * scale, height: 300 * scale }),
  };
  return { defaultView: { frameElement: frame } };
}

describe("caret geometry", () => {
  it("maps a replay point into the viewer through a scaled frame", () => {
    const viewer = { defaultView: { frameElement: null } };
    const replay = frameDoc(viewer, 100, 50, 0.5);
    const map = frameTransform(replay as never, viewer as never);
    expect(map).toEqual({ x: 100, y: 50, scale: 0.5 });
  });

  it("maps through a frame inside the replay, with its border", () => {
    const viewer = { defaultView: { frameElement: null } };
    const replay = frameDoc(viewer, 100, 50, 0.5);
    const inner = frameDoc(replay, 20, 10, 1, 2);
    const map = frameTransform(inner as never, viewer as never)!;
    // The inner document's origin: 20 + 2 in the replay, then halved and moved by the replay's.
    expect(map.x).toBe(100 + 22 * 0.5);
    expect(map.y).toBe(50 + 12 * 0.5);
    expect(map.scale).toBe(0.5);
  });

  it("is null for a document not inside the viewer", () => {
    const viewer = { defaultView: { frameElement: null } };
    const stray = { defaultView: { frameElement: null } };
    expect(frameTransform(stray as never, viewer as never)).toBe(null);
  });

  it("measures nothing for a field the replay removed", () => {
    const field = { isConnected: false };
    expect(caretRect(field as never, 0, {} as never)).toBe(null);
  });
});
