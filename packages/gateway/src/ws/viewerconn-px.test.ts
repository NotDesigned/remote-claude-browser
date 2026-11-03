import { encodeMsg, type Down } from "@mirror/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PX_MAX_IN_FLIGHT, ViewerConn, type ViewerSocket } from "./viewerconn";

class Socket implements ViewerSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: Down[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Down);
  }
}

const frame = (data: string, tab = "t1"): Extract<Down, { t: "px" }> => ({
  t: "px",
  tab,
  data,
  w: 10,
  h: 10,
});
const deliver = (viewer: ViewerConn, msg: Down) => viewer.send(msg, encodeMsg(msg));
const pixels = (socket: Socket) =>
  socket.sent.filter((msg) => msg.t === "px").map((msg) => (msg as { data: string }).data);

afterEach(() => vi.useRealTimers());

describe("ViewerConn pixel pacing", () => {
  it("keeps a bounded number of frames in flight and sends only the newest waiting frame", () => {
    const socket = new Socket();
    let now = 0;
    const viewer = new ViewerConn(socket, () => [], { now: () => now });

    for (let index = 0; index < PX_MAX_IN_FLIGHT + 3; index++) deliver(viewer, frame(`f${index}`));
    expect(pixels(socket)).toEqual(["f0", "f1"]);

    now = 100;
    viewer.ackPx("t1");
    // f2 and f3 were superseded while waiting; only the newest picture is worth sending.
    expect(pixels(socket)).toEqual(["f0", "f1", "f4"]);
    viewer.ackPx("t1");
    expect(pixels(socket)).toHaveLength(3);
    viewer.dispose();
  });

  it("paces each tab independently", () => {
    const socket = new Socket();
    const viewer = new ViewerConn(socket, () => [], { now: () => 0 });
    deliver(viewer, frame("a0", "a"));
    deliver(viewer, frame("a1", "a"));
    deliver(viewer, frame("a2", "a"));
    deliver(viewer, frame("b0", "b"));
    expect(pixels(socket)).toEqual(["a0", "a1", "b0"]);
    viewer.dispose();
  });

  it("flushes a waiting frame after the ack timeout so static pages never freeze", () => {
    vi.useFakeTimers();
    const socket = new Socket();
    const viewer = new ViewerConn(socket, () => [], { pxAckTimeoutMs: 500, now: () => Date.now() });
    deliver(viewer, frame("f0"));
    deliver(viewer, frame("f1"));
    deliver(viewer, frame("f2"));
    expect(pixels(socket)).toEqual(["f0", "f1"]);
    vi.advanceTimersByTime(499);
    expect(pixels(socket)).toEqual(["f0", "f1"]);
    vi.advanceTimersByTime(1);
    expect(pixels(socket)).toEqual(["f0", "f1", "f2"]);
    viewer.dispose();
  });

  it("drops a waiting frame when the tab leaves pixel mode", () => {
    vi.useFakeTimers();
    const socket = new Socket();
    const viewer = new ViewerConn(socket, () => [], { pxAckTimeoutMs: 500, now: () => Date.now() });
    deliver(viewer, frame("f0"));
    deliver(viewer, frame("f1"));
    deliver(viewer, frame("stale"));
    deliver(viewer, { t: "mode", tab: "t1", mode: "dom" });
    vi.advanceTimersByTime(1_000);
    viewer.ackPx("t1");
    expect(pixels(socket)).toEqual(["f0", "f1"]);
    // Re-entering pixel mode starts with a fresh window.
    deliver(viewer, frame("fresh"));
    expect(pixels(socket)).toEqual(["f0", "f1", "fresh"]);
    viewer.dispose();
  });
});
