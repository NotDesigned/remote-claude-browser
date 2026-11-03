import { describe, expect, it } from "vitest";
import { EventType, type Down } from "@mirror/protocol";
import { createPresentationState } from "./presentation";

function snapshot(tab = "tab", w = 1280, h = 800): Extract<Down, { t: "snapshot" }> {
  return {
    t: "snapshot",
    tab,
    epoch: 2,
    seq: 3,
    reason: "viewport",
    data: [
      {
        type: EventType.Meta,
        timestamp: 1,
        data: { href: "https://fixture.test", width: w, height: h },
      },
    ],
  };
}

describe("pixel/DOM presentation ownership", () => {
  it("deduplicates identical geometry but forces negotiation for a new connection or driver", () => {
    const state = createPresentationState();
    expect(state.needsViewport("tab", 1280, 800, 1)).toBe(true);
    state.requested("tab", 1280, 800, 1);
    expect(state.needsViewport("tab", 1280, 800, 1)).toBe(false);
    expect(state.needsViewport("tab", 1280, 800, 2)).toBe(true);
    expect(state.needsViewport("tab", 1280, 700, 1)).toBe(true);
    expect(state.needsViewport("other", 1280, 800, 1)).toBe(true);
    state.resetViewport();
    expect(state.needsViewport("tab", 1280, 800, 1)).toBe(true);
  });
  it("keeps DOM snapshots from replacing the pixel canvas, and resumes only after DOM mode", () => {
    const state = createPresentationState();
    state.observe({ t: "mode", tab: "tab", mode: "px" });
    expect(state.isPixel("tab")).toBe(true);
    expect(state.shouldMirror(snapshot())).toBe(false);
    expect(state.shouldMirror({ t: "delta", tab: "tab", epoch: 2, seq: 4, data: [] })).toBe(false);
    expect(state.shouldMirror({ t: "resync", tab: "tab" })).toBe(false);
    expect(state.shouldMirror(snapshot("other"))).toBe(true);
    expect(state.shouldMirror(snapshot("other"), "tab")).toBe(false);
    expect(state.shouldMirror({ t: "resync", tab: "other" }, "tab")).toBe(false);
    state.observe({ t: "mode", tab: "tab", mode: "dom" });
    expect(state.shouldMirror(snapshot())).toBe(true);
  });

  it("accepts only the driver's current viewport, including after a pixel resize", () => {
    const state = createPresentationState();
    state.observe({ t: "mode", tab: "tab", mode: "px" });
    state.requested("tab", 1280, 800);
    expect(state.canAcknowledge(snapshot(), "tab", true)).toBe(true);
    expect(state.canAcknowledge(snapshot(), "tab", false)).toBe(false);
    expect(state.canAcknowledge(snapshot(), "other", true)).toBe(false);
    state.requested("tab", 900, 650);
    expect(state.canAcknowledge(snapshot(), "tab", true)).toBe(false);
    expect(state.canAcknowledge(snapshot("tab", 900, 650), "tab", true)).toBe(true);
    expect(
      state.canAcknowledge({ ...snapshot("tab", 900, 650), reason: "resync" }, "tab", true),
    ).toBe(false);
  });
});
