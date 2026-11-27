import {
  EventType,
  IncrementalSource,
  encodeMsg,
  type AgentMsg,
  type Down,
  type eventWithTime,
} from "@mirror/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializedDown, TabHub as BaseTabHub, type RewriteStage, type TabHubOpts } from "./tabhub";
import { serializeDown } from "../ws/server";

/** Per-hub epochs from 1, as these tests read them; production epochs are process-wide. */
class TabHub extends BaseTabHub {
  constructor(opts: TabHubOpts) {
    let epoch = 0;
    super({ nextEpoch: () => ++epoch, ...opts });
  }
}

function hello(docId: number, isTop = true): AgentMsg {
  return { kind: "hello", docId, url: `https://doc-${docId}.example/`, isTop, ts: docId };
}

function meta(docId: number): eventWithTime {
  return {
    type: EventType.Meta,
    timestamp: docId * 1_000,
    data: { href: `https://doc-${docId}.example/`, width: 1280, height: 720 },
  };
}

function full(docId: number): eventWithTime {
  return {
    type: EventType.FullSnapshot,
    timestamp: docId * 1_000 + 1,
    data: {
      node: { type: 0, id: docId, childNodes: [] },
      initialOffset: { top: 0, left: 0 },
    },
  };
}

function delta(docId: number, index: number): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: docId * 1_000 + index + 2,
    data: { source: IncrementalSource.Scroll, id: index, x: 0, y: index },
  };
}

function rrweb(docId: number, e: eventWithTime): AgentMsg {
  return { kind: "rrweb", docId, e };
}

function snapshotMessage(messages: Down[]): Extract<Down, { t: "snapshot" }> {
  const message = messages.find((candidate) => candidate.t === "snapshot");
  if (message?.t !== "snapshot") throw new Error("expected snapshot message");
  return message;
}

function assertJoinInvariant(hub: TabHub): void {
  const payload = hub.joinPayload();
  expect(payload[0]).toEqual({ t: "resync", tab: hub.tabId });
  if (payload.length === 1) return;

  const snapshot = payload[1];
  expect(snapshot?.t).toBe("snapshot");
  if (snapshot?.t !== "snapshot") return;
  // Meta and FullSnapshot, then every buffered delta, in one message that the viewer casts in one
  // task; seq names the last event it covers.
  expect(payload).toHaveLength(2);
  expect(snapshot.data.slice(0, 2).map((event) => event.type)).toEqual([
    EventType.Meta,
    EventType.FullSnapshot,
  ]);
  expect(
    snapshot.data.slice(2).every((event) => event.type === EventType.IncrementalSnapshot),
  ).toBe(true);
  expect(hub.seq).toBe(snapshot.seq);
}

describe("TabHub viewport across navigation", () => {
  it("still delivers a viewport snapshot when a new document interrupts the request", () => {
    const hub = new TabHub({ sessionId: "session", tabId: "tab" });
    hub.ingest(hello(1));
    hub.ingest(rrweb(1, meta(1)));
    hub.ingest(rrweb(1, full(1)));
    hub.requestSnapshot("viewport");
    hub.ingest(hello(2));
    hub.ingest(rrweb(2, meta(2)));
    expect(snapshotMessage(hub.ingest(rrweb(2, full(2)))).reason).toBe("nav");
    hub.ingest(rrweb(2, meta(2)));
    expect(snapshotMessage(hub.ingest(rrweb(2, full(2)))).reason).toBe("viewport");
  });
});

describe("TabHub", () => {
  afterEach(() => vi.useRealTimers());

  it("discards a crashed renderer's cache and rejects its late deltas until a new hello", () => {
    vi.useFakeTimers();
    const hub = new TabHub({ sessionId: "s1", tabId: "crashed" });
    hub.ingest(hello(1));
    hub.ingest(rrweb(1, meta(1)));
    hub.ingest(rrweb(1, full(1)));
    hub.ingest(rrweb(1, delta(1, 0)));
    const oldSeq = hub.seq;
    hub.requestSnapshot("resync");
    hub.invalidateDocument();
    expect(hub.joinPayload()).toEqual([{ t: "resync", tab: "crashed" }]);
    expect(hub.ingest(rrweb(1, delta(1, 1)))).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    hub.ingest(hello(2));
    hub.ingest(rrweb(2, meta(2)));
    const restored = snapshotMessage(hub.ingest(rrweb(2, full(2))));
    expect(restored.seq).toBeGreaterThan(oldSeq);
    expect(hub.docId).toBe(2);
    assertJoinInvariant(hub);
  });

  it("opens an epoch with Meta + FullSnapshot and returns a contiguous join payload", () => {
    const hub = new TabHub({ sessionId: "s1", tabId: "t1" });
    let snapshotRequests = 0;
    hub.onNeedSnapshot(() => snapshotRequests++);

    expect(hub.ingest(hello(11))).toEqual([]);
    expect(snapshotRequests).toBe(1);
    expect(hub.joinPayload()).toEqual([{ t: "resync", tab: "t1" }]);
    expect(hub.ingest(rrweb(11, meta(11)))).toEqual([]);

    const opened = snapshotMessage(hub.ingest(rrweb(11, full(11))));
    expect(opened).toMatchObject({ t: "snapshot", tab: "t1", epoch: 1, seq: 1 });
    expect(opened.data.map((event) => event.type)).toEqual([
      EventType.Meta,
      EventType.FullSnapshot,
    ]);

    expect(hub.ingest(rrweb(11, delta(11, 0)))[0]).toMatchObject({
      t: "delta",
      epoch: 1,
      seq: 2,
    });
    expect(hub.ingest(rrweb(11, delta(11, 1)))[0]).toMatchObject({
      t: "delta",
      epoch: 1,
      seq: 3,
    });

    const joined = hub.joinPayload();
    expect(joined).toHaveLength(2);
    expect(joined[1]).toMatchObject({ t: "snapshot", epoch: 1, seq: 3 });
    if (joined[1]?.t === "snapshot") expect(joined[1].data).toHaveLength(4);
    assertJoinInvariant(hub);
  });

  it("invalidates the old document immediately and drops stale or child streams", () => {
    const hub = new TabHub({ sessionId: "s1", tabId: "t1" });
    let snapshotRequests = 0;
    hub.onNeedSnapshot(() => snapshotRequests++);

    hub.ingest(hello(1));
    hub.ingest(rrweb(1, meta(1)));
    hub.ingest(rrweb(1, full(1)));
    hub.ingest(rrweb(1, delta(1, 0)));

    expect(hub.ingest(hello(2))).toEqual([]);
    expect(snapshotRequests).toBe(2);
    expect(hub.joinPayload()).toEqual([{ t: "resync", tab: "t1" }]);
    expect(hub.ingest(rrweb(1, delta(1, 99)))).toEqual([]);
    expect(hub.ingest(hello(200, false))).toEqual([]);
    expect(hub.docId).toBe(2);

    hub.ingest(rrweb(2, meta(2)));
    const reopened = snapshotMessage(hub.ingest(rrweb(2, full(2))));
    expect(reopened.epoch).toBe(2);
    expect(reopened.seq).toBe(3);
    assertJoinInvariant(hub);
  });

  it("drops its history over a limit, keeps viewers going, and snapshots only for a join", () => {
    const hub = new TabHub({
      sessionId: "s1",
      tabId: "events",
      maxDeltaEvents: 2,
      maxDeltaBytes: Number.MAX_SAFE_INTEGER,
    });
    const requested: string[] = [];
    hub.onNeedSnapshot((reason) => requested.push(reason));
    hub.ingest(hello(1));
    hub.ingest(rrweb(1, meta(1)));
    hub.ingest(rrweb(1, full(1)));
    for (let index = 0; index < 3; index++) hub.ingest(rrweb(1, delta(1, index)));
    expect(hub.deltas).toEqual([]);
    expect(hub.deltaBytes).toBe(0);
    expect(requested).toEqual(["nav"]);

    // Those connected keep receiving, and one back from a short gap can still continue.
    const [live] = hub.ingest(rrweb(1, delta(1, 3)));
    expect(live).toMatchObject({ t: "delta", epoch: 1 });
    const seq = (live as Extract<Down, { t: "delta" }>).seq;
    expect(hub.canResume(1, seq)).toBe(true);
    expect(hub.canResume(1, seq - 1)).toBe(false);

    // Only someone who cannot continue costs a snapshot.
    expect(hub.joinPayload().map((message) => message.t)).toEqual(["resync"]);
    expect(requested).toEqual(["nav", "resync"]);
    const next = snapshotMessage(hub.ingest(rrweb(1, full(1))));
    expect(next.epoch).toBe(2);
    expect(hub.joinPayload().map((message) => message.t)).toEqual(["resync", "snapshot"]);
  });

  it("measures its limit in serialized bytes", () => {
    const hub = new TabHub({
      sessionId: "s1",
      tabId: "bytes",
      maxDeltaEvents: Number.MAX_SAFE_INTEGER,
      maxDeltaBytes: 1_000,
    });
    hub.ingest(hello(2));
    hub.ingest(rrweb(2, meta(2)));
    hub.ingest(rrweb(2, full(2)));
    const unicodeDelta: eventWithTime = {
      type: EventType.Custom,
      timestamp: 2_002,
      data: { tag: "wire-bytes", payload: "🙂" },
    };
    const emitted = hub.ingest(rrweb(2, unicodeDelta));
    expect(hub.deltaBytes).toBe(new TextEncoder().encode(encodeMsg(emitted[0]!)).byteLength);
    // The text it counted is the text the fan-out sends, serialized once.
    expect(serializedDown(emitted[0]!)).toBe(encodeMsg(emitted[0]!));
    expect(serializeDown(emitted[0]!)).toBe(serializedDown(emitted[0]!));
    expect(serializeDown({ ...emitted[0]! })).toBe(encodeMsg(emitted[0]!));
  });

  it("labels navigation, viewport, and resync snapshots with their cause", () => {
    const hub = new TabHub({ sessionId: "s1", tabId: "reasons" });
    const requestedReasons: string[] = [];
    hub.onNeedSnapshot((reason) => requestedReasons.push(reason));

    hub.ingest(hello(1));
    hub.ingest(rrweb(1, meta(1)));
    const navigation = snapshotMessage(hub.ingest(rrweb(1, full(1))));
    expect(navigation.reason).toBe("nav");
    expect(snapshotMessage(hub.joinPayload()).reason).toBe("resync");

    hub.requestSnapshot("viewport");
    const viewport = snapshotMessage(hub.ingest(rrweb(1, full(1))));
    expect(viewport.reason).toBe("viewport");
    expect(requestedReasons).toEqual(["nav", "viewport"]);
  });

  it("settles a viewport agreement with the new page's own snapshot when the size already fits", () => {
    const hub = new TabHub({ sessionId: "s1", tabId: "fits" });
    const requested: string[] = [];
    hub.onNeedSnapshot((reason) => requested.push(reason));
    hub.ingest(hello(1));
    hub.ingest(rrweb(1, meta(1)));
    hub.ingest(rrweb(1, full(1)));
    const { width, height } = (
      hub.joinPayload()[1] as unknown as {
        data: { data: { width: number; height: number } }[];
      }
    ).data[0]!.data;

    hub.viewport = { w: width, h: height, dpr: 1 };
    hub.requestSnapshot("viewport");
    hub.ingest(hello(2));
    hub.ingest(rrweb(2, meta(2)));
    expect(snapshotMessage(hub.ingest(rrweb(2, full(2)))).reason).toBe("viewport");
    expect(requested).toEqual(["nav", "viewport", "nav"]);

    hub.viewport = { w: width + 1, h: height, dpr: 1 };
    hub.requestSnapshot("viewport");
    hub.ingest(hello(3));
    hub.ingest(rrweb(3, meta(3)));
    expect(snapshotMessage(hub.ingest(rrweb(3, full(3)))).reason).toBe("nav");
    expect(requested.at(-1)).toBe("viewport");
  });

  it("notes when the page was last active, from its messages and from input", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const hub = new TabHub({ sessionId: "s1", tabId: "activity" });
    hub.ingest(hello(1));
    expect(hub.lastActivityAt).toBe(1_000);
    vi.advanceTimersByTime(500);
    hub.noteInput();
    expect(hub.lastActivityAt).toBe(1_500);
  });

  it("retries a timed-out navigation snapshot without waiting for a delta breach", async () => {
    vi.useFakeTimers();
    const hub = new TabHub({
      sessionId: "s1",
      tabId: "nav-timeout-retry",
      snapshotRequestTimeoutMs: 25,
      snapshotRetryMs: 10,
      snapshotRetryMaxMs: 20,
    });
    const reasons: string[] = [];
    hub.onNeedSnapshot((reason) => reasons.push(reason));

    hub.ingest(hello(1));
    await vi.advanceTimersByTimeAsync(25);
    expect(reasons).toEqual(["nav"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(reasons).toEqual(["nav", "nav"]);

    hub.ingest(rrweb(1, meta(1)));
    const recovered = snapshotMessage(hub.ingest(rrweb(1, full(1))));
    expect(recovered.reason).toBe("nav");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a failed navigation snapshot with bounded backoff and eventually recovers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const hub = new TabHub({
      sessionId: "s1",
      tabId: "nav-retry",
      snapshotRequestTimeoutMs: 1_000,
      snapshotRetryMs: 10,
      snapshotRetryMaxMs: 25,
    });
    const attempts: Array<{ at: number; reason: string }> = [];
    hub.onNeedSnapshot((reason) => {
      attempts.push({ at: Date.now(), reason });
      if (attempts.length < 5) return Promise.reject(new Error("snapshot command failed"));
    });

    hub.ingest(hello(1));
    hub.ingest(rrweb(1, meta(1)));
    for (let index = 0; index < 1_000; index++) hub.ingest(rrweb(1, delta(1, index)));
    expect(hub.deltas).toEqual([]);
    expect(hub.deltaBytes).toBe(0);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(25);
    expect(attempts).toEqual([
      { at: 0, reason: "nav" },
      { at: 10, reason: "nav" },
      { at: 30, reason: "nav" },
      { at: 55, reason: "nav" },
      { at: 80, reason: "nav" },
    ]);

    const recovered = snapshotMessage(hub.ingest(rrweb(1, full(1))));
    expect(recovered).toMatchObject({ reason: "nav", epoch: 1 });
    expect(hub.deltas).toEqual([]);
    expect(hub.deltaBytes).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toHaveLength(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a failed resync snapshot and clears the buffered tail on recovery", async () => {
    vi.useFakeTimers();
    const hub = new TabHub({
      sessionId: "s1",
      tabId: "resync-retry",
      snapshotRetryMs: 10,
      snapshotRetryMaxMs: 20,
    });
    const reasons: string[] = [];
    hub.onNeedSnapshot((reason) => {
      reasons.push(reason);
      if (
        reason === "resync" &&
        reasons.filter((candidate) => candidate === "resync").length === 1
      ) {
        return Promise.reject(new Error("resync snapshot failed"));
      }
    });
    hub.ingest(hello(1));
    hub.ingest(rrweb(1, meta(1)));
    hub.ingest(rrweb(1, full(1)));
    hub.ingest(rrweb(1, delta(1, 0)));

    hub.requestSnapshot("resync");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(reasons).toEqual(["nav", "resync", "resync"]);

    const recovered = snapshotMessage(hub.ingest(rrweb(1, full(1))));
    expect(recovered.reason).toBe("resync");
    expect(hub.deltas).toEqual([]);
    expect(hub.deltaBytes).toBe(0);
  });

  it("cancels a stale navigation retry when a newer document supersedes it", async () => {
    vi.useFakeTimers();
    const hub = new TabHub({
      sessionId: "s1",
      tabId: "superseded-nav",
      snapshotRequestTimeoutMs: 1_000,
      snapshotRetryMs: 50,
      snapshotRetryMaxMs: 100,
    });
    const attempts: Array<{ docId: number; reason: string }> = [];
    hub.onNeedSnapshot((reason) => {
      attempts.push({ docId: hub.docId, reason });
      if (hub.docId === 1) return Promise.reject(new Error("old document failed"));
    });

    hub.ingest(hello(1));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(49);
    expect(attempts).toEqual([{ docId: 1, reason: "nav" }]);

    hub.ingest(hello(2));
    hub.ingest(rrweb(2, meta(2)));
    const recovered = snapshotMessage(hub.ingest(rrweb(2, full(2))));
    expect(recovered).toMatchObject({ reason: "nav", epoch: 1 });
    await vi.advanceTimersByTimeAsync(250);
    expect(attempts).toEqual([
      { docId: 1, reason: "nav" },
      { docId: 2, reason: "nav" },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops retrying, and never asks for a snapshot again, once disposed", async () => {
    vi.useFakeTimers();
    const hub = new TabHub({
      sessionId: "s1",
      tabId: "disposed-retry",
      snapshotRequestTimeoutMs: 1_000,
      snapshotRetryMs: 50,
      snapshotRetryMaxMs: 100,
    });
    const attempts: string[] = [];
    hub.onNeedSnapshot((reason) => {
      attempts.push(reason);
      return Promise.reject(new Error("target detached"));
    });
    hub.ingest(hello(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toEqual(["nav"]);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    hub.dispose();
    expect(vi.getTimerCount()).toBe(0);
    hub.requestSnapshot("resync");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toEqual(["nav"]);
    expect(hub.isDisposed).toBe(true);
  });

  it("applies the rewrite stage before storing and measuring every rrweb event", () => {
    const seen: Array<{ type: EventType; sessionId: string; tabId: string }> = [];
    const rewrite: RewriteStage = (event, context) => {
      seen.push({ type: event.type, ...context });
      return { ...event, timestamp: event.timestamp + 10 };
    };
    const hub = new TabHub({ sessionId: "session-x", tabId: "tab-x", rewrite });

    hub.ingest(hello(3));
    hub.ingest(rrweb(3, meta(3)));
    hub.ingest(rrweb(3, full(3)));
    hub.ingest(rrweb(3, delta(3, 0)));

    expect(seen).toEqual([
      { type: EventType.Meta, sessionId: "session-x", tabId: "tab-x" },
      { type: EventType.FullSnapshot, sessionId: "session-x", tabId: "tab-x" },
      { type: EventType.IncrementalSnapshot, sessionId: "session-x", tabId: "tab-x" },
    ]);
    expect(hub.meta?.timestamp).toBe(meta(3).timestamp + 10);
    expect(hub.snapshot?.timestamp).toBe(full(3).timestamp + 10);
    expect(hub.deltas[0]?.timestamp).toBe(delta(3, 0).timestamp + 10);
  });

  it("maintains the join invariant across deterministic navigation/threshold interleavings", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const hub = new TabHub({
        sessionId: `s${seed}`,
        tabId: `t${seed}`,
        maxDeltaEvents: 1 + (seed % 4),
      });
      let requests = 0;
      hub.onNeedSnapshot(() => requests++);

      for (let doc = 1; doc <= 6; doc++) {
        const docId = seed * 100 + doc;
        hub.ingest(hello(docId));
        hub.ingest(rrweb(docId - 1, delta(docId - 1, 999)));

        // Exercise both pair arrival orders without exposing an incomplete snapshot.
        if ((seed + doc) % 2 === 0) {
          hub.ingest(rrweb(docId, meta(docId)));
          hub.ingest(rrweb(docId, full(docId)));
        } else {
          hub.ingest(rrweb(docId, full(docId)));
          expect(hub.joinPayload()).toEqual([{ t: "resync", tab: `t${seed}` }]);
          hub.ingest(rrweb(docId, meta(docId)));
        }
        assertJoinInvariant(hub);

        const count = (seed * doc) % 8;
        for (let index = 0; index < count; index++) {
          const before = requests;
          hub.ingest(rrweb(docId, delta(docId, index)));
          assertJoinInvariant(hub);
          if (requests > before) {
            hub.ingest(rrweb(docId, full(docId)));
            assertJoinInvariant(hub);
          }
        }
      }
    }
  });

  it("validates configurable thresholds and ignores command responses", () => {
    expect(() => new TabHub({ sessionId: "s", tabId: "t", maxDeltaEvents: -1 })).toThrow(
      RangeError,
    );
    expect(() => new TabHub({ sessionId: "s", tabId: "t", maxDeltaBytes: 1.5 })).toThrow(
      RangeError,
    );
    expect(() => new TabHub({ sessionId: "s", tabId: "t", snapshotRequestTimeoutMs: 0 })).toThrow(
      RangeError,
    );
    expect(() => new TabHub({ sessionId: "s", tabId: "t", snapshotRetryMs: 0 })).toThrow(
      RangeError,
    );
    expect(
      () =>
        new TabHub({
          sessionId: "s",
          tabId: "t",
          snapshotRetryMs: 20,
          snapshotRetryMaxMs: 10,
        }),
    ).toThrow(RangeError);

    const hub = new TabHub({ sessionId: "s", tabId: "t" });
    expect(() => hub.noteInput(Number.NaN)).toThrow(RangeError);
    expect(hub.ingest({ kind: "cmdres", reqId: 1, ok: true })).toEqual([]);
  });
});

describe("TabHub fences", () => {
  const edit = { node: 4, len: 2, hash: "0000abcd", sel: [2, 2] as [number, number] };
  const fence = (docId: number, n: number, text?: string): AgentMsg => ({
    kind: "fence",
    docId,
    n,
    edit,
    ...(text === undefined ? {} : { text }),
  });
  const opened = () => {
    const hub = new TabHub({ sessionId: "s", tabId: "t" });
    hub.ingest(hello(7));
    hub.ingest(rrweb(7, meta(7)));
    hub.ingest(rrweb(7, full(7)));
    return hub;
  };

  it("records the stream position a fence reached, and never sends or buffers it", () => {
    const hub = opened();
    const heard: unknown[] = [];
    hub.onFence((result) => heard.push(result));
    hub.ingest(rrweb(7, delta(7, 0)));
    hub.ingest(rrweb(7, delta(7, 1)));
    const before = hub.joinPayload();
    expect(hub.ingest(fence(7, 1, "secret text"))).toEqual([]);
    expect(heard).toEqual([{ n: 1, epoch: 1, seq: 3, edit }]);
    expect(hub.joinPayload()).toEqual(before);
    expect(JSON.stringify(hub.joinPayload())).not.toContain("secret");
    expect(hub.deltas).toHaveLength(2);
    // The next event's seq follows on: the fence used none.
    expect(hub.ingest(rrweb(7, delta(7, 2)))[0]).toMatchObject({ seq: 4 });
  });

  it("hands a submit-guard fence's text out once and keeps none of it", async () => {
    const hub = opened();
    hub.ingest(fence(7, 1, "secret text"));
    await expect(hub.whenFenced(1, 1_000)).resolves.toMatchObject({ n: 1, text: "secret text" });
    const again = await hub.whenFenced(1, 1_000);
    expect(again).toMatchObject({ n: 1 });
    expect(again).not.toHaveProperty("text");
    const waiting = hub.whenFenced(2, 1_000);
    hub.ingest(fence(7, 2, "more secret"));
    await expect(waiting).resolves.toMatchObject({ n: 2, text: "more secret" });
    // Texts nobody took are kept only a few deep.
    for (let n = 3; n <= 10; n++) hub.ingest(fence(7, n, `secret ${n}`));
    expect(await hub.whenFenced(3, 1_000)).not.toHaveProperty("text");
    expect(await hub.whenFenced(10, 1_000)).toMatchObject({ text: "secret 10" });
  });

  it("drops a fence from another document", () => {
    const hub = opened();
    const heard: unknown[] = [];
    hub.onFence((result) => heard.push(result));
    expect(hub.ingest(fence(8, 1))).toEqual([]);
    expect(heard).toEqual([]);
  });

  it("finds a fence answered before anyone waited, and waits for one that is not", async () => {
    const hub = opened();
    hub.ingest(fence(7, 1));
    await expect(hub.whenFenced(1, 1_000)).resolves.toMatchObject({ n: 1, seq: 1 });
    const later = hub.whenFenced(2, 1_000);
    hub.ingest(rrweb(7, delta(7, 0)));
    hub.ingest(fence(7, 2));
    await expect(later).resolves.toMatchObject({ n: 2, seq: 2 });
  });

  it("keeps the last 32 fences only", async () => {
    const hub = opened();
    for (let n = 1; n <= 40; n++) hub.ingest(fence(7, n));
    await expect(hub.whenFenced(40, 1_000)).resolves.toMatchObject({ n: 40 });
    await expect(hub.whenFenced(9, 1_000)).resolves.toMatchObject({ n: 9 });
    vi.useFakeTimers();
    try {
      const forgotten = hub.whenFenced(8, 50);
      vi.advanceTimersByTime(50);
      await expect(forgotten).resolves.toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a fence that never comes", async () => {
    vi.useFakeTimers();
    try {
      const hub = opened();
      const waiting = hub.whenFenced(3, 1_000);
      vi.advanceTimersByTime(999);
      hub.ingest(fence(7, 4));
      vi.advanceTimersByTime(1);
      await expect(waiting).resolves.toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});
