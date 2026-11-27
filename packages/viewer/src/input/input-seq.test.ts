// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CAP_ACK_ECHO, CAP_INPUT_ACKS, type InputAckMsg, type Up } from "@mirror/protocol";
import { createInputSequencer, type SettledAck } from "./input-seq";

const key = (tab = "T1"): Up => ({
  t: "key",
  tab,
  kind: "down",
  key: "a",
  code: "KeyA",
  mods: 0,
});
const edit = { node: 7, len: 3, hash: "0badf00d", sel: [3, 3] as [number, number] };
const pageAck = (iseq: number, seq: number, extra: Partial<InputAckMsg> = {}): InputAckMsg => ({
  t: "input-ack",
  tab: "T1",
  iseq,
  mode: "page",
  epoch: 1,
  seq,
  edit,
  ...extra,
});

function setup(caps: string[] = [CAP_INPUT_ACKS]) {
  let time = 0;
  const marks: Array<{ tab: string; played: (played: boolean) => void }> = [];
  let live = true;
  const sequencer = createInputSequencer({
    now: () => time,
    mark(tab, played) {
      if (!live) return false;
      marks.push({ tab, played });
      return true;
    },
  });
  const settled: SettledAck[] = [];
  sequencer.subscribe((ack) => settled.push(ack));
  sequencer.hello(caps);
  return {
    sequencer,
    settled,
    marks,
    advance: (ms: number) => (time += ms),
    setLive: (value: boolean) => (live = value),
  };
}

describe("input sequence numbers", () => {
  it("stamps input, and only input, once the gateway acknowledges it", () => {
    const { sequencer } = setup();
    expect(sequencer.stamp(key())).toMatchObject({ iseq: 1 });
    expect(sequencer.stamp({ t: "text", tab: "T1", insert: "x" })).toMatchObject({ iseq: 2 });
    expect(sequencer.stamp({ t: "scroll", tab: "T1", nodeId: 0, x: 0, y: 1 })).toMatchObject({
      iseq: 3,
    });
    // Per tab.
    expect(sequencer.stamp(key("T2"))).toMatchObject({ iseq: 1 });
    // Not input: unchanged.
    const nav: Up = { t: "nav", tab: "T1", action: "reload" } as Up;
    expect(sequencer.stamp(nav)).toBe(nav);
    expect(sequencer.lastStamped("T1")).toBe(3);
    expect(sequencer.outstanding("T1")).toBe(3);
  });

  it("stamps nothing, and drops the submit guard's expect, for a gateway without acks", () => {
    const { sequencer } = setup([]);
    const enter: Up = {
      ...(key() as Extract<Up, { t: "key" }>),
      key: "Enter",
      expect: { node: 1, len: 0, hash: "811c9dc5", head: "811c9dc5" },
    };
    expect(sequencer.stamp(key())).not.toHaveProperty("iseq");
    expect(sequencer.stamp(enter)).not.toHaveProperty("expect");
    expect(sequencer.enabled()).toBe(false);
    expect(sequencer.echoEnabled()).toBe(false);
  });

  it("numbers from 1 again on each connection", () => {
    const { sequencer } = setup([CAP_INPUT_ACKS, CAP_ACK_ECHO]);
    sequencer.stamp(key());
    sequencer.stamp(key());
    expect(sequencer.echoEnabled()).toBe(true);
    sequencer.hello([CAP_INPUT_ACKS]);
    expect(sequencer.stamp(key())).toMatchObject({ iseq: 1 });
    expect(sequencer.echoEnabled()).toBe(false);
  });
});

describe("acknowledgements", () => {
  it("settles an ack only once the replay has applied its stream position and played past it", () => {
    const { sequencer, settled, marks, advance } = setup();
    sequencer.stamp(key());
    sequencer.stamp(key());
    sequencer.applied("T1", 1, 5);
    advance(40);
    // The page's effects are in the stream up to seq 5; the replay has only up to 4.
    sequencer.onAck(pageAck(2, 5, { final: true }));
    expect(marks).toHaveLength(0);
    expect(settled).toHaveLength(0);
    expect(sequencer.outstanding("T1")).toBe(2);
    sequencer.applied("T1", 1, 6);
    expect(marks).toHaveLength(1);
    expect(settled).toHaveLength(0);
    marks[0]!.played(true);
    expect(settled).toEqual([
      {
        tab: "T1",
        iseq: 2,
        mode: "page",
        edit,
        failed: [],
        failedValue: false,
        final: true,
      },
    ]);
    expect(sequencer.outstanding("T1")).toBe(0);
    expect(sequencer.rtt()).toBe(40);
  });

  it("settles as dispatch only an ack of another epoch, or one the gateway could not fence", () => {
    const { sequencer, settled } = setup();
    for (let index = 0; index < 3; index++) sequencer.stamp(key());
    sequencer.applied("T1", 2, 9);
    sequencer.onAck(pageAck(1, 3));
    sequencer.onAck({ t: "input-ack", tab: "T1", iseq: 3, mode: "dispatch" });
    expect(settled.map((ack) => [ack.iseq, ack.mode, ack.edit])).toEqual([
      [1, "dispatch", undefined],
      [3, "dispatch", undefined],
    ]);
    expect(sequencer.stats().dispatchOnlyAcks).toBe(2);
  });

  it("keeps acks in order: a dispatch ack waits behind a page ack still held", () => {
    const { sequencer, settled, marks } = setup();
    for (let index = 0; index < 3; index++) sequencer.stamp(key());
    sequencer.applied("T1", 1, 2);
    sequencer.onAck(pageAck(2, 4));
    sequencer.onAck({ t: "input-ack", tab: "T1", iseq: 3, mode: "dispatch" });
    expect(settled).toHaveLength(0);
    sequencer.applied("T1", 1, 5);
    marks[0]!.played(true);
    expect(settled.map((ack) => [ack.iseq, ack.mode])).toEqual([
      [2, "page"],
      [3, "dispatch"],
    ]);
  });

  it("settles as dispatch only when the replay is replaced before it plays the marker", () => {
    const { sequencer, settled, marks, setLive } = setup();
    sequencer.stamp(key());
    sequencer.applied("T1", 1, 4);
    sequencer.onAck(pageAck(1, 3));
    marks[0]!.played(false);
    expect(settled[0]).toMatchObject({ iseq: 1, mode: "dispatch" });
    // No live replay of the tab at all.
    sequencer.stamp(key());
    setLive(false);
    sequencer.onAck(pageAck(2, 3));
    expect(settled[1]).toMatchObject({ iseq: 2, mode: "dispatch" });
  });

  it("says when a refused input was a whole-field sync", () => {
    const { sequencer, settled, marks } = setup();
    sequencer.stamp(key());
    sequencer.stamp({ t: "value", tab: "T1", nodeId: 7, value: "abc", commit: false });
    sequencer.applied("T1", 1, 9);
    sequencer.onAck(pageAck(2, 3, { failed: [2] }));
    marks[0]!.played(true);
    expect(settled[0]).toMatchObject({ failed: [2], failedValue: true });
  });

  it("gives up what is outstanding when the connection goes", () => {
    const { sequencer, settled, marks } = setup();
    sequencer.stamp(key());
    sequencer.stamp(key());
    sequencer.applied("T1", 1, 9);
    sequencer.onAck(pageAck(1, 3));
    sequencer.connectionLost();
    expect(settled.map((ack) => [ack.iseq, ack.mode])).toEqual([
      [1, "dispatch"],
      [2, "dispatch"],
    ]);
    // The old connection's marker settles nothing more.
    marks[0]!.played(true);
    expect(settled).toHaveLength(2);
    expect(sequencer.enabled()).toBe(false);
    expect(sequencer.outstanding("T1")).toBe(0);
  });
});
