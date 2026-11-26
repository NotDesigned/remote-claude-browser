// @vitest-environment node
import type { ServerStatusMsg } from "@mirror/protocol";
import { describe, expect, it } from "vitest";
import type { DownloadEntry } from "../chrome/downloads";
import {
  initialRuntime,
  inputFailureReasonOf,
  pixelModeOf,
  runtimeReducer,
  type ChromeMessage,
  type RuntimeAction,
  type RuntimeState,
} from "./runtime-state";

const start = () => initialRuntime("dom", 120);
const run = (state: RuntimeState, ...actions: RuntimeAction[]) =>
  actions.reduce(runtimeReducer, state);
const download = (id: string, state: DownloadEntry["state"] = "active") =>
  ({ t: "download", id, state, name: `${id}.bin`, recv: 0, total: 10 }) as DownloadEntry;
const status = (sampledAt: number) => ({ t: "server-status", sampledAt }) as ServerStatusMsg;

describe("mirror runtime state", () => {
  it("starts empty, in the requested view", () => {
    const state = initialRuntime("px", 250);
    expect(state).toMatchObject({
      connection: "connecting",
      viewMode: "px",
      bufferMs: 250,
      activeTab: null,
      tabs: [],
      pixelAvailable: true,
    });
  });

  it("tracks input failures with their reasons", () => {
    const failed = run(start(), { type: "input-status", tab: "t1", failed: true });
    expect(failed.inputFailures).toEqual({ t1: true });
    expect(failed.inputFailureReasons).toEqual({ t1: "远端页面未接受这次输入" });
    const reasoned = run(failed, {
      type: "input-status",
      tab: "t2",
      failed: true,
      reason: "字段已变",
    });
    expect(inputFailureReasonOf({ ...reasoned, activeTab: "t2" })).toBe("字段已变");
    const healed = run(reasoned, { type: "input-status", tab: "t1", failed: false });
    expect(healed.inputFailures).toEqual({ t1: false, t2: true });
    expect(healed.inputFailureReasons).toEqual({ t2: "字段已变" });
    expect(inputFailureReasonOf({ ...healed, activeTab: "t1" })).toBeUndefined();
    expect(inputFailureReasonOf(healed)).toBeUndefined();
  });

  it("starts each connection's per-tab state over on hello", () => {
    const busy = run(
      start(),
      { type: "input-status", tab: "t1", failed: true },
      { type: "oauth", tab: "t1", status: "submitted" },
      { type: "page-state", tab: "t1", state: "recovering" },
      { type: "driver", viewerId: "v0" },
    );
    const follower = run(busy, { type: "hello", viewerId: "v2", driver: false });
    expect(follower).toMatchObject({
      inputFailures: {},
      inputFailureReasons: {},
      oauthCallbacks: {},
      pageStates: {},
      viewerId: "v2",
      driverId: "v0",
    });
    expect(run(busy, { type: "hello", viewerId: "v3", driver: true }).driverId).toBe("v3");
  });

  it("keeps the newest server status sample", () => {
    const first = run(start(), { type: "server-status", value: status(5), now: 100 });
    expect(first.serverStatus).toEqual({ value: status(5), receivedAt: 100 });
    expect(run(first, { type: "server-status", value: status(4), now: 200 })).toBe(first);
    expect(
      run(first, { type: "server-status", value: status(6), now: 300 }).serverStatus?.receivedAt,
    ).toBe(300);
  });

  it("follows downloads, and drops dismissed ones", () => {
    const listed = run(start(), { type: "downloads", downloads: [download("a")] });
    const updated = run(listed, { type: "download", message: download("a", "done") });
    expect(updated.downloads).toEqual([download("a", "done")]);
    const added = run(updated, { type: "download", message: download("b") });
    expect(added.downloads.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(run(added, { type: "dismiss-download", id: "a" }).downloads).toEqual([download("b")]);
    const shown = new Set(["b"]);
    expect(run(added, { type: "shown-downloads", ids: shown }).shownDownloadIds).toBe(shown);
  });

  it("keeps per-tab chrome, modes and resync state", () => {
    const chrome = { t: "chrome", tab: "t1", url: "https://example.test/" } as ChromeMessage;
    const state = run(
      start(),
      { type: "chrome", message: chrome },
      { type: "tab-mode", tab: "t1", mode: "px" },
      { type: "active-tab", tab: "t1" },
      {
        type: "resync",
        state: {
          tab: "t1",
          totalResyncs: 1,
          recentResyncs: 1,
          pending: true,
          backoffMs: 0,
        } as never,
      },
    );
    expect(state.chromeByTab).toEqual({ t1: chrome });
    expect(pixelModeOf(state)).toBe(true);
    expect(pixelModeOf({ ...state, activeTab: "t2" })).toBe(false);
    expect(state.resyncByTab.t1).toMatchObject({ pending: true });
  });

  it("tracks the peak link speed", () => {
    const state = run(
      start(),
      { type: "speed", bps: 300 },
      { type: "speed", bps: 900 },
      { type: "speed", bps: 500 },
    );
    expect(state).toMatchObject({ speedBps: 500, peakSpeedBps: 900 });
  });

  it("clears what a stopped mirror showed, and keeps what is per page", () => {
    const running = run(
      start(),
      { type: "connection", state: "open" },
      { type: "input-ready", ready: true },
      { type: "active-tab", tab: "t1" },
      {
        type: "tabs",
        tabs: [{ id: "t1", title: "A", url: "https://a.test/", active: true }] as never,
      },
      { type: "presence", viewers: [{ id: "v1" }] as never },
      { type: "hello", viewerId: "v1", driver: true },
      { type: "downloads", downloads: [download("a")] },
      { type: "rtt", ms: 40 },
      { type: "tab-mode", tab: "t1", mode: "px" },
      { type: "page-state", tab: "t1", state: "recovering" },
      { type: "input-status", tab: "t1", failed: true, reason: "x" },
    );
    for (const connection of ["closed", "replaced"] as const) {
      const reset = run(running, { type: "reset", connection });
      expect(reset).toMatchObject({
        connection,
        inputReady: false,
        activeTab: null,
        tabs: [],
        viewers: [],
        viewerId: null,
        driverId: null,
        downloads: [],
        rttMs: 40,
        modeByTab: {},
        pageStates: {},
        inputFailures: {},
        inputFailureReasons: {},
      });
    }
  });

  it("keeps the same state for repeated values", () => {
    const state = start();
    expect(runtimeReducer(state, { type: "connection", state: "connecting" })).toBe(state);
    expect(runtimeReducer(state, { type: "input-ready", ready: false })).toBe(state);
    expect(runtimeReducer(state, { type: "pixel-available", available: true })).toBe(state);
    expect(runtimeReducer(state, { type: "frame-rates", rates: null })).toBe(state);
    expect(runtimeReducer(state, { type: "upload", state: null })).toBe(state);
  });
});
