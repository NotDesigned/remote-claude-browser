// @vitest-environment node
import { EventType, encodeMsg, type Down, type eventWithTime } from "@mirror/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { connectGateway, type WebSocketLike } from "./ws";

afterEach(() => vi.useRealTimers());

class FakeSocket implements WebSocketLike {
  readyState = 1;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(): void {}
  close(): void {
    this.closed = true;
  }
}

const hash = "0123456789abcdef";
const snapshot = (ref: string): Down => ({
  t: "snapshot",
  tab: "tab",
  epoch: 1,
  seq: 1,
  reason: "resync",
  data: [
    {
      type: EventType.FullSnapshot,
      timestamp: 1,
      data: {
        initialOffset: { top: 0, left: 0 },
        node: {
          type: 0,
          id: 1,
          childNodes: [
            { type: 2, id: 2, tagName: "link", attributes: { _cssRef: ref }, childNodes: [] },
            { type: 3, id: 3, cssRef: ref, isStyle: true },
          ],
        },
      },
    } as unknown as eventWithTime,
  ],
});

function connect() {
  const urls: string[] = [];
  const sockets: FakeSocket[] = [];
  const received: Down[] = [];
  const gateway = connectGateway("wss://viewer.test/ws", (message) => received.push(message), {
    reconnectDelayMs: 10,
    socketFactory: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  sockets[0]!.onopen?.();
  const deliver = (message: Down, index = sockets.length - 1) =>
    sockets[index]!.onmessage?.({ data: encodeMsg(message) });
  return { urls, sockets, received, gateway, deliver };
}

it("restores a stylesheet by hash, and offers it on the next connection", () => {
  vi.useFakeTimers();
  const { urls, sockets, received, gateway, deliver } = connect();
  expect(new URL(urls[0]!).searchParams.get("sheets")).toBe("");

  deliver({ t: "css", hash, text: "a{color:red}" });
  expect(received).toEqual([]);
  deliver(snapshot(hash));

  const message = received[0] as Extract<Down, { t: "snapshot" }>;
  const root = (message.data[0]!.data as unknown as { node: { childNodes: unknown[] } }).node;
  expect(root.childNodes).toEqual([
    { type: 2, id: 2, tagName: "link", attributes: { _cssText: "a{color:red}" }, childNodes: [] },
    { type: 3, id: 3, textContent: "a{color:red}", isStyle: true },
  ]);

  sockets[0]!.onclose?.({ code: 1006 });
  vi.advanceTimersByTime(10);
  expect(new URL(urls[1]!).searchParams.get("sheets")).toBe(hash);
  gateway.close();
});

it("reconnects without its sheets when a snapshot needs one it lacks", () => {
  vi.useFakeTimers();
  const { urls, sockets, received, gateway, deliver } = connect();
  deliver(snapshot("ffffffffffffffff"));
  expect(received).toEqual([]);
  expect(sockets[0]!.closed).toBe(true);

  sockets[0]!.onclose?.({ code: 1006 });
  vi.advanceTimersByTime(10);
  expect(new URL(urls[1]!).searchParams.get("sheets")).toBe("");
  gateway.close();
});
