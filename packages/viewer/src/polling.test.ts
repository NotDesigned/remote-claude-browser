// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPoller, createSharedPoll } from "./polling";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createPoller", () => {
  it("polls at the interval, never overlapping, and clears its error on success", async () => {
    const answers = [
      () => Promise.reject(new Error("网关超时")),
      () => Promise.resolve(2),
      () => Promise.resolve(3),
    ];
    const load = vi.fn(() => answers.shift()!());
    const errors: (string | null)[] = [];
    const data: number[] = [];
    const poller = createPoller({
      load,
      intervalMs: 1000,
      onData: (value) => data.push(value),
      onError: (error) => errors.push(error),
    });
    poller.start();
    await flush();
    expect(errors).toEqual(["网关超时"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toEqual(["网关超时", null]);
    expect(data).toEqual([2]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(data).toEqual([2, 3]);
    poller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("waits for a slow answer before scheduling the next poll", async () => {
    const slow = deferred<number>();
    const load = vi.fn(() => slow.promise);
    const poller = createPoller({ load, intervalMs: 100, onData: vi.fn(), onError: vi.fn() });
    poller.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("drops an answer overtaken by a refresh or arriving after stop", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const queue = [first.promise, second.promise];
    const data: string[] = [];
    const poller = createPoller({
      load: () => queue.shift() ?? new Promise<string>(() => undefined),
      intervalMs: 1000,
      onData: (value) => data.push(value),
      onError: vi.fn(),
    });
    poller.start();
    const refreshed = poller.refresh();
    second.resolve("new");
    await refreshed;
    first.resolve("old");
    await flush();
    expect(data).toEqual(["new"]);

    const late = deferred<string>();
    queue.push(late.promise);
    await vi.advanceTimersByTimeAsync(1000);
    poller.stop();
    late.resolve("after stop");
    await flush();
    expect(data).toEqual(["new"]);
  });

  it("skips polls while hidden and polls again as the page comes back", async () => {
    let hidden = false;
    const load = vi.fn(async () => 1);
    const poller = createPoller({
      load,
      intervalMs: 1000,
      onData: vi.fn(),
      onError: vi.fn(),
      isHidden: () => hidden,
    });
    poller.start();
    await flush();
    hidden = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(load).toHaveBeenCalledTimes(1);
    hidden = false;
    poller.resume();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    poller.stop();
  });
});

describe("createSharedPoll", () => {
  it("polls once for every subscriber and stops with the last one", async () => {
    const load = vi.fn(async () => ["login"]);
    const source = createSharedPoll(load, 3000, {
      isHidden: () => false,
      watchVisibility: () => () => undefined,
    });
    const banner = vi.fn();
    const panel = vi.fn();
    const stopBanner = source.subscribe(banner);
    const stopPanel = source.subscribe(panel);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(banner).toHaveBeenLastCalledWith({ data: ["login"], error: null });
    expect(panel).toHaveBeenLastCalledWith({ data: ["login"], error: null });
    await vi.advanceTimersByTimeAsync(3000);
    expect(load).toHaveBeenCalledTimes(2);
    stopBanner();
    stopPanel();
    await vi.advanceTimersByTimeAsync(9000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps the last data on a failure and clears the error once a poll succeeds", async () => {
    const answers = [
      () => Promise.resolve(1),
      () => Promise.reject(new Error("断开")),
      () => Promise.resolve(2),
    ];
    const source = createSharedPoll(() => answers.shift()!(), 1000, {
      isHidden: () => false,
      watchVisibility: () => () => undefined,
    });
    const listener = vi.fn();
    const stop = source.subscribe(listener);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(source.state()).toEqual({ data: 1, error: "断开" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(source.state()).toEqual({ data: 2, error: null });
    stop();
  });
});
