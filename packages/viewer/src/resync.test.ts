import { afterEach, describe, expect, it, vi } from "vitest";

import { createResyncController, RESYNC_WINDOW_MS } from "./resync";

describe("P2-RESYNC controller", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps rate and exponential backoff independently per tab", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sent: Array<{ tab: string; at: number }> = [];
    const controller = createResyncController({
      send: (message) => sent.push({ tab: message.tab, at: Date.now() }),
    });

    expect(controller.request("A", "first gap")).toBe(true);
    expect(controller.request("B", "first gap")).toBe(true);
    expect(sent).toEqual([
      { tab: "A", at: 0 },
      { tab: "B", at: 0 },
    ]);

    expect(controller.request("A", "second gap")).toBe(true);
    expect(controller.getState("A")).toMatchObject({ pending: true, backoffMs: 250 });
    vi.advanceTimersByTime(249);
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sent.at(-1)).toEqual({ tab: "A", at: 250 });

    expect(controller.request("A", "third gap")).toBe(true);
    expect(controller.getState("A")).toMatchObject({ pending: true, backoffMs: 500 });
    vi.advanceTimersByTime(500);
    expect(sent.at(-1)).toEqual({ tab: "A", at: 750 });
    expect(controller.getState("B")).toMatchObject({ recentResyncs: 1, storm: false });
    controller.dispose();
  });

  it("keeps a request the socket could not send, and sends it once it can", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let open = false;
    const sent: string[] = [];
    const controller = createResyncController({
      send: (message) => {
        if (!open) return false;
        sent.push(message.reason);
        return true;
      },
    });

    expect(controller.request("A", "gap")).toBe(true);
    expect(controller.getState("A")).toMatchObject({ pending: true, totalResyncs: 0 });
    expect(controller.request("A", "another gap")).toBe(false);
    open = true;
    vi.advanceTimersByTime(1_000);
    expect(sent).toEqual(["gap"]);
    expect(controller.getState("A")).toMatchObject({ pending: false, totalResyncs: 1 });
    controller.dispose();
  });

  it("automatically sends a rate-limited request when the rolling window has room", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sent: string[] = [];
    const controller = createResyncController({
      send: (message) => sent.push(message.tab),
    });

    controller.request("storm", "one");
    controller.request("storm", "two");
    vi.advanceTimersByTime(250);
    controller.request("storm", "three");
    vi.advanceTimersByTime(500);
    expect(controller.request("storm", "four")).toBe(true);

    expect(sent).toEqual(["storm", "storm", "storm"]);
    expect(controller.getState("storm")).toMatchObject({
      totalResyncs: 3,
      recentResyncs: 3,
      pending: true,
      backoffMs: RESYNC_WINDOW_MS - 750,
      storm: true,
    });
    expect(controller.request("storm", "five")).toBe(false);

    controller.request("healthy", "one");
    expect(sent.at(-1)).toBe("healthy");
    expect(controller.getState("healthy").storm).toBe(false);
    vi.advanceTimersByTime(RESYNC_WINDOW_MS - 751);
    expect(sent.filter((tab) => tab === "storm")).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sent.filter((tab) => tab === "storm")).toHaveLength(4);
    expect(controller.getState("storm")).toMatchObject({
      totalResyncs: 4,
      recentResyncs: 3,
      pending: false,
      storm: false,
    });
    controller.dispose();
  });

  it("expires the rolling window and cancels delayed work after independent recovery", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const reasons: string[] = [];
    const controller = createResyncController({
      send: (message) => reasons.push(message.reason),
    });

    controller.request("A", "one");
    controller.request("A", "obsolete");
    controller.recovered("A");
    vi.advanceTimersByTime(250);
    expect(reasons).toEqual(["one"]);

    vi.advanceTimersByTime(RESYNC_WINDOW_MS);
    controller.request("A", "fresh window");
    expect(reasons).toEqual(["one", "fresh window"]);
    expect(controller.getState("A")).toMatchObject({ recentResyncs: 1, storm: false });
    controller.dispose();
  });

  it("cancels a rate-limited retry when a snapshot has already recovered the tab", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const reasons: string[] = [];
    const controller = createResyncController({
      send: (message) => reasons.push(message.reason),
    });
    controller.request("A", "one");
    controller.request("A", "two");
    vi.advanceTimersByTime(250);
    controller.request("A", "three");
    vi.advanceTimersByTime(500);
    controller.request("A", "obsolete");
    expect(controller.getState("A")).toMatchObject({ pending: true, storm: true });

    controller.recovered("A");
    expect(controller.getState("A")).toMatchObject({
      pending: false,
      storm: false,
      backoffMs: 0,
    });
    vi.advanceTimersByTime(RESYNC_WINDOW_MS);
    expect(reasons).toEqual(["one", "two", "three"]);
    controller.request("A", "later");
    expect(reasons.at(-1)).toBe("later");
    controller.dispose();
  });
});
