import {
  EventType,
  UNKNOWN_FENCE_ERROR,
  editHash,
  expectTail,
  type AgentCmdInput,
  type AgentMsg,
  type CmdRes,
  type EditExpect,
  type InputAckMsg,
} from "@mirror/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabHub } from "../hub/tabhub";
import {
  ackCaps,
  proxyInputConfig,
  classifySubmit,
  createAckScheduler,
  FENCE_TIMEOUT_MS,
  parseAckMode,
  QUIET_FENCE_MS,
  type AckScheduler,
  type AckSchedulerDeps,
} from "./acks";
import { createInputRelay, type InputMsg } from "./relay";

const TAB = "tab-1";
const DOC = 7;

type FenceBehaviour = "answer" | "legacy" | "silent" | "lost-in-stream";

/** A page with one text field, its recorder stream (a real TabHub) and the real relay. */
function page(
  options: {
    fence?: FenceBehaviour;
    isDriver?: (viewerId: string) => boolean;
    dispatchMs?: () => number;
    fail?: (msg: InputMsg) => boolean;
    guard?: AckSchedulerDeps["guard"];
    /** What the page does to its text on Enter, before the guard's fence reads it. */
    rewrite?: (text: string) => string;
  } = {},
) {
  const hub = new TabHub({ sessionId: "s", tabId: TAB, nextEpoch: () => 5 });
  hub.ingest({ kind: "hello", docId: DOC, url: "https://x/", isTop: true, ts: 0 });
  hub.ingest({
    kind: "rrweb",
    docId: DOC,
    e: { type: EventType.Meta, timestamp: 1, data: { href: "https://x/", width: 1, height: 1 } },
  });
  hub.ingest({
    kind: "rrweb",
    docId: DOC,
    e: {
      type: EventType.FullSnapshot,
      timestamp: 2,
      data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } },
    },
  });
  const state = { text: "", fences: 0, behaviour: options.fence ?? "answer", closed: false };
  const acks: Array<[string, InputAckMsg]> = [];
  const guards: string[] = [];
  const mutation = (): AgentMsg => ({
    kind: "rrweb",
    docId: DOC,
    e: {
      type: EventType.IncrementalSnapshot,
      timestamp: 3,
      data: { source: 0, texts: [], attributes: [], removes: [], adds: [] },
    } as never,
  });
  const edit = () => ({
    node: 9,
    len: state.text.length,
    hash: editHash(state.text),
    sel: [state.text.length, state.text.length] as [number, number],
  });
  const sendCmd = async (_tab: string, command: AgentCmdInput): Promise<CmdRes> => {
    if (command.cmd !== "fence") return { reqId: 0, ok: true };
    state.fences += 1;
    switch (state.behaviour) {
      case "legacy":
        return { reqId: 0, ok: false, err: UNKNOWN_FENCE_ERROR };
      case "silent":
        return new Promise(() => undefined);
      case "lost-in-stream":
        return { reqId: 0, ok: true };
      case "answer":
        hub.ingest({
          kind: "fence",
          docId: DOC,
          n: command.n,
          edit: edit(),
          ...(command.text ? { text: state.text } : {}),
        });
        return { reqId: 0, ok: true };
    }
  };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const relay = createInputRelay({
    agentLink: { async *msgs() {}, sendCmd },
    send: async (_session, method, params) => {
      await wait(options.dispatchMs?.() ?? 0);
      if (method === "Input.insertText") {
        state.text += String(params?.text ?? "");
        hub.ingest(mutation());
      }
      if (
        method === "Input.dispatchKeyEvent" &&
        params?.key === "Enter" &&
        params.type === "keyDown"
      )
        state.text = options.rewrite?.(state.text) ?? "";
      return {};
    },
    sessionFor: () => (state.closed ? undefined : "session"),
    isDriver: (viewerId) => options.isDriver?.(viewerId) ?? viewerId === "driver",
    allowsInput: () => true,
    noteInput: () => undefined,
    viewportFor: () => ({ w: 100, h: 100 }),
    onDispatched: (viewerId, msg, ok) =>
      scheduler.noteDispatched(viewerId, msg, ok && !(options.fail?.(msg) ?? false)),
    beforeDispatch: (viewerId, msg) => scheduler.beforeDispatch(viewerId, msg),
    onReset: (tab) => scheduler.reset(tab),
  });
  const scheduler = createAckScheduler({
    fence: (tab, n, text) => sendCmd(tab, { cmd: "fence", n, ...(text ? { text } : {}) }),
    hubFor: () => hub,
    sendTo: (viewerId, down) => acks.push([viewerId, down]),
    enqueue: relay.enqueue,
    guard: options.guard ?? "off",
    onGuard: (_tab, kind, refused) => guards.push(`${kind}${refused ? ":refused" : ""}`),
  });
  let iseq = 0;
  const text = (insert: string, viewer = "driver", stamped = true): Promise<boolean> =>
    relay(viewer, {
      t: "text",
      tab: TAB,
      insert,
      ...(stamped ? { iseq: ++iseq } : {}),
    });
  const enter = async (expect?: EditExpect): Promise<boolean> => {
    const sent = relay("driver", {
      t: "key",
      tab: TAB,
      kind: "down",
      key: "Enter",
      code: "Enter",
      mods: 0,
      iseq: ++iseq,
      ...(expect ? { expect } : {}),
    });
    await settle(20);
    return sent;
  };
  return { hub, state, acks, guards, relay, scheduler, text, enter, iseq: () => iseq };
}

/** Lets the relay's queue, its fences and their timers run. */
const settle = async (ms = QUIET_FENCE_MS + 10) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("input acks", () => {
  it("fences a burst once, when it goes quiet", async () => {
    const { acks, state, text } = page();
    void text("a");
    void text("b");
    void text("c");
    await settle(10);
    expect(state.fences).toBe(0);
    expect(acks).toEqual([]);
    await settle();
    expect(state.fences).toBe(1);
    expect(acks.map(([, ack]) => ack)).toEqual([
      {
        t: "input-ack",
        tab: TAB,
        iseq: 3,
        mode: "page",
        epoch: 5,
        seq: 4,
        edit: { node: 9, len: 3, hash: editHash("abc"), sel: [3, 3] },
        final: true,
      },
    ]);
  });

  it("sends no fence into an open IME composition, and acknowledges it once committed", async () => {
    const { acks, state, relay, iseq } = page();
    let next = iseq();
    const ime = (value: string) =>
      relay("driver", {
        t: "ime",
        tab: TAB,
        text: value,
        selStart: value.length,
        selEnd: value.length,
        iseq: ++next,
      });
    void ime("n");
    void ime("ni");
    await settle();
    await settle();
    // Running the fence's command in the page could end the composition early.
    expect(state.fences).toBe(0);
    expect(acks).toEqual([]);
    // The commit (text) ends it: everything up to it is acknowledged.
    void relay("driver", { t: "text", tab: TAB, insert: "你", iseq: ++next });
    await settle(10);
    await settle();
    expect(state.fences).toBeGreaterThan(0);
    expect(acks.at(-1)![1]).toMatchObject({ iseq: 3, mode: "page", final: true });
  });

  it("fences input that keeps coming after 64 inputs, and 2 s after the first", async () => {
    const fenced: number[] = [];
    let now = 0;
    const scheduler = createAckScheduler({
      fence: async () => ({ reqId: 0, ok: true }),
      hubFor: () => undefined,
      sendTo: () => undefined,
      enqueue: () => fenced.push(now),
      now: () => now,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    const key = (iseq: number): InputMsg => ({
      t: "text",
      tab: TAB,
      insert: "x",
      iseq,
    });
    for (let iseq = 1; iseq <= 63; iseq++) scheduler.noteDispatched("driver", key(iseq), true);
    expect(fenced).toEqual([]);
    scheduler.noteDispatched("driver", key(64), true);
    expect(fenced).toEqual([0]);
    now = 10;
    scheduler.noteDispatched("driver", key(65), true);
    now = 2_009;
    scheduler.noteDispatched("driver", key(66), true);
    expect(fenced).toEqual([0]);
    now = 2_010;
    scheduler.noteDispatched("driver", key(67), true);
    expect(fenced).toEqual([0, 2_010]);
  });

  it("re-arms the quiet fence with every input, so a burst gets one final ack", async () => {
    const { acks, text } = page();
    for (let index = 0; index < 5; index++) {
      void text(String(index));
      await settle(QUIET_FENCE_MS - 20);
    }
    expect(acks.filter(([, ack]) => ack.final)).toHaveLength(0);
    await settle(30);
    const finals = acks.filter(([, ack]) => ack.final);
    expect(finals).toHaveLength(1);
    expect(finals[0]![1]).toMatchObject({ iseq: 5, edit: { hash: editHash("01234") } });
    // The keys came closer together than the quiet fence waits: one burst, one fence.
    expect(acks.map(([, ack]) => ack.iseq)).toEqual([5]);
  });

  it("covers every input exactly once, in order, whatever the timing", async () => {
    const random = mulberry32(42);
    for (let run = 0; run < 200; run++) {
      const failing = new Set<number>();
      const { acks, text, iseq } = page({
        dispatchMs: () => Math.floor(random() * 4),
        fail: (msg) => failing.has((msg as { iseq: number }).iseq),
      });
      const count = 1 + Math.floor(random() * 25);
      for (let index = 0; index < count; index++) {
        if (random() < 0.2) failing.add(iseq() + 1);
        void text("x");
        if (random() < 0.5) await settle(Math.floor(random() * 80));
      }
      await settle(500);
      const sequence = acks.map(([, ack]) => ack);
      // Never backwards; the same iseq again only as its final ack.
      for (let index = 1; index < sequence.length; index++) {
        const previous = sequence[index - 1]!;
        const current = sequence[index]!;
        expect(current.iseq).toBeGreaterThanOrEqual(previous.iseq);
        if (current.iseq === previous.iseq) expect(current.final).toBe(true);
      }
      expect(sequence.at(-1)!.iseq).toBe(count);
      expect(sequence.at(-1)!.final).toBe(true);
      // Every refused input is named once, by the ack that first covers it.
      const named = sequence.flatMap((ack) => ack.failed ?? []);
      expect(named.sort((a, b) => a - b)).toEqual([...failing].sort((a, b) => a - b));
      let covered = 0;
      for (const ack of sequence) {
        for (const failed of ack.failed ?? []) {
          expect(failed).toBeGreaterThan(covered);
          expect(failed).toBeLessThanOrEqual(ack.iseq);
        }
        covered = ack.iseq;
      }
    }
  });

  it("names the inputs the page did not take", async () => {
    const { acks, text } = page({ fail: (msg) => (msg as { iseq: number }).iseq === 2 });
    void text("a");
    void text("b");
    void text("c");
    await settle();
    expect(acks.map(([, ack]) => ack.failed)).toEqual([[2]]);
  });

  it("acknowledges dispatch only, and stops fencing, when the agent knows no fence", async () => {
    const { acks, state, text } = page({ fence: "legacy" });
    void text("a");
    await settle();
    // The quiet fence's ack is final all the same: the viewer stops waiting for one.
    expect(acks.map(([, ack]) => ack)).toEqual([
      { t: "input-ack", tab: TAB, iseq: 1, mode: "dispatch", final: true },
    ]);
    const fences = state.fences;
    void text("b");
    void text("c");
    await settle();
    expect(state.fences).toBe(fences);
    expect(acks.at(-1)![1]).toEqual({
      t: "input-ack",
      tab: TAB,
      iseq: 3,
      mode: "dispatch",
      final: true,
    });
  });

  it("acknowledges dispatch only when the page does not answer in time", async () => {
    for (const behaviour of ["silent", "lost-in-stream"] as const) {
      const { acks, text } = page({ fence: behaviour });
      void text("a");
      await settle(FENCE_TIMEOUT_MS - 1);
      expect(acks).toEqual([]);
      await settle(FENCE_TIMEOUT_MS + 100);
      // The quiet fence's ack, final all the same.
      expect(acks[0]![1]).toEqual({
        t: "input-ack",
        tab: TAB,
        iseq: 1,
        mode: "dispatch",
        final: true,
      });
    }
  });

  it("acknowledges as dispatched what a reset discarded, and nothing of its fences after", async () => {
    const { acks, relay, state, text } = page({ fence: "silent" });
    void text("a");
    void text("b");
    await settle(5);
    relay.resetTab(TAB);
    expect(acks.map(([, ack]) => ack)).toEqual([
      { t: "input-ack", tab: TAB, iseq: 2, mode: "dispatch", final: true },
    ]);
    state.behaviour = "answer";
    await settle(FENCE_TIMEOUT_MS * 3);
    // The quiet fence was cancelled, and the silent fence's timeout answers nothing now.
    expect(acks).toHaveLength(1);
  });

  it("fences nothing for hovers, wheel or scroll, and they keep no final ack from coming", async () => {
    const enqueued: string[] = [];
    const sent: InputAckMsg[] = [];
    const timers: Array<{ at: number; run: () => void } | null> = [];
    let now = 0;
    const scheduler = createAckScheduler({
      fence: async () => ({ reqId: 0, ok: false, err: UNKNOWN_FENCE_ERROR }),
      hubFor: () => undefined,
      sendTo: (_viewer, ack) => sent.push(ack),
      enqueue: (_tab, task) => {
        enqueued.push("fence");
        void task();
      },
      now: () => now,
      setTimer: (run, delay) => timers.push({ at: now + delay, run }) - 1,
      clearTimer: (timer) => (timers[timer as number] = null),
    });
    const advance = async (ms: number) => {
      const until = now + ms;
      for (;;) {
        const due = timers
          .map((timer, index) => ({ timer, index }))
          .filter(({ timer }) => timer !== null && timer.at <= until)
          .sort((a, b) => a.timer!.at - b.timer!.at)[0];
        if (due === undefined) break;
        now = due.timer!.at;
        timers[due.index] = null;
        due.timer!.run();
        await Promise.resolve();
      }
      now = until;
      await Promise.resolve();
    };
    const ptr = (iseq: number, kind: "move" | "wheel"): InputMsg => ({
      t: "ptr",
      tab: TAB,
      kind,
      nodeId: 1,
      rx: 0,
      ry: 0,
      vx: 1,
      vy: 1,
      buttons: 0,
      mods: 0,
      iseq,
    });
    for (let iseq = 1; iseq <= 10; iseq++) {
      scheduler.noteDispatched("driver", ptr(iseq, iseq % 2 === 0 ? "wheel" : "move"), true);
      await advance(33);
    }
    scheduler.noteDispatched(
      "driver",
      { t: "scroll", tab: TAB, nodeId: 0, x: 0, y: 1, iseq: 11 },
      true,
    );
    expect(enqueued).toEqual([]);
    // A key, then the pointer keeps moving: the burst still gets its final ack.
    scheduler.noteDispatched("driver", { t: "text", tab: TAB, insert: "a", iseq: 12 }, true);
    expect(enqueued).toEqual([]);
    for (let iseq = 13; iseq <= 20; iseq++) {
      await advance(33);
      scheduler.noteDispatched("driver", ptr(iseq, "move"), true);
    }
    await advance(QUIET_FENCE_MS);
    expect(enqueued).toEqual(["fence"]);
    expect(sent.at(-1)).toMatchObject({ mode: "dispatch", final: true });
    expect(sent.at(-1)!.iseq).toBeGreaterThanOrEqual(12);
  });

  it("notes input refused before the relay after the input queued before it", async () => {
    let slow = true;
    const { acks, scheduler, text } = page({ dispatchMs: () => (slow ? 300 : 0) });
    void text("a");
    void text("b");
    await settle(10);
    slow = false;
    scheduler.refuse("driver", { t: "text", tab: TAB, insert: "c", iseq: 3 });
    await settle(200);
    // Nothing covers 3 while 1 and 2 are still waiting to be dispatched.
    expect(acks.filter(([, ack]) => ack.iseq >= 3)).toEqual([]);
    await settle(1_000);
    expect(acks.at(-1)![1]).toMatchObject({ iseq: 3, final: true });
    expect(acks.flatMap(([, ack]) => ack.failed ?? [])).toEqual([3]);
  });

  it("reports a refusal that comes after a later input was acknowledged", async () => {
    const { acks, scheduler, text } = page();
    void text("a");
    void text("b");
    await settle();
    expect(acks.at(-1)![1]).toMatchObject({ iseq: 2, final: true });
    // Input 1 again, refused late (it was queued on a chain a reset cut loose).
    scheduler.noteDispatched(
      "driver",
      { t: "value", tab: TAB, nodeId: 9, value: "a", iseq: 1 },
      false,
    );
    expect(acks.at(-1)![1]).toEqual({
      t: "input-ack",
      tab: TAB,
      iseq: 2,
      mode: "dispatch",
      failed: [1],
    });
  });

  it("forgets a closed tab, and fences nothing for input still on its way to it", async () => {
    const { acks, relay, state, scheduler, text } = page({ dispatchMs: () => 50 });
    void text("a");
    void text("b");
    await settle(10);
    state.closed = true;
    relay.forgetTab(TAB);
    scheduler.forget(TAB);
    const fences = state.fences;
    await settle(1_000);
    expect(state.fences).toBe(fences);
    // The reset's ack covers what was dispatched; the stragglers are answered as refused.
    expect(acks[0]![1]).toMatchObject({ mode: "dispatch", final: true });
    expect(acks.at(-1)![1]).toMatchObject({ mode: "dispatch", final: true, iseq: 2 });
    expect((scheduler as AckScheduler).fenceCount()).toBe(fences);
  });

  it("sends acks to the driver only, and fences nothing for an older viewer", async () => {
    const { acks, state, text } = page();
    void text("a", "driver");
    await settle();
    expect(new Set(acks.map(([viewer]) => viewer))).toEqual(new Set(["driver"]));
    const before = state.fences;
    const sent = acks.length;
    void text("old", "driver", false);
    void text("older", "driver", false);
    await settle(500);
    expect(state.fences).toBe(before);
    expect(acks).toHaveLength(sent);
  });

  it("lets refused input of a viewer that does not drive leave the driver's acks alone", async () => {
    const { acks, text } = page();
    void text("a", "driver");
    void text("b", "spectator");
    void text("c", "driver");
    await settle();
    expect(
      acks
        .filter(([viewer]) => viewer === "driver")
        .map(([viewer, ack]) => [viewer, ack.iseq, ack.final ?? false]),
    ).toEqual([["driver", 3, true]]);
    // The spectator hears that its input was refused, and nothing is fenced for it.
    expect(acks.filter(([viewer]) => viewer === "spectator")).toEqual([
      [
        "spectator",
        { t: "input-ack", tab: TAB, iseq: 2, mode: "dispatch", failed: [2], final: true },
      ],
    ]);
  });

  it("answers what the last driver sent when another viewer takes over", async () => {
    const { acks, text } = page({ isDriver: () => true, fence: "silent" });
    void text("a", "first");
    void text("b", "first");
    await settle(5);
    void text("c", "second");
    await settle(FENCE_TIMEOUT_MS + 10);
    expect(acks[0]).toEqual([
      "first",
      { t: "input-ack", tab: TAB, iseq: 2, mode: "dispatch", final: true },
    ]);
    await settle(FENCE_TIMEOUT_MS * 3);
    expect(acks.filter(([viewer]) => viewer === "first")).toHaveLength(1);
    expect(acks.filter(([viewer]) => viewer === "second").at(-1)![1]).toMatchObject({
      iseq: 3,
      final: true,
    });
  });
});

describe("submit guard", () => {
  const expectFor = (text: string, node = 9): EditExpect => ({
    node,
    len: text.length,
    hash: editHash(text),
    head: editHash(text.slice(0, text.length - expectTail(text.length))),
  });
  const fence = (text: string | null, node = 9) => ({
    n: 1,
    epoch: 1,
    seq: 1,
    edit:
      text === null
        ? null
        : { node, len: text.length, hash: editHash(text), sel: [0, 0] as [number, number] },
    ...(text === null ? {} : { text }),
  });

  it("classifies what the page holds against what was shown", () => {
    const shown = "a message long enough to have a head -- here";
    expect(classifySubmit(expectFor(shown), fence(shown))).toBe("match");
    expect(classifySubmit(expectFor(shown), fence(shown.replace("--", "—")))).toBe("rewrite");
    expect(classifySubmit(expectFor("say teh"), fence("say the"))).toBe("rewrite");
    // A short message keeps a head: another short text is not a rewrite of it.
    expect(classifySubmit(expectFor("yes"), fence("no thanks"))).toBe("stale");
    expect(classifySubmit(expectFor("ok"), fence("no"))).toBe("stale");
    expect(classifySubmit(expectFor("x"), fence("y"))).toBe("stale");
    expect(classifySubmit(expectFor(shown), fence("an old message the page still holds"))).toBe(
      "stale",
    );
    expect(classifySubmit(expectFor(shown), fence(shown + "x".repeat(17)))).toBe("stale");
    expect(classifySubmit(expectFor(shown), fence(null))).toBe("focus");
    expect(classifySubmit(expectFor(shown), fence(shown, 10))).toBe("focus");
    expect(classifySubmit(expectFor(shown), "timeout")).toBe("timeout");
  });

  it("only counts in shadow mode, and Enter goes out either way", async () => {
    const { guards, state, text, enter, hub } = page({ guard: "shadow" });
    const fenced: unknown[] = [];
    hub.onFence((result) => fenced.push(result));
    void text("hello");
    await settle();
    await enter(expectFor("hello"));
    await enter(expectFor("a different and much longer message than that"));
    await settle();
    expect(guards).toEqual(["match", "stale"]);
    // The guard's fence read the page's text, which no listener of the hub is given.
    expect(JSON.stringify(fenced)).not.toContain("hello");
    expect(state.text).toBe("");
  });

  it("does not hold Enter back for the guard in shadow mode", async () => {
    const { guards, relay, state, text } = page({ guard: "shadow" });
    void text("hello");
    await settle();
    state.behaviour = "silent";
    let sent: boolean | undefined;
    void relay("driver", {
      t: "key",
      tab: TAB,
      kind: "down",
      key: "Enter",
      code: "Enter",
      mods: 0,
      iseq: 2,
      expect: expectFor("hello"),
    }).then((ok) => (sent = ok));
    await settle(1);
    // Dispatched at once; the page's field went with it.
    expect(sent).toBe(true);
    expect(state.text).toBe("");
    await settle(FENCE_TIMEOUT_MS + 10);
    expect(guards).toEqual(["timeout"]);
  });

  it("waits for the guard in on mode, at most one fence timeout in all", async () => {
    const { guards, relay, state, text } = page({ guard: "on", fence: "lost-in-stream" });
    void text("hello");
    await settle();
    let sent: boolean | undefined;
    void relay("driver", {
      t: "key",
      tab: TAB,
      kind: "down",
      key: "Enter",
      code: "Enter",
      mods: 0,
      iseq: 2,
      expect: expectFor("hello"),
    }).then((ok) => (sent = ok));
    await settle(FENCE_TIMEOUT_MS - 10);
    expect(sent).toBeUndefined();
    await settle(20);
    expect(sent).toBe(false);
    expect(guards).toEqual(["timeout:refused"]);
    expect(state.text).toBe("hello");
  });

  it("refuses a stale Enter in on mode, and says so in the next ack", async () => {
    const { acks, guards, state, text, enter } = page({ guard: "on" });
    const shown = "the message the person sees right now";
    void text(shown);
    await settle();
    state.text = "a message the page held from before";
    expect(await enter(expectFor(shown))).toBe(false);
    await settle();
    expect(guards).toEqual(["stale:refused"]);
    expect(state.text).toBe("a message the page held from before");
    expect(acks.at(-1)![1]).toMatchObject({ iseq: 2, final: true });
    expect(acks.flatMap(([, ack]) => ack.failed ?? [])).toEqual([2]);
    // A page that rewrote the tail of the message still sends.
    state.text = "a long message that ends in a dash —";
    expect(await enter(expectFor("a long message that ends in a dash --"))).toBe(true);
    expect(guards).toEqual(["stale:refused", "rewrite"]);
  });

  it("leaves passwords and old agents alone", async () => {
    const { guards, enter } = page({ guard: "on" });
    expect(await enter({ node: 9, len: 3, hash: "", head: "" })).toBe(true);
    const legacy = page({ guard: "on", fence: "legacy" });
    legacy.state.text = "x";
    expect(await legacy.enter(expectFor("hello"))).toBe(true);
    expect([...guards, ...legacy.guards]).toEqual([]);
  });
});

describe("ack configuration", () => {
  it("reads the modes and refuses anything else", () => {
    expect(parseAckMode("MIRROR_INPUT_ACKS", undefined, "shadow")).toBe("shadow");
    expect(parseAckMode("MIRROR_INPUT_ACKS", "", "shadow")).toBe("shadow");
    for (const mode of ["off", "shadow", "on"] as const)
      expect(parseAckMode("MIRROR_INPUT_ACKS", mode, "shadow")).toBe(mode);
    expect(() => parseAckMode("MIRROR_SUBMIT_GUARD", "yes", "shadow")).toThrow(
      /MIRROR_SUBMIT_GUARD must be off, shadow or on/,
    );
  });

  it("advertises what the mode does", () => {
    expect(ackCaps("off")).toEqual([]);
    expect(ackCaps("shadow")).toEqual(["ack1"]);
    expect(ackCaps("on")).toEqual(["ack1", "ackecho1"]);
  });

  it("advertises single-writer input only with acks, and refuses it without them", () => {
    expect(ackCaps("shadow", "on")).toEqual(["ack1", "proxyin1"]);
    expect(ackCaps("on", "on")).toEqual(["ack1", "ackecho1", "proxyin1"]);
    expect(ackCaps("off", "on")).toEqual([]);
    expect(ackCaps("on", "off")).toEqual(["ack1", "ackecho1"]);
    expect(proxyInputConfig({})).toBe("off");
    expect(proxyInputConfig({ MIRROR_PROXY_INPUT: "" })).toBe("off");
    expect(proxyInputConfig({ MIRROR_PROXY_INPUT: "on" })).toBe("on");
    expect(proxyInputConfig({ MIRROR_PROXY_INPUT: "on", MIRROR_INPUT_ACKS: "shadow" })).toBe("on");
    expect(() => proxyInputConfig({ MIRROR_PROXY_INPUT: "on", MIRROR_INPUT_ACKS: "off" })).toThrow(
      /needs input acks/,
    );
    expect(() => proxyInputConfig({ MIRROR_PROXY_INPUT: "yes" })).toThrow(
      /MIRROR_PROXY_INPUT must be off or on/,
    );
  });
});

/** A small seeded generator, so a failing interleaving can be run again. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
