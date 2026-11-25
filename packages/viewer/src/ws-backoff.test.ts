// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { connectGateway, RECONNECT_MAX_MS, STABLE_MS, type WebSocketLike } from "./ws";

afterEach(() => vi.useRealTimers());

class FakeSocket implements WebSocketLike {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  send(): void {}
  close(): void {}
}

function setup(random: () => number) {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  const messages: unknown[] = [];
  const errors: Error[] = [];
  const gateway = connectGateway("wss://viewer.test/ws", (message) => messages.push(message), {
    reconnectDelayMs: 500,
    random,
    connectionKey: "page",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onProtocolError: (error) => errors.push(error),
  });
  /** Milliseconds until the next socket is created. */
  const nextDelay = () => {
    const before = sockets.length;
    for (let elapsed = 1; elapsed <= 60_000; elapsed++) {
      vi.advanceTimersByTime(1);
      if (sockets.length > before) return elapsed;
    }
    throw new Error("never reconnected");
  };
  return { gateway, sockets, messages, errors, nextDelay };
}

it("backs off exponentially with jitter up to a cap, and starts over after a stable connection", () => {
  const h = setup(() => 1);
  const delays: number[] = [];
  for (let attempt = 0; attempt < 7; attempt++) {
    h.sockets.at(-1)!.onclose?.({ code: 1006 });
    delays.push(h.nextDelay());
  }
  expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, RECONNECT_MAX_MS, RECONNECT_MAX_MS]);

  h.sockets.at(-1)!.onopen?.();
  vi.advanceTimersByTime(STABLE_MS);
  h.sockets.at(-1)!.onclose?.({ code: 1006 });
  expect(h.nextDelay()).toBe(500);
  h.gateway.close();
});

it("spreads reconnects over the upper half of each delay", () => {
  const h = setup(() => 0);
  h.sockets[0]!.onclose?.({ code: 1006 });
  expect(h.nextDelay()).toBe(250);
  h.sockets.at(-1)!.onclose?.({ code: 1006 });
  expect(h.nextDelay()).toBe(500);
  h.gateway.close();
});

it("comes back at once when asked to probe while waiting out a backoff", () => {
  const h = setup(() => 1);
  for (let attempt = 0; attempt < 4; attempt++) {
    h.sockets.at(-1)!.onclose?.({ code: 1006 });
    if (attempt < 3) h.nextDelay();
  }
  const before = h.sockets.length;
  h.gateway.probe();
  expect(h.sockets).toHaveLength(before + 1);
  h.gateway.close();
});

it("ignores a message type it does not know instead of treating it as a broken stream", () => {
  const h = setup(() => 1);
  h.sockets[0]!.onopen?.();
  h.sockets[0]!.onmessage?.({ data: JSON.stringify({ t: "from-the-future", tab: "T1" }) });
  h.sockets[0]!.onmessage?.({ data: JSON.stringify({ t: "resync", tab: "T1" }) });
  expect(h.errors).toEqual([]);
  expect(h.messages).toEqual([{ t: "resync", tab: "T1" }]);
  h.gateway.close();
});
