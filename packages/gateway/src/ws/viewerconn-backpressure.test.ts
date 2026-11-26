import { encodeMsg, type Down } from "@mirror/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_DROP_BYTES,
  HARD_CAP_BYTES,
  RESUME_BYTES,
  SLOW_VIEWER_CLOSE_CODE,
  STALL_BYTES,
  STALL_CLOSE_MS,
  ViewerConn,
  type ViewerSocket,
} from "./viewerconn";

class Socket implements ViewerSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: Down[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Down);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
}

const audio: Down = { t: "audio", tab: "t1", pcm: "AAAA" };
const deliver = (viewer: ViewerConn, msg: Down) => viewer.send(msg, encodeMsg(msg));
const catchUp = (tab = "t1"): Down[] => [{ t: "resync", tab }];

afterEach(() => vi.useRealTimers());

describe("ViewerConn backpressure", () => {
  it("drops sound once the socket has a backlog, and while stalled", () => {
    const socket = new Socket();
    const viewer = new ViewerConn(socket, () => []);
    expect(deliver(viewer, audio)).toBe(true);
    socket.bufferedAmount = AUDIO_DROP_BYTES + 1;
    expect(deliver(viewer, audio)).toBe(false);
    socket.bufferedAmount = STALL_BYTES + 1;
    deliver(viewer, { t: "delta", tab: "t1", epoch: 1, seq: 1, data: [] });
    expect(viewer.isStalled).toBe(true);
    socket.bufferedAmount = 0;
    expect(deliver(viewer, audio)).toBe(false);
    expect(socket.sent.filter((msg) => msg.t === "audio")).toHaveLength(1);
    viewer.dispose();
  });

  it("coalesces a viewer's own catch-ups and waits for its backlog to drain", async () => {
    vi.useFakeTimers();
    const socket = new Socket();
    const viewer = new ViewerConn(socket, () => [], { now: () => Date.now() });
    const flushes = vi.fn();
    viewer.setBeforeResync(flushes);
    const built = vi.fn(() => catchUp());

    viewer.requestCatchUp("t1", built);
    expect(socket.sent).toHaveLength(1);
    for (let index = 0; index < 20; index++) viewer.requestCatchUp("t1", built);
    expect(socket.sent).toHaveLength(1);

    // Due now, but the socket is still busy: it waits for the drain.
    socket.bufferedAmount = RESUME_BYTES + 1;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(socket.sent).toHaveLength(1);
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.sent).toHaveLength(2);
    expect(flushes).toHaveBeenCalledOnce();
    expect(built).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.sent).toHaveLength(2);
    viewer.dispose();
  });

  it("leaves a stalled viewer's catch-up to the join payload it gets when it drains", () => {
    const socket = new Socket();
    const viewer = new ViewerConn(socket, () => []);
    socket.bufferedAmount = STALL_BYTES + 1;
    viewer.requestCatchUp("t1", catchUp);
    expect(viewer.isStalled).toBe(true);
    expect(socket.sent).toHaveLength(0);
    viewer.dispose();
  });

  it("closes a viewer over the hard cap at once", () => {
    const socket = new Socket();
    const viewer = new ViewerConn(socket, () => []);
    socket.bufferedAmount = HARD_CAP_BYTES + 1;
    expect(deliver(viewer, { t: "tabs", tabs: [] })).toBe(false);
    expect(socket.closed?.code).toBe(SLOW_VIEWER_CLOSE_CODE);
    expect(socket.sent).toHaveLength(0);
  });

  it("closes a viewer that stays stalled", async () => {
    vi.useFakeTimers();
    const socket = new Socket();
    const viewer = new ViewerConn(socket, () => [], { now: () => Date.now() });
    socket.bufferedAmount = STALL_BYTES + 1;
    deliver(viewer, { t: "delta", tab: "t1", epoch: 1, seq: 1, data: [] });
    expect(viewer.isStalled).toBe(true);
    await vi.advanceTimersByTimeAsync(STALL_CLOSE_MS - 1_000);
    expect(socket.closed).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(socket.closed?.code).toBe(SLOW_VIEWER_CLOSE_CODE);
    expect(vi.getTimerCount()).toBe(0);
  });
});
