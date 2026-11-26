import { EventType, IncrementalSource, encodeMsg, type Down } from "@mirror/protocol";
import { createServer } from "node:http";
import { connect } from "node:net";
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
      // The gateway is still serving: a new viewer connects.
      const next = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        next.once("open", resolve);
        next.once("error", reject);
      });
      next.terminate();
    } finally {
      socket.terminate();
      await wsServer.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("upgrade errors", () => {
  it("survives a client that resets while its upgrade is being authorized", async () => {
    const server = createServer();
    let release!: () => void;
    const authorizing = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const wsServer = createWsServer({
      server,
      sessionForRequest: () => "s",
      hubsForSession: () => [],
      onUp: () => undefined,
      authorizeUpgrade: async () => {
        if (calls++ === 0) await authorizing;
        return true;
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const raw = connect(port, "127.0.0.1");
      await new Promise<void>((resolve) => raw.once("connect", resolve));
      raw.write(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
      await vi.waitFor(() => expect(calls).toBe(1));
      raw.resetAndDestroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const next = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        next.once("open", resolve);
        next.once("error", reject);
      });
      next.terminate();
    } finally {
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
