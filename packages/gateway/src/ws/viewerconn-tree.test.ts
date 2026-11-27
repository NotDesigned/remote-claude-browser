import { EventType, IncrementalSource, type Down, type TabId } from "@mirror/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeDownOnce } from "../hub/tabhub";
import { decodeSent } from "./decode-sent.test-util";
import { STALL_BYTES, ViewerConn, type ReplayCursor, type ViewerSocket } from "./viewerconn";

class MockSocket implements ViewerSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly raw: (string | Uint8Array)[] = [];
  get messages(): Down[] {
    return this.raw.map(decodeSent);
  }
  send(serialized: string | Uint8Array): void {
    this.raw.push(serialized);
  }
}

const delta = (seq: number, tab = "T1", epoch = 1): Extract<Down, { t: "delta" }> => ({
  t: "delta",
  tab,
  epoch,
  seq,
  data: [
    {
      type: EventType.IncrementalSnapshot,
      timestamp: seq,
      data: { source: IncrementalSource.Scroll, id: 1, x: 0, y: seq },
    },
  ],
});
const snapshot = (seq: number, tab = "T1", epoch = 1): Extract<Down, { t: "snapshot" }> => ({
  t: "snapshot",
  tab,
  epoch,
  seq,
  data: [],
});

afterEach(() => vi.useRealTimers());

describe("ViewerConn with the live tree", () => {
  it("drops a tab's live deltas while its catch-up waits, which then covers them", () => {
    vi.useFakeTimers();
    const socket = new MockSocket();
    const viewer = new ViewerConn(socket, () => [], { catchUpIntervalMs: 1_000, drainPollMs: 10 });
    viewer.send(snapshot(1), JSON.stringify(snapshot(1)));
    // A first catch-up goes at once; a second within the interval waits.
    let current = 1;
    viewer.requestCatchUp("T1", () => [snapshot(current)]);
    viewer.requestCatchUp("T1", () => [snapshot(current)]);
    for (const seq of [2, 3, 4]) {
      current = seq;
      expect(viewer.send(delta(seq), JSON.stringify(delta(seq)))).toBe(false);
    }
    // Another tab's deltas still flow.
    expect(viewer.send(delta(9, "T2"), JSON.stringify(delta(9, "T2")))).toBe(true);
    vi.advanceTimersByTime(1_000);
    const sent = socket.messages.filter((message) => message.t !== "delta" || message.tab === "T1");
    expect(sent.map((message) => `${message.t}:${(message as { seq: number }).seq}`)).toEqual([
      "snapshot:1",
      "snapshot:1",
      "snapshot:4",
    ]);
    // Afterwards deltas flow again, from where the catch-up left the viewer.
    expect(viewer.send(delta(5), JSON.stringify(delta(5)))).toBe(true);
    viewer.dispose();
  });

  it("drains a stall from its own cursors, so a short one costs only the tail", () => {
    vi.useFakeTimers();
    const socket = new MockSocket();
    let asked: ReadonlyMap<TabId, ReplayCursor> | undefined;
    const viewer = new ViewerConn(
      socket,
      (cursors) => {
        asked = cursors === undefined ? undefined : new Map(cursors);
        return cursors?.has("T1") ? [delta(3)] : [snapshot(3)];
      },
      { drainPollMs: 10 },
    );
    viewer.send(snapshot(1), JSON.stringify(snapshot(1)));
    viewer.send(delta(2), JSON.stringify(delta(2)));
    socket.bufferedAmount = STALL_BYTES + 1;
    expect(viewer.send(delta(3), JSON.stringify(delta(3)))).toBe(false);
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(20);
    expect(asked).toEqual(new Map([["T1", { epoch: 1, nextSeq: 3 }]]));
    expect(socket.messages.at(-1)).toEqual(delta(3));
    viewer.dispose();
  });

  it("sends a catch-up's text as the hub serialized it", () => {
    const socket = new MockSocket();
    const viewer = new ViewerConn(socket, () => []);
    const message = delta(2);
    const text = encodeDownOnce(message);
    const caughtUp: Down = { t: "caught-up", tab: "T1", epoch: 1, seq: 2 };
    viewer.sendCatchUp([message, caughtUp]);
    expect(socket.raw[0]).toBe(text);
    // caught-up moves the connection's cursor as a delta does.
    expect(viewer.cursorFor("T1")).toEqual({ epoch: 1, nextSeq: 3 });
  });

  it("takes a held replay only in the epoch it sent and no further than it sent", () => {
    const socket = new MockSocket();
    const viewer = new ViewerConn(socket, () => []);
    viewer.send(snapshot(10), JSON.stringify(snapshot(10)));
    viewer.setHeld([
      { tab: "T1", epoch: 1, nextSeq: 8 },
      { tab: "T2", epoch: 1, nextSeq: 3 },
    ]);
    expect(viewer.heldCursor("T1")).toEqual({ epoch: 1, nextSeq: 8 });
    // Nothing was sent of T2 on this connection.
    expect(viewer.heldCursor("T2")).toBeUndefined();
    viewer.setHeld([{ tab: "T1", epoch: 1, nextSeq: 12 }]);
    expect(viewer.heldCursor("T1")).toBeUndefined();
    viewer.setHeld([{ tab: "T1", epoch: 2, nextSeq: 5 }]);
    expect(viewer.heldCursor("T1")).toBeUndefined();
    // A new set replaces the old one.
    viewer.setHeld([]);
    expect(viewer.heldCursor("T1")).toBeUndefined();
  });
});
