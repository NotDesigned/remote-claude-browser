/**
 * Input sequence numbers and acknowledgements (`input-ack`).
 *
 * With a gateway that lists `ack1` in `hello.caps`, every input that can change a field (keys,
 * text, values, IME, pointer presses and releases: isAckedInput) gets `iseq`, numbered per tab
 * from 1 on each connection (a new connection is a new viewer to the gateway). The gateway
 * answers with cumulative acks: every input up to `iseq` was handled, its effects are in the page's
 * stream up to `seq` of `epoch`, and this is what the page's focused field now holds (length, hash
 * and selection, never its text).
 *
 * An ack means nothing to this page until its replay shows that far. It is held until the mirror
 * has applied stream position `seq` of the same epoch; then a marker goes into the Replayer after
 * those events, and the ack settles when the Replayer plays the marker, so whoever acts on it
 * compares the page's hash with a replay that really has the page's changes. An ack of another
 * epoch, or one the gateway could not fence (`mode: "dispatch"`), settles as dispatch only: the
 * input was handled, nothing more is known.
 */
import {
  CAP_ACK_ECHO,
  CAP_INPUT_ACKS,
  isAckedInput,
  CAP_PROXY_INPUT,
  type EditState,
  type InputAckMsg,
  type TabId,
  type Up,
} from "@mirror/protocol";

/** An acknowledgement the replay has caught up with. */
export interface SettledAck {
  tab: TabId;
  iseq: number;
  /** "dispatch": the input was handled, but what the page did with it is not known here. */
  mode: "page" | "dispatch";
  /**
   * The gateway fenced it in the page (its own mode was "page"). False when it could not (an
   * agent from before fences, a page that did not answer); a fenced ack can still settle as
   * "dispatch" here, when the replay it was for is gone.
   */
  fenced: boolean;
  /** Only for "page": what the page's focused field held (null: no field had focus). */
  edit?: EditState | null;
  failed: readonly number[];
  /** One of `failed` was a `value` (a whole-field sync). */
  failedValue: boolean;
  /** How long ago the input `iseq` was sent, when it was sent on this connection. */
  rtt?: number;
  final: boolean;
}

/** What the inputlab HUD shows; see InputSequencer.count for the names. */
export interface InputLabStats {
  stamped: number;
  acks: number;
  dispatchOnlyAcks: number;
  hashMatchAtFinal: number;
  hashMismatchAtFinal: number;
  decayWhileOutstanding: number;
  ackRttP50: number | null;
  ackRttP95: number | null;
}

export type InputLabCounter =
  "hashMatchAtFinal" | "hashMismatchAtFinal" | "decayWhileOutstanding" | "dispatchOnlyAcks";

export interface InputSequencerOptions {
  now?: () => number;
  /**
   * Puts a marker after everything the tab's live replay has been given and calls back when the
   * Replayer plays it (true), or when that Replayer is gone first (false). False when the tab has
   * no live replay.
   */
  mark?(tab: TabId, played: (played: boolean) => void): boolean;
}

export interface InputSequencer {
  /** Every `hello`: a new connection numbers from 1 again, and its caps say what is on. */
  hello(caps: readonly string[] | undefined): void;
  /** The connection is gone: nothing outstanding will be acknowledged any more. */
  connectionLost(): void;
  /** Acks are sent (`ack1`): input is stamped and measured. */
  enabled(): boolean;
  /** Acks drive the typing echo (`ackecho1`). */
  echoEnabled(): boolean;
  /** Single-writer input is offered (`proxyin1`, only with `ack1`). */
  proxyEnabled(): boolean;
  /** The message as it goes on the wire: with `iseq` for input when acks are on. */
  stamp(msg: Up): Up;
  /** The newest iseq sent for the tab on this connection, 0 before any. */
  lastStamped(tab: TabId): number;
  /** Inputs of the tab sent and not yet settled. */
  outstanding(tab: TabId): number;
  /** Feed every `input-ack`. */
  onAck(ack: InputAckMsg): void;
  /** The mirror has applied the tab's stream up to `nextSeq - 1` of `epoch`. */
  applied(tab: TabId, epoch: number, nextSeq: number): void;
  subscribe(listener: (settled: SettledAck) => void): () => void;
  /** Smoothed time from sending an input to its ack settling, or null before any. */
  rtt(): number | null;
  count(counter: InputLabCounter): void;
  stats(): InputLabStats;
}

/** Acks held for a tab whose replay is not live are given up as dispatch only past this many. */
const MAX_HELD = 64;
const RTT_SAMPLES = 256;
/**
 * `value` iseqs remembered after their ack, to know a refusal that a later ack reports (an input
 * still queued when its tab was reset is refused after inputs that came later were acknowledged).
 */
const VALUES_KEPT = 64;

export function createInputSequencer(options: InputSequencerOptions = {}): InputSequencer {
  const now = options.now ?? (() => performance.now());
  let caps: readonly string[] = [];
  /** Per tab: last iseq sent, last settled, when each unsettled one was sent. */
  const tabs = new Map<
    TabId,
    { stamped: number; settled: number; sentAt: Map<number, number>; values: Set<number> }
  >();
  /** Per tab: acks waiting for the replay, in the order they came. */
  /** `done`: settled once it reaches the head; true when its marker played. */
  const held = new Map<TabId, Array<{ ack: InputAckMsg; marking: boolean; done?: boolean }>>();
  const applied = new Map<TabId, { epoch: number; nextSeq: number }>();
  const listeners = new Set<(settled: SettledAck) => void>();
  /** Bumped per connection: markers of an earlier one settle nothing. */
  let connection = 0;
  let smoothedRtt: number | null = null;
  const rttSamples: number[] = [];
  const counters = {
    stamped: 0,
    acks: 0,
    dispatchOnlyAcks: 0,
    hashMatchAtFinal: 0,
    hashMismatchAtFinal: 0,
    decayWhileOutstanding: 0,
  };

  const tabState = (tab: TabId) => {
    let state = tabs.get(tab);
    if (state === undefined) {
      state = { stamped: 0, settled: 0, sentAt: new Map(), values: new Set() };
      tabs.set(tab, state);
    }
    return state;
  };

  const settle = (ack: InputAckMsg, page: boolean) => {
    const state = tabState(ack.tab);
    if (ack.iseq < state.settled) return;
    const sent = state.sentAt.get(ack.iseq);
    let sample: number | undefined;
    if (sent !== undefined) {
      sample = Math.max(0, now() - sent);
    }
    // A final ack repeating an iseq already settled is no round trip: it waited for quiet.
    if (sample !== undefined && ack.iseq > state.settled) {
      smoothedRtt = smoothedRtt === null ? sample : smoothedRtt * 0.875 + sample * 0.125;
      rttSamples.push(sample);
      if (rttSamples.length > RTT_SAMPLES) rttSamples.shift();
    }
    // The newest one stays: a final ack for the same iseq then says how long since that input.
    for (const iseq of state.sentAt.keys()) if (iseq < ack.iseq) state.sentAt.delete(iseq);
    const failed = ack.failed ?? [];
    const failedValue = failed.some((iseq) => state.values.has(iseq));
    for (const iseq of state.values) {
      if (state.values.size <= VALUES_KEPT) break;
      state.values.delete(iseq);
    }
    state.settled = ack.iseq;
    if (!page) counters.dispatchOnlyAcks += 1;
    const settled: SettledAck = {
      tab: ack.tab,
      iseq: ack.iseq,
      mode: page ? "page" : "dispatch",
      fenced: ack.mode === "page",
      ...(page ? { edit: ack.edit ?? null } : {}),
      failed,
      failedValue,
      final: ack.final === true,
      ...(sample === undefined ? {} : { rtt: sample }),
    };
    for (const listener of [...listeners]) listener(settled);
  };

  /**
   * Starts a marker for every ack the replay has applied, and settles acks in the order they came
   * as their markers play: markers of acks that came together play in one frame, not one by one.
   */
  const drain = (tab: TabId) => {
    const queue = held.get(tab);
    if (queue === undefined) return;
    const settleDone = () => {
      while (queue.length > 0 && queue[0]!.done !== undefined) {
        const head = queue.shift()!;
        settle(head.ack, head.done!);
      }
    };
    settleDone();
    for (const entry of queue) {
      if (entry.done !== undefined || entry.marking) continue;
      const { ack } = entry;
      if (ack.mode !== "page" || ack.seq === undefined || ack.epoch === undefined) {
        entry.done = false;
        continue;
      }
      const shown = applied.get(tab);
      if (shown === undefined || shown.epoch !== ack.epoch) {
        // Another document, or none shown: the page's report is about something not on screen.
        entry.done = false;
        continue;
      }
      // Later acks are further on in the stream: they wait too.
      if (shown.nextSeq <= ack.seq) break;
      entry.marking = true;
      const current = connection;
      const marked =
        options.mark?.(tab, (played) => {
          if (current !== connection || entry.done !== undefined) return;
          entry.done = played;
          drain(tab);
        }) ?? false;
      if (!marked && entry.done === undefined) entry.done = options.mark === undefined;
    }
    // A tab whose replay is not live does not keep acks forever.
    while (queue.length > MAX_HELD && queue[0]!.done === undefined) queue[0]!.done = false;
    settleDone();
  };

  const dropAll = () => {
    connection += 1;
    for (const [tab, queue] of held) {
      const pending = queue.splice(0);
      for (const { ack } of pending) settle(ack, false);
      held.delete(tab);
    }
    // Inputs sent and never acknowledged are given up.
    for (const [tab, state] of tabs) {
      if (state.stamped > state.settled)
        settle({ t: "input-ack", tab, iseq: state.stamped, mode: "dispatch" }, false);
    }
    tabs.clear();
  };

  return {
    hello(next) {
      dropAll();
      caps = next ?? [];
    },
    connectionLost() {
      dropAll();
      caps = [];
    },
    enabled: () => caps.includes(CAP_INPUT_ACKS),
    echoEnabled: () => caps.includes(CAP_INPUT_ACKS) && caps.includes(CAP_ACK_ECHO),
    proxyEnabled: () => caps.includes(CAP_INPUT_ACKS) && caps.includes(CAP_PROXY_INPUT),
    stamp(msg) {
      if (!caps.includes(CAP_INPUT_ACKS)) {
        if (msg.t === "key" && msg.expect !== undefined) {
          const { expect: _expect, ...rest } = msg;
          return rest;
        }
        return msg;
      }
      // Hovers, drags, wheel and scroll go unstamped: the gateway fences nothing for them.
      if (!isAckedInput(msg)) return msg;
      const state = tabState(msg.tab);
      state.stamped += 1;
      state.sentAt.set(state.stamped, now());
      if (msg.t === "value") state.values.add(state.stamped);
      counters.stamped += 1;
      return { ...msg, iseq: state.stamped };
    },
    lastStamped: (tab) => tabs.get(tab)?.stamped ?? 0,
    outstanding(tab) {
      const state = tabs.get(tab);
      return state === undefined ? 0 : Math.max(0, state.stamped - state.settled);
    },
    onAck(ack) {
      counters.acks += 1;
      let queue = held.get(ack.tab);
      if (queue === undefined) {
        queue = [];
        held.set(ack.tab, queue);
      }
      queue.push({ ack, marking: false });
      drain(ack.tab);
    },
    applied(tab, epoch, nextSeq) {
      applied.set(tab, { epoch, nextSeq });
      drain(tab);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rtt: () => smoothedRtt,
    count(counter) {
      counters[counter] += 1;
    },
    stats() {
      const sorted = [...rttSamples].sort((a, b) => a - b);
      const at = (q: number) =>
        sorted.length === 0
          ? null
          : Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
      return { ...counters, ackRttP50: at(0.5), ackRttP95: at(0.95) };
    },
  };
}
