// @vitest-environment node
import { Mod, type Up } from "@mirror/protocol";
import { describe, expect, it } from "vitest";
import {
  clickCount,
  eventMods,
  isPasteShortcut,
  keyEventMessage,
  mouseButton,
  pointerMessage,
  sendKeyPress,
} from "./encode";

const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe("shared input encoders", () => {
  it("encodes modifier bits", () => {
    expect(eventMods(none)).toBe(0);
    expect(eventMods({ ...none, altKey: true, shiftKey: true })).toBe(Mod.Alt | Mod.Shift);
    expect(eventMods({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(
      Mod.Alt | Mod.Ctrl | Mod.Meta | Mod.Shift,
    );
  });

  it("keeps only the three wire mouse buttons", () => {
    expect([0, 1, 2, 3, 4, -1].map(mouseButton)).toEqual([
      0,
      1,
      2,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("caps click counts per surface", () => {
    expect([0, 1, 2, 3, 7].map((detail) => clickCount(detail, 2))).toEqual([1, 1, 2, 2, 2]);
    expect([0, 1, 2, 3, 7].map((detail) => clickCount(detail, 3))).toEqual([1, 1, 2, 3, 3]);
  });

  it("encodes a key event and a whole key press", () => {
    expect(
      keyEventMessage("t1", "down", { ...none, ctrlKey: true, key: "k", code: "KeyK" }),
    ).toEqual({ t: "key", tab: "t1", kind: "down", key: "k", code: "KeyK", mods: Mod.Ctrl });
    const sent: Up[] = [];
    sendKeyPress((message) => sent.push(message), "t1", "Enter", "Enter", Mod.Shift);
    expect(sent).toEqual([
      { t: "key", tab: "t1", kind: "down", key: "Enter", code: "Enter", mods: Mod.Shift },
      { t: "key", tab: "t1", kind: "up", key: "Enter", code: "Enter", mods: Mod.Shift },
    ]);
  });

  it("recognizes OS paste shortcuts but not AltGraph or other letters", () => {
    expect(isPasteShortcut({ ...none, ctrlKey: true, key: "v" })).toBe(true);
    expect(isPasteShortcut({ ...none, metaKey: true, key: "V" })).toBe(true);
    expect(isPasteShortcut({ ...none, shiftKey: true, key: "Insert" })).toBe(true);
    expect(isPasteShortcut({ ...none, ctrlKey: true, altKey: true, key: "v" })).toBe(false);
    expect(isPasteShortcut({ ...none, ctrlKey: true, key: "c" })).toBe(false);
    expect(isPasteShortcut({ ...none, key: "v" })).toBe(false);
  });

  it("encodes pointer messages for both surfaces", () => {
    const position = { nodeId: 7, rx: 0.25, ry: 0.5, vx: 10, vy: 20 };
    const press = { ...none, button: 0, buttons: 1, detail: 3, shiftKey: true };
    expect(pointerMessage("t1", "down", position, press, 2)).toEqual({
      t: "ptr",
      tab: "t1",
      kind: "down",
      ...position,
      button: 0,
      buttons: 1,
      mods: Mod.Shift,
      clicks: 2,
    });
    expect(pointerMessage("t1", "down", position, press, 3).clicks).toBe(3);
    const wheel = pointerMessage("t1", "wheel", position, { ...press, deltaX: 3, deltaY: -4 }, 3);
    expect(wheel).toMatchObject({ dx: 3, dy: -4 });
    expect(pointerMessage("t1", "wheel", position, press, 3)).toMatchObject({ dx: 0, dy: 0 });
    expect("dx" in pointerMessage("t1", "move", position, { ...press, deltaX: 3 }, 3)).toBe(false);
  });
});
