// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createParkedPages } from "./mirror-parking";
import type { LiveState } from "./mirror-replayer";

const page = (tab: string, options: { media?: boolean; needsSnapshot?: boolean } = {}) =>
  ({
    tab,
    needsSnapshot: options.needsSnapshot ?? false,
    stage: { inert: false, dataset: {} as DOMStringMap },
    replayer: {
      iframe: { contentDocument: { querySelector: () => (options.media ? {} : null) } },
    },
  }) as unknown as LiveState;

describe("parked pages", () => {
  it("keeps only pages whose replay is valid and has no WebRTC media", () => {
    const parked = createParkedPages(2, () => {});
    expect(parked.canPark(page("a"))).toBe(true);
    expect(parked.canPark(page("a", { media: true }))).toBe(false);
    expect(parked.canPark(page("a", { needsSnapshot: true }))).toBe(false);
    expect(createParkedPages(0, () => {}).canPark(page("a"))).toBe(false);
  });

  it("hides parked pages and evicts the oldest beyond the limit", () => {
    const destroyed: string[] = [];
    const parked = createParkedPages(2, (live) => destroyed.push(live.tab));
    const [a, b, c] = [page("a"), page("b"), page("c")];
    parked.park(a);
    expect(a.stage).toMatchObject({ inert: true, dataset: { parked: "true" } });
    parked.park(b);
    parked.park(c);
    expect(destroyed).toEqual(["a"]);
    expect(parked.stages()).toEqual(new Set([b.stage, c.stage]));
    // Parking a tab again replaces its older page.
    const b2 = page("b");
    parked.park(b2);
    expect(destroyed).toEqual(["a", "b"]);
    expect(parked.peek("b")).toBe(b2);
  });

  it("hands a page back, and lets go of tabs that are gone", () => {
    const destroyed: string[] = [];
    const parked = createParkedPages(3, (live) => destroyed.push(live.tab));
    const [a, b, c] = [page("a"), page("b"), page("c")];
    for (const live of [a, b, c]) parked.park(live);
    expect(parked.take("b")).toBe(b);
    expect(parked.take("b")).toBeUndefined();
    expect(destroyed).toEqual([]);
    parked.keep(["c"]);
    expect(destroyed).toEqual(["a"]);
    parked.dropAll();
    expect(destroyed).toEqual(["a", "c"]);
    expect(parked.stages().size).toBe(0);
  });
});
