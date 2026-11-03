// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { connectGateway, type WebSocketLike } from "./ws";

afterEach(() => vi.useRealTimers());

class FakeSocket implements WebSocketLike {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(): void {}
  close(): void {}
}

it("reports the replay position only when reconnecting", () => {
  vi.useFakeTimers();
  const urls: string[] = [];
  const sockets: FakeSocket[] = [];
  let cursor: string | null = '[["tab-1",3,42]]';
  const gateway = connectGateway("wss://viewer.test/ws?sid=client-1", () => {}, {
    reconnectDelayMs: 10,
    connectionKey: "page-key",
    resumeParam: () => cursor,
    socketFactory: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  sockets[0]!.onopen?.();
  expect(new URL(urls[0]!).searchParams.has("resume")).toBe(false);

  sockets[0]!.onclose?.({ code: 1006 });
  vi.advanceTimersByTime(10);
  expect(new URL(urls[1]!).searchParams.get("resume")).toBe('[["tab-1",3,42]]');
  expect(new URL(urls[1]!).searchParams.get("connectionKey")).toBe("page-key");

  sockets[1]!.onopen?.();
  cursor = null;
  sockets[1]!.onclose?.({ code: 1006 });
  vi.advanceTimersByTime(10);
  expect(new URL(urls[2]!).searchParams.has("resume")).toBe(false);
  gateway.close();
});
