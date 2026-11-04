import type { Down } from "@mirror/protocol";
import { describe, expect, it, vi } from "vitest";
import { createViewportAgreement, ViewportInputGate, type ViewportHub } from "./viewport";

function snapshot(epoch: number, reason: Extract<Down, { t: "snapshot" }>["reason"]) {
  return { tab: "t1", epoch, reason };
}

describe("ViewportInputGate", () => {
  it("locks input only for viewport epochs, not routine trim or navigation epochs", () => {
    const gate = new ViewportInputGate();

    gate.noteSnapshot(snapshot(2, "viewport"));
    expect(gate.allowsInput("driver", "t1")).toBe(false);
    gate.acknowledge("driver", "t1", 2);
    expect(gate.allowsInput("driver", "t1")).toBe(true);

    gate.noteSnapshot(snapshot(3, "trim"));
    gate.acknowledge("driver", "t1", 3);
    gate.noteSnapshot(snapshot(4, "nav"));
    gate.noteSnapshot(snapshot(4, "resync"));
    expect(gate.allowsInput("driver", "t1")).toBe(true);

    gate.noteSnapshot(snapshot(5, "viewport"));
    expect(gate.allowsInput("driver", "t1")).toBe(false);
    gate.acknowledge("driver", "t1", 5);
    expect(gate.allowsInput("driver", "t1")).toBe(true);
  });

  it("tracks acknowledgements independently per viewer and tab", () => {
    const gate = new ViewportInputGate();
    gate.noteSnapshot({ tab: "t1", epoch: 7, reason: "viewport" });
    gate.noteSnapshot({ tab: "t2", epoch: 3, reason: "viewport" });
    gate.acknowledge("a", "t1", 7);

    expect(gate.allowsInput("a", "t1")).toBe(true);
    expect(gate.allowsInput("a", "t2")).toBe(false);
    expect(gate.allowsInput("b", "t1")).toBe(false);

    gate.removeViewer("a");
    expect(gate.allowsInput("a", "t1")).toBe(false);
  });

  it("treats a reconnected socket as a new unacknowledged viewer", () => {
    const gate = new ViewportInputGate();
    gate.noteSnapshot({ tab: "t1", epoch: 12, reason: "viewport" });
    expect(gate.acknowledge("socket-before-drop", "t1", 12)).toBe(true);
    expect(gate.allowsInput("socket-before-drop", "t1")).toBe(true);

    gate.removeViewer("socket-before-drop");
    expect(gate.allowsInput("socket-after-reconnect", "t1")).toBe(false);
    gate.beginViewportChange("t1");
    expect(gate.acknowledge("socket-after-reconnect", "t1", 12)).toBe(false);
    gate.noteSnapshot({ tab: "t1", epoch: 13, reason: "viewport" });
    expect(gate.acknowledge("socket-after-reconnect", "t1", 13)).toBe(true);
    expect(gate.allowsInput("socket-after-reconnect", "t1")).toBe(true);
  });

  it("locks immediately when a viewport transition begins", () => {
    const gate = new ViewportInputGate();
    expect(gate.allowsInput("driver", "t1")).toBe(false);
    gate.beginViewportChange("t1");
    expect(gate.allowsInput("driver", "t1")).toBe(false);
    expect(gate.acknowledge("driver", "t1", 1)).toBe(false);
    gate.noteSnapshot(snapshot(1, "viewport"));
    expect(gate.allowsInput("driver", "t1")).toBe(false);
    expect(gate.acknowledge("driver", "t1", 1)).toBe(true);
    expect(gate.allowsInput("driver", "t1")).toBe(true);
  });
});

describe("ViewportAgreement", () => {
  it.each(["resolve", "reject"] as const)(
    "replaces a hung negotiation after reset and ignores its late %s",
    async (outcome) => {
      vi.useFakeTimers();
      let agreement: ReturnType<typeof createViewportAgreement> | undefined;
      try {
        let resolveOld!: (value: unknown) => void;
        let rejectOld!: (error: Error) => void;
        const oldOverride = new Promise<unknown>((resolve, reject) => {
          resolveOld = resolve;
          rejectOld = reject;
        });
        const widths: number[] = [];
        const hub: ViewportHub = { viewport: null, requestSnapshot: vi.fn() };
        agreement = createViewportAgreement({
          send: async (_sessionId, _method, params) => {
            widths.push(params?.width as number);
            return widths.length === 1 ? oldOverride : {};
          },
          sessionFor: () => "session-1",
          hubFor: () => hub,
          isDriver: () => true,
          debounceMs: 5,
          snapshotRetryMs: 20,
        });

        agreement.handle("driver", { t: "view", tab: "t1", w: 600, h: 400, dpr: 1 });
        await vi.advanceTimersByTimeAsync(5);
        expect(widths).toEqual([600]);
        expect(hub.requestSnapshot).not.toHaveBeenCalled();

        agreement.resetTab("t1");
        agreement.noteSnapshot(snapshot(2, "viewport"));
        expect(agreement.handle("driver", { t: "view-ack", tab: "t1", epoch: 2 })).toBe(false);
        expect(agreement.gate.allowsInput("driver", "t1")).toBe(false);
        agreement.handle("driver", { t: "view", tab: "t1", w: 900, h: 700, dpr: 2 });
        await vi.advanceTimersByTimeAsync(5);
        expect(widths).toEqual([600, 900]);
        expect(hub.viewport).toEqual({ w: 900, h: 700, dpr: 2 });
        expect(hub.requestSnapshot).toHaveBeenCalledTimes(1);
        agreement.noteSnapshot(snapshot(3, "viewport"));
        expect(agreement.handle("driver", { t: "view-ack", tab: "t1", epoch: 3 })).toBe(true);

        if (outcome === "resolve") resolveOld({});
        else rejectOld(new Error("dead renderer command rejected late"));
        await vi.advanceTimersByTimeAsync(50);
        expect(widths).toEqual([600, 900]);
        expect(hub.viewport).toEqual({ w: 900, h: 700, dpr: 2 });
        expect(hub.requestSnapshot).toHaveBeenCalledTimes(1);
        expect(agreement.gate.allowsInput("driver", "t1")).toBe(true);
      } finally {
        agreement?.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("cancels pending viewport debounce and snapshot retries on reset", async () => {
    vi.useFakeTimers();
    let agreement: ReturnType<typeof createViewportAgreement> | undefined;
    try {
      const send = vi.fn(async () => ({}));
      const hub: ViewportHub = { viewport: null, requestSnapshot: vi.fn() };
      agreement = createViewportAgreement({
        send,
        sessionFor: () => "session-1",
        hubFor: () => hub,
        isDriver: () => true,
        debounceMs: 5,
        snapshotRetryMs: 20,
      });
      agreement.handle("driver", { t: "view", tab: "t1", w: 600, h: 400, dpr: 1 });
      agreement.resetTab("t1");
      await vi.advanceTimersByTimeAsync(50);
      expect(send).not.toHaveBeenCalled();

      agreement.handle("driver", { t: "view", tab: "t1", w: 900, h: 700, dpr: 1 });
      await vi.advanceTimersByTimeAsync(5);
      expect(hub.requestSnapshot).toHaveBeenCalledTimes(1);
      agreement.resetTab("t1");
      await vi.advanceTimersByTimeAsync(50);
      expect(send).toHaveBeenCalledTimes(1);
      expect(hub.requestSnapshot).toHaveBeenCalledTimes(1);
      expect(agreement.gate.allowsInput("driver", "t1")).toBe(false);
    } finally {
      agreement?.dispose();
      vi.useRealTimers();
    }
  });

  it("debounces the driver's latest metrics, forces a snapshot, and gates until ack", async () => {
    vi.useFakeTimers();
    try {
      const calls: { method: string; params?: Record<string, unknown> }[] = [];
      const reasons: string[] = [];
      const hub: ViewportHub = {
        viewport: null,
        requestSnapshot: (reason) => reasons.push(reason),
      };
      const agreement = createViewportAgreement({
        send: async (_sessionId, method, params) => {
          calls.push({ method, params });
          return {};
        },
        sessionFor: () => "session-1",
        hubFor: () => hub,
        isDriver: (viewerId) => viewerId === "driver",
      });

      expect(agreement.handle("follower", { t: "view", tab: "t1", w: 500, h: 400, dpr: 1 })).toBe(
        false,
      );
      // A lone request applies at once; the debounce below covers the burst that follows it.
      agreement.handle("driver", { t: "view", tab: "t1", w: 600, h: 450, dpr: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      agreement.noteSnapshot({ tab: "t1", epoch: 1, reason: "viewport" });
      calls.length = 0;
      reasons.length = 0;

      expect(agreement.handle("driver", { t: "view", tab: "t1", w: 700, h: 500, dpr: 1 })).toBe(
        true,
      );
      await vi.advanceTimersByTimeAsync(200);
      agreement.handle("driver", { t: "view", tab: "t1", w: 800, h: 600, dpr: 2 });
      expect(agreement.gate.allowsInput("driver", "t1")).toBe(false);
      await vi.advanceTimersByTimeAsync(299);
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      expect(calls).toEqual([
        {
          method: "Emulation.setDeviceMetricsOverride",
          params: { width: 800, height: 600, deviceScaleFactor: 2, mobile: false },
        },
      ]);
      expect(hub.viewport).toEqual({ w: 800, h: 600, dpr: 2 });
      expect(agreement.viewportFor("t1")).toEqual({ w: 800, h: 600, dpr: 2 });
      expect(reasons).toEqual(["viewport"]);
      expect(agreement.handle("driver", { t: "view-ack", tab: "t1", epoch: 7 })).toBe(false);

      agreement.noteSnapshot({ tab: "t1", epoch: 7, reason: "viewport" });
      expect(agreement.gate.allowsInput("driver", "t1")).toBe(false);
      expect(agreement.handle("driver", { t: "view-ack", tab: "t1", epoch: 7 })).toBe(true);
      expect(agreement.gate.allowsInput("driver", "t1")).toBe(true);

      agreement.noteSnapshot({ tab: "t1", epoch: 8, reason: "trim" });
      agreement.noteSnapshot({ tab: "t1", epoch: 9, reason: "nav" });
      expect(agreement.gate.allowsInput("driver", "t1")).toBe(true);
      agreement.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not unlock an obsolete viewport epoch when a newer resize is pending", async () => {
    vi.useFakeTimers();
    try {
      const appliedWidths: number[] = [];
      const hub: ViewportHub = { viewport: null, requestSnapshot: vi.fn() };
      const agreement = createViewportAgreement({
        send: async (_sessionId, _method, params) => {
          appliedWidths.push(params?.width as number);
          return {};
        },
        sessionFor: () => "session-1",
        hubFor: () => hub,
        isDriver: () => true,
        debounceMs: 10,
      });

      agreement.handle("driver", { t: "view", tab: "t1", w: 600, h: 400, dpr: 1 });
      await vi.advanceTimersByTimeAsync(10);
      expect(appliedWidths).toEqual([600]);

      agreement.handle("driver", { t: "view", tab: "t1", w: 900, h: 700, dpr: 1.5 });
      await vi.advanceTimersByTimeAsync(10);
      expect(appliedWidths).toEqual([600]);
      agreement.noteSnapshot({ tab: "t1", epoch: 3, reason: "viewport" });
      expect(agreement.handle("driver", { t: "view-ack", tab: "t1", epoch: 3 })).toBe(false);
      expect(agreement.gate.allowsInput("driver", "t1")).toBe(false);

      await vi.advanceTimersByTimeAsync(0);
      expect(appliedWidths).toEqual([600, 900]);
      agreement.noteSnapshot({ tab: "t1", epoch: 4, reason: "viewport" });
      expect(agreement.handle("driver", { t: "view-ack", tab: "t1", epoch: 4 })).toBe(true);
      expect(agreement.gate.allowsInput("driver", "t1")).toBe(true);
      agreement.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a missing viewport snapshot without reopening input", async () => {
    vi.useFakeTimers();
    try {
      const hub: ViewportHub = { viewport: null, requestSnapshot: vi.fn() };
      const agreement = createViewportAgreement({
        send: async () => ({}),
        sessionFor: () => "session-1",
        hubFor: () => hub,
        isDriver: () => true,
        debounceMs: 5,
        snapshotRetryMs: 20,
      });
      agreement.handle("driver", { t: "view", tab: "t1", w: 640, h: 480, dpr: 1 });
      await vi.advanceTimersByTimeAsync(5);
      expect(hub.requestSnapshot).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(hub.requestSnapshot).toHaveBeenCalledTimes(2);
      expect(agreement.gate.allowsInput("driver", "t1")).toBe(false);
      agreement.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid metrics before locking or touching CDP", async () => {
    const send = vi.fn(async () => ({}));
    const agreement = createViewportAgreement({
      send,
      sessionFor: () => "session-1",
      hubFor: () => ({ viewport: null, requestSnapshot: vi.fn() }),
      isDriver: () => true,
    });
    expect(agreement.handle("driver", { t: "view", tab: "t1", w: 0, h: 600, dpr: 1 })).toBe(false);
    expect(
      agreement.handle("driver", { t: "view", tab: "t1", w: 800, h: 600, dpr: Infinity }),
    ).toBe(false);
    expect(agreement.gate.allowsInput("driver", "t1")).toBe(false);
    expect(send).not.toHaveBeenCalled();
    agreement.dispose();
  });

  describe("unchanged geometry", () => {
    const setup = (hub: ViewportHub) => {
      const send = vi.fn(async () => ({}));
      const confirmViewport = vi.fn();
      const agreement = createViewportAgreement({
        send,
        sessionFor: () => "session",
        hubFor: () => hub,
        isDriver: () => true,
        confirmViewport,
      });
      return { send, confirmViewport, agreement };
    };
    const view = { t: "view", tab: "tab", w: 1360, h: 900, dpr: 1 } as const;

    it("confirms a current snapshot without a device override or a new snapshot", async () => {
      const requestSnapshot = vi.fn();
      const { send, confirmViewport, agreement } = setup({
        viewport: { w: 1360, h: 900, dpr: 1 },
        epoch: 7,
        requestSnapshot,
        hasGeometry: () => true,
      });
      expect(agreement.handle("viewer", view)).toBe(true);
      expect(confirmViewport).toHaveBeenCalledWith("viewer", "tab", { w: 1360, h: 900 });
      expect(agreement.gate.allowsInput("viewer", "tab")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(send).not.toHaveBeenCalled();
      expect(requestSnapshot).not.toHaveBeenCalled();
      agreement.dispose();
    });

    it("waits for the restarting recorder's snapshot instead of requesting another", async () => {
      const requestSnapshot = vi.fn();
      const { send, confirmViewport, agreement } = setup({
        viewport: { w: 1360, h: 900, dpr: 1 },
        requestSnapshot,
        hasGeometry: () => false,
        expectRecorderSnapshot: () => true,
      });
      agreement.handle("viewer", view);
      expect(confirmViewport).not.toHaveBeenCalled();
      expect(agreement.gate.allowsInput("viewer", "tab")).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(send).not.toHaveBeenCalled();
      expect(requestSnapshot).not.toHaveBeenCalled();
      agreement.noteSnapshot({ tab: "tab", epoch: 8, reason: "viewport" });
      expect(agreement.handle("viewer", { t: "view-ack", tab: "tab", epoch: 8 })).toBe(true);
      expect(agreement.gate.allowsInput("viewer", "tab")).toBe(true);
      agreement.dispose();
    });

    it("restarts a stopped recorder after a changed viewport is applied", async () => {
      const requestSnapshot = vi.fn();
      const expectRecorderSnapshot = vi.fn(() => true);
      const restartRecorder = vi.fn();
      const send = vi.fn(async () => ({}));
      const agreement = createViewportAgreement({
        send,
        sessionFor: () => "session",
        hubFor: () => ({
          viewport: null,
          requestSnapshot,
          expectRecorderSnapshot,
          recorderAwaitsRestart: true,
        }),
        isDriver: () => true,
        restartRecorder,
      });
      agreement.handle("viewer", { t: "view", tab: "tab", w: 390, h: 780, dpr: 2 });
      expect(restartRecorder).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(send).toHaveBeenCalledOnce();
      expect(expectRecorderSnapshot).toHaveBeenCalledWith("viewport");
      expect(restartRecorder).toHaveBeenCalledOnce();
      expect(requestSnapshot).not.toHaveBeenCalled();
      agreement.dispose();
    });

    it("negotiates as usual when the geometry changed", async () => {
      const requestSnapshot = vi.fn();
      const { send, confirmViewport, agreement } = setup({
        viewport: { w: 800, h: 600, dpr: 1 },
        requestSnapshot,
        hasGeometry: () => true,
      });
      agreement.handle("viewer", view);
      expect(confirmViewport).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(send).toHaveBeenCalledOnce();
      expect(requestSnapshot).toHaveBeenCalledWith("viewport");
      agreement.dispose();
    });
  });
});
