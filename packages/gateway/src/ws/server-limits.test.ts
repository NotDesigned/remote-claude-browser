import { EventType, IncrementalSource, encodeMsg, type Down } from "@mirror/protocol";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWsServer, Fanout, VIEWER_MAX_PAYLOAD } from "./server";

afterEach(() => vi.useRealTimers());

describe("viewer message size", () => {
  it("closes a connection whose message inflates past the limit, and reads smaller ones", async () => {
    const server = createServer();
    const onUp = vi.fn();
    const wsServer = createWsServer({
      server,
      sessionForRequest: () => "s",
      hubsForSession: () => [],
      onUp,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    const socket = new WebSocket(url, { perMessageDeflate: true });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const pasted = "x".repeat(1024 * 1024);
      socket.send(encodeMsg({ t: "text", tab: "t", insert: pasted }));
      await vi.waitFor(() => expect(onUp).toHaveBeenCalledOnce());

      // Compresses to a few kilobytes on the wire; only the inflated size can catch it.
      const bomb = encodeMsg({ t: "text", tab: "t", insert: "x".repeat(VIEWER_MAX_PAYLOAD) });
      const closed = new Promise<number>((resolve) => socket.once("close", resolve));
      socket.send(bomb, { compress: true });
      expect(await closed).toBe(1009);
      expect(onUp).toHaveBeenCalledOnce();
    } finally {
      socket.terminate();
      await wsServer.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("delta batching state", () => {
  const delta = (tab: string): Extract<Down, { t: "delta" }> => ({
    t: "delta",
    tab,
    epoch: 1,
    seq: 1,
    data: [
      {
        type: EventType.IncrementalSnapshot,
        timestamp: 1,
        data: { source: IncrementalSource.Scroll, id: 7, x: 0, y: 0 },
      },
    ],
  });

  it("keeps send times only for tabs inside the batch window, and none for a forgotten session", () => {
    vi.useFakeTimers();
    const fanout = new Fanout(30);
    for (let index = 0; index < 2000; index++) {
      fanout.publishToSession("s", delta(`closed-${index}`));
      vi.advanceTimersByTime(31);
    }
    expect(fanout.trackedDeltaTabs).toBeLessThanOrEqual(257);
    fanout.publishToSession("other", delta("open"));
    fanout.forgetSession("s");
    expect(fanout.trackedDeltaTabs).toBe(1);
    fanout.forgetSession("other");
    expect(fanout.trackedDeltaTabs).toBe(0);
  });
});
