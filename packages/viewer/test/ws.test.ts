import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectGateway } from "../src/ws";

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  sent: string[] = [];

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(value: unknown) {
    this.onmessage?.({ data: value });
  }

  send(value: string) {
    this.sent.push(value);
  }

  close(code?: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

describe("connectGateway", () => {
  beforeEach(() => vi.useFakeTimers());

  it("queues typed messages until open and decodes Down messages", () => {
    const sockets: FakeSocket[] = [];
    const received: unknown[] = [];
    const gateway = connectGateway("ws://example.test/ws", (message) => received.push(message), {
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    gateway.send({ t: "resync-req", tab: "T1", reason: "test" });
    expect(sockets[0]!.sent).toEqual([]);
    sockets[0]!.open();
    expect(sockets[0]!.sent.map(JSON.parse)).toEqual([
      { t: "resync-req", tab: "T1", reason: "test" },
    ]);

    sockets[0]!.receive(JSON.stringify({ t: "snapshot", tab: "T1", epoch: 1, seq: 1, data: [] }));
    expect(received).toEqual([{ t: "snapshot", tab: "T1", epoch: 1, seq: 1, data: [] }]);
    gateway.close();
  });

  it("reconnects without a resume cursor and reports a restored connection", () => {
    const sockets: FakeSocket[] = [];
    const states: Array<[string, boolean]> = [];
    const gateway = connectGateway("ws://example.test/ws", () => {}, {
      reconnectDelayMs: 25,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onStateChange: (state, reconnected) => states.push([state, reconnected]),
    });

    sockets[0]!.open();
    sockets[0]!.close();
    vi.advanceTimersByTime(25);
    sockets[1]!.open();

    expect(states).toEqual([
      ["connecting", false],
      ["open", false],
      ["closed", true],
      ["connecting", true],
      ["open", true],
    ]);
    gateway.close();
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
  });

  it("lets reconnect send view before flushing input queued while disconnected", () => {
    const sockets: FakeSocket[] = [];
    let gateway: ReturnType<typeof connectGateway>;
    gateway = connectGateway("ws://example.test/ws", () => {}, {
      reconnectDelayMs: 25,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onStateChange(state, reconnected) {
        if (state === "open" && reconnected) {
          gateway.send({ t: "view", tab: "T1", w: 1280, h: 720, dpr: 1 });
          gateway.send({ t: "resync-req", tab: "T1", reason: "ws reconnect" });
        }
      },
    });
    sockets[0]!.open();
    sockets[0]!.close();
    gateway.send({
      t: "key",
      tab: "T1",
      kind: "down",
      key: "a",
      code: "KeyA",
      mods: 0,
    });
    vi.advanceTimersByTime(25);
    sockets[1]!.open();

    expect(sockets[1]!.sent.map(JSON.parse)).toEqual([
      { t: "view", tab: "T1", w: 1280, h: 720, dpr: 1 },
      { t: "resync-req", tab: "T1", reason: "ws reconnect" },
      { t: "key", tab: "T1", kind: "down", key: "a", code: "KeyA", mods: 0 },
    ]);
    gateway.close();
  });

  it("contains malformed wire data at the decode choke point", () => {
    const socket = new FakeSocket();
    const errors: string[] = [];
    const gateway = connectGateway("ws://example.test/ws", () => {}, {
      socketFactory: () => socket,
      onProtocolError: (error) => errors.push(error.message),
    });
    socket.open();
    socket.receive("not json");
    expect(errors).toEqual(["Down: not JSON"]);
    gateway.close();
  });

  it.each([
    [4009, "replaced"],
    [4010, "ended"],
  ] as const)("stops on close code %s without reconnecting", (code, state) => {
    const sockets: FakeSocket[] = [],
      states: string[] = [];
    const gateway = connectGateway("ws://example.test/ws?sid=client-1", () => {}, {
      reconnectDelayMs: 25,
      rttIntervalMs: 100,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onStateChange: (state) => states.push(state),
    });
    sockets[0]!.open();
    vi.advanceTimersByTime(100);
    expect(sockets[0]!.sent).toHaveLength(1);
    sockets[0]!.close(code);
    gateway.send({ t: "text", tab: "T1", insert: "stale page input" });
    vi.advanceTimersByTime(10000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toHaveLength(1);
    expect(states).toEqual(["connecting", "open", state]);
    gateway.close();
  });

  it("retains a page connection key across normal reconnects while different pages get new keys", () => {
    const urls: string[] = [],
      sockets: FakeSocket[] = [];
    const factory = (url: string) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    const first = connectGateway("ws://example.test/ws?sid=client-1", () => {}, {
      socketFactory: factory,
      reconnectDelayMs: 25,
    });
    sockets[0]!.open();
    sockets[0]!.close(1006);
    vi.advanceTimersByTime(25);
    expect(new URL(urls[0]!).searchParams.get("sid")).toBe("client-1");
    expect(new URL(urls[0]!).searchParams.get("connectionKey")).toBeTruthy();
    expect(urls[1]).toBe(urls[0]);
    const second = connectGateway("ws://example.test/ws?sid=client-1", () => {}, {
      socketFactory: factory,
    });
    expect(new URL(urls[2]!).searchParams.get("connectionKey")).not.toBe(
      new URL(urls[0]!).searchParams.get("connectionKey"),
    );
    first.close();
    second.close();
  });
});
