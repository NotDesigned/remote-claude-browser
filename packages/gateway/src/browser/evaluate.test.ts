import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateInPage, PAGE_EVALUATE_TIMEOUT_MS } from "./evaluate";

afterEach(() => vi.useRealTimers());

describe("evaluateInPage", () => {
  it("returns the page's value", async () => {
    const send = vi.fn(async () => ({ result: { value: "text" } }));
    await expect(evaluateInPage(send, "session-1", "1 + 1", "timed out")).resolves.toBe("text");
    expect(send).toHaveBeenCalledWith("session-1", "Runtime.evaluate", {
      expression: "1 + 1",
      returnByValue: true,
    });
  });

  it("gives up on a page that does not answer within 1.5 s", async () => {
    vi.useFakeTimers();
    const answer = evaluateInPage(
      () => new Promise(() => {}),
      "session-1",
      "x",
      "inspection timed out",
    );
    const settled = expect(answer).rejects.toThrow("inspection timed out");
    await vi.advanceTimersByTimeAsync(PAGE_EVALUATE_TIMEOUT_MS - 1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(PAGE_EVALUATE_TIMEOUT_MS).toBe(1500);
  });

  it("clears its timer once the page answers", async () => {
    vi.useFakeTimers();
    await evaluateInPage(async () => ({ result: { value: true } }), "s", "x", "timed out");
    expect(vi.getTimerCount()).toBe(0);
  });
});
