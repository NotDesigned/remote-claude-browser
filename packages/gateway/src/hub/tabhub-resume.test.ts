import {
  EventType,
  IncrementalSource,
  decodeResumeCursors,
  encodeResumeCursors,
  type AgentMsg,
  type eventWithTime,
} from "@mirror/protocol";
import { describe, expect, it } from "vitest";
import { TabHub } from "./tabhub";

const hello = (docId: number): AgentMsg => ({
  kind: "hello",
  docId,
  url: `https://doc-${docId}.example/`,
  isTop: true,
  ts: docId,
});
const rrweb = (docId: number, e: eventWithTime): AgentMsg =>
  ({ kind: "rrweb", docId, e }) as unknown as AgentMsg;
const meta: eventWithTime = {
  type: EventType.Meta,
  timestamp: 1_000,
  data: { href: "https://doc-1.example/", width: 1280, height: 720 },
};
const full: eventWithTime = {
  type: EventType.FullSnapshot,
  timestamp: 1_001,
  data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } },
};
const scroll = (index: number): eventWithTime => ({
  type: EventType.IncrementalSnapshot,
  timestamp: 1_002 + index,
  data: { source: IncrementalSource.Scroll, id: index, x: 0, y: index },
});

function liveHub(deltas: number) {
  const hub = new TabHub({ sessionId: "s1", tabId: "tab-1" });
  hub.ingest(hello(1));
  hub.ingest(rrweb(1, meta));
  const opened = hub.ingest(rrweb(1, full));
  const snapshot = opened.find((msg) => msg.t === "snapshot");
  if (snapshot?.t !== "snapshot") throw new Error("snapshot not opened");
  for (let index = 0; index < deltas; index++) hub.ingest(rrweb(1, scroll(index)));
  return { hub, epoch: snapshot.epoch, snapshotSeq: snapshot.seq };
}

describe("TabHub reconnect resume", () => {
  it("sends only the deltas a reconnecting viewer missed", () => {
    const { hub, epoch, snapshotSeq } = liveHub(5);
    // The viewer applied the snapshot and the first two deltas.
    const payload = hub.joinPayload({ epoch, nextSeq: snapshotSeq + 3 });
    expect(payload).toEqual([
      {
        t: "delta",
        tab: "tab-1",
        epoch,
        seq: snapshotSeq + 3,
        data: [scroll(2), scroll(3), scroll(4)],
      },
    ]);
  });

  it("sends nothing when the viewer is already current", () => {
    const { hub, epoch, snapshotSeq } = liveHub(3);
    expect(hub.canResume(epoch, snapshotSeq + 4)).toBe(true);
    expect(hub.joinPayload({ epoch, nextSeq: snapshotSeq + 4 })).toEqual([]);
  });

  it("falls back to a full resync for another epoch or a position outside the buffer", () => {
    const { hub, epoch, snapshotSeq } = liveHub(3);
    for (const cursor of [
      { epoch: epoch - 1, nextSeq: snapshotSeq + 1 },
      { epoch, nextSeq: snapshotSeq },
      { epoch, nextSeq: snapshotSeq + 5 },
    ]) {
      expect(hub.canResume(cursor.epoch, cursor.nextSeq)).toBe(false);
      const payload = hub.joinPayload(cursor);
      expect(payload[0]).toEqual({ t: "resync", tab: "tab-1" });
      expect(payload[1]).toMatchObject({ t: "snapshot", epoch });
    }
  });

  it("round-trips resume cursors and ignores malformed input", () => {
    const cursors = [{ tab: "ABCDEF0123", epoch: 4, nextSeq: 91 }];
    expect(decodeResumeCursors(encodeResumeCursors(cursors))).toEqual(cursors);
    for (const raw of [
      null,
      "",
      "not json",
      "{}",
      '[["../x",1,2]]',
      '[["tab",-1,2]]',
      '[["tab",1.5,2]]',
      "x".repeat(5000),
    ])
      expect(decodeResumeCursors(raw)).toEqual([]);
  });
});
