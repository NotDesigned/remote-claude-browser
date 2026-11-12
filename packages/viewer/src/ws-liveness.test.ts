import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectGateway, PROBE_MS, RTT_INTERVAL_MS, STALL_MS } from "./ws";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fakeSocket() {
  return {
    readyState: 1,
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onclose: null as (() => void) | null,
    sent: [] as string[],
    closed: false,
    send(data: string) {
      this.sent.push(data);
    },
    close() {
      this.closed = true;
    },
  };
}

function connect() {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const states: string[] = [];
  const gateway = connectGateway("ws://example.test/ws", () => {}, {
    reconnectDelayMs: 10,
    socketFactory: () => {
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    },
    onStateChange: (state) => states.push(state),
  });
  const current = () => sockets.at(-1)!;
  current().onopen?.();
  const answer = () => {
    const ping = JSON.parse(current().sent.at(-1)!) as { id: number; sentTs: number };
    current().onmessage?.({
      data: JSON.stringify({ t: "pong", id: ping.id, sentTs: ping.sentTs, serverTs: Date.now() }),
    });
  };
  return { gateway, sockets, states, current, answer };
}

it("gives up a connection that has gone silent and connects again", () => {
  const { gateway, sockets, states, answer } = connect();
  vi.advanceTimersByTime(RTT_INTERVAL_MS);
  answer();
  vi.advanceTimersByTime(STALL_MS);
  expect(sockets).toHaveLength(1);

  vi.advanceTimersByTime(RTT_INTERVAL_MS);
  expect(sockets[0]!.closed).toBe(true);
  expect(states.at(-1)).toBe("closed");
  vi.advanceTimersByTime(10);
  expect(sockets).toHaveLength(2);
  gateway.close();
});

it("checks at once when the page is back on screen", () => {
  const { gateway, sockets, current, answer } = connect();
  gateway.probe();
  answer();
  vi.advanceTimersByTime(PROBE_MS);
  expect(sockets).toHaveLength(1);

  gateway.probe();
  vi.advanceTimersByTime(PROBE_MS);
  expect(sockets[0]!.closed).toBe(true);
  vi.advanceTimersByTime(10);
  expect(sockets).toHaveLength(2);

  // Soon after one, the next waits twice as long, for a large snapshot on a slow link.
  current().onopen?.();
  gateway.probe();
  vi.advanceTimersByTime(PROBE_MS);
  expect(sockets).toHaveLength(2);
  vi.advanceTimersByTime(PROBE_MS);
  expect(sockets[1]!.closed).toBe(true);
  gateway.close();
});

it("does not count a spell frozen in the background as silence", () => {
  const { gateway, sockets } = connect();
  vi.advanceTimersByTime(RTT_INTERVAL_MS);
  // Frozen: the clock moves on but no timer runs until the page thaws.
  vi.setSystemTime(Date.now() + 10 * 60_000);
  vi.advanceTimersByTime(RTT_INTERVAL_MS);
  expect(sockets[0]!.closed).toBe(false);
  gateway.close();
});
