/**
 * Input acknowledgements (`input-ack`) for the driving viewer.
 *
 * The viewer numbers its input per tab (`iseq`). Once the relay has dispatched some, a fence goes
 * to the page in the same queue: the page answers it after those inputs' effects reached its
 * recorder, in the ordered stream, with what its focused field now holds (agent/src/fence.ts).
 * TabHub notes the stream position it had reached, and the viewer gets one cumulative ack: every
 * input up to `iseq` was handled, its effects are in the stream up to `seq` of `epoch`, and this
 * is the field's length, hash and selection. The viewer acts on it once its replay has applied
 * that far, so it decides on sequence numbers and the page's own hash instead of timers.
 *
 * A fence goes out when the relay has nothing more queued, after 8 inputs, or 50 ms after the
 * first input not yet fenced; one more, the quiet fence (`final`), 60 ms after the last input. An
 * agent from before fences (it answers "unknown command: fence") and a fence that does not come
 * back in time give `mode: "dispatch"` acks: the inputs were dispatched, nothing more is known.
 * The quiet fence's ack is final either way, so the viewer stops waiting for one.
 *
 * Only input that carries `iseq` is tracked: an older viewer sends none, and gets no fences. Only
 * input that can change a field (isAckedInput) is fenced: a hover, drag, wheel or scroll that
 * carries `iseq` is folded into the next ack, and neither fences nor delays a final ack.
 *
 * Input refused before it reached the relay (a viewer that no longer drives, a tab that is gone
 * or blocked) is refused in the relay's queue (refuse), so an ack never covers input still queued.
 * A viewer that does not hold the tab's acks, or input to a tab that has closed, gets its own
 * final dispatch ack listing what was refused, and no fence.
 *
 * No fence goes to the page while an IME composition is open there (an `ime` with text, until the
 * commit or a key): running the fence's command in the page then can end the
 * composition early, and the page loses its uncommitted text. The inputs are acknowledged once
 * the composition ends.
 */
import {
  MAX_ACK_FAILED,
  UNKNOWN_FENCE_ERROR,
  editHash,
  expectTail,
  isAckedInput,
  isIseq,
  type CmdRes,
  type EditExpect,
  type InputAckMsg,
} from "@mirror/protocol";
import type { FenceResult } from "../hub/tabhub";
import type { InputMsg } from "./relay";

/** A fence after this long since the first input it would cover, even while input keeps coming. */
export const FENCE_AFTER_MS = 50;
/** A fence after this many inputs, even while more are queued. */
export const FENCE_AFTER_INPUTS = 8;
/** The quiet fence follows the last input of a burst by this much. */
export const QUIET_FENCE_MS = 60;
/** How long the page has to answer a fence, and the stream to carry the answer. */
export const FENCE_TIMEOUT_MS = 1_000;
/** Closed tabs remembered, so input still on its way to one starts nothing for it. */
const FORGOTTEN_TABS = 256;

export type InputAcksMode = "off" | "shadow" | "on";
export type SubmitGuardMode = "off" | "shadow" | "on";
export type GuardClass = "match" | "rewrite" | "stale" | "focus" | "timeout";

/** The modes an environment variable names; anything else is a configuration error. */
export function parseAckMode(name: string, raw: string | undefined, fallback: InputAcksMode) {
  if (raw === undefined || raw === "") return fallback;
  if (raw === "off" || raw === "shadow" || raw === "on") return raw;
  throw new Error(`${name} must be off, shadow or on`);
}

/**
 * MIRROR_INPUT_ACKS and MIRROR_SUBMIT_GUARD, both "shadow" unless set. Read at startup, which
 * refuses a value it does not know.
 */
export function inputAckConfig(env: Record<string, string | undefined> = process.env): {
  acks: InputAcksMode;
  guard: SubmitGuardMode;
} {
  return {
    acks: parseAckMode("MIRROR_INPUT_ACKS", env.MIRROR_INPUT_ACKS, "shadow"),
    guard: parseAckMode("MIRROR_SUBMIT_GUARD", env.MIRROR_SUBMIT_GUARD, "shadow"),
  };
}

/** `hello.caps` for a gateway running acks in this mode. */
export function ackCaps(mode: InputAcksMode): string[] {
  return mode === "off" ? [] : mode === "shadow" ? ["ack1"] : ["ack1", "ackecho1"];
}

export interface AckHub {
  readonly docId: number;
  whenFenced(n: number, timeoutMs: number): Promise<FenceResult | "timeout">;
}

export interface AckSchedulerDeps {
  /** Sends `{cmd:"fence", n, text}` to the tab's page. */
  fence(tab: string, n: number, text?: boolean): Promise<CmdRes>;
  hubFor(tab: string): AckHub | undefined;
  /** To one viewer only; nothing happens when it has left. */
  sendTo(viewerId: string, down: InputAckMsg): void;
  /** The relay's tab queue (InputRelay.enqueue / isIdle). */
  enqueue(tab: string, task: () => Promise<void>): void;
  isIdle(tab: string): boolean;
  /** The submit guard; "off" when not given. */
  guard?: SubmitGuardMode;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  /** How long each fence took, from sending it to its place in the stream (diagnostics). */
  onFenceTime?(ms: number): void;
  /** Each submit-guard decision, as its class only. */
  onGuard?(tab: string, kind: GuardClass, refused: boolean): void;
}

interface TabState {
  viewerId: string;
  /** The highest iseq dispatched (or refused). */
  maxIseq: number;
  /** The highest iseq of input that is fenced (isAckedInput): a final ack must cover it. */
  maxEdit: number;
  lastAcked: number;
  /** Whether the last ack sent was final for lastAcked. */
  lastFinal: boolean;
  failed: number[];
  unfenced: number;
  firstUnfencedAt: number | null;
  /** Fences queued or awaited. */
  fencing: number;
  /** An IME composition is open on the page: fences wait until it ends. */
  composing: boolean;
  quietTimer: unknown;
  agent: "unknown" | "fence" | "legacy";
  /** The page document `agent` was learned from. */
  agentDoc: number | undefined;
  /** Bumped on reset: fences of before then answer nothing. */
  generation: number;
}

export interface AckScheduler {
  /** Relay hook: an input's dispatch settled. */
  noteDispatched(viewerId: string, msg: InputMsg, ok: boolean): void;
  /** Relay hook: the submit guard, for an Enter that carries `expect`. */
  beforeDispatch(viewerId: string, msg: InputMsg): Promise<boolean>;
  /**
   * Input refused before it reached the relay: it is noted in the tab's queue, after the input
   * queued before it.
   */
  refuse(viewerId: string, msg: InputMsg): void;
  /** Relay hook: the tab's queued input was discarded. */
  reset(tab: string): void;
  /** Relay hook: the tab is gone; nothing more is fenced or kept for it. */
  forget(tab: string): void;
  /** Counts of submit-guard classes since start (diagnostics). */
  guardCounts(): Record<GuardClass, number>;
  /** Fences sent since start (diagnostics). */
  fenceCount(): number;
}

/**
 * The submit guard's verdict on what the page's field holds against what the viewer showed when
 * Enter was pressed.
 */
export function classifySubmit(expect: EditExpect, fence: FenceResult | "timeout"): GuardClass {
  if (fence === "timeout") return "timeout";
  const edit = fence.edit;
  if (edit === null || edit.node !== expect.node) return "focus";
  if (edit.hash === expect.hash) return "match";
  const text = fence.text;
  // Only the tail may differ, and a text keeps a head (expectTail is at most half of it): with
  // none, any short text the page holds would pass as a rewrite of what was shown.
  const tail = expectTail(expect.len);
  if (
    text !== undefined &&
    expect.len - tail > 0 &&
    Math.abs(edit.len - expect.len) <= tail &&
    editHash(text.slice(0, expect.len - tail)) === expect.head
  )
    return "rewrite";
  return "stale";
}

export function createAckScheduler(deps: AckSchedulerDeps): AckScheduler {
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
  const clearTimer = deps.clearTimer ?? ((timer: unknown) => clearTimeout(timer as never));
  const guardMode = deps.guard ?? "off";
  const tabs = new Map<string, TabState>();
  const nextFence = new Map<string, number>();
  /** Tabs that have closed: input still on its way to them gets a stray ack. */
  const forgotten = new Set<string>();
  /** Refused input of viewers that hold no ack state for the tab, by viewer and tab. */
  const strays = new Map<
    string,
    { viewerId: string; tab: string; iseq: number; failed: number[]; timer: unknown }
  >();
  const guardCounts: Record<GuardClass, number> = {
    match: 0,
    rewrite: 0,
    stale: 0,
    focus: 0,
    timeout: 0,
  };
  let fences = 0;

  const fenceNumber = (tab: string) => {
    const n = (nextFence.get(tab) ?? 0) + 1;
    nextFence.set(tab, n);
    return n;
  };

  /** The page's agent can fence, as far as this document is known. */
  const agentFor = (tab: string, state: TabState) => {
    const docId = deps.hubFor(tab)?.docId;
    if (docId !== state.agentDoc) {
      state.agentDoc = docId;
      state.agent = "unknown";
    }
    return state.agent;
  };

  const send = (
    tab: string,
    state: TabState,
    covered: number,
    page: FenceResult | null,
    final: boolean,
  ) => {
    // Cumulative: never back, and the same iseq again only as its final ack, or to report a
    // refusal of input it already covered.
    if (covered < state.lastAcked) return;
    if (
      covered === state.lastAcked &&
      (!final || state.lastFinal) &&
      !state.failed.some((iseq) => iseq <= covered)
    )
      return;
    const failed = state.failed.filter((iseq) => iseq <= covered);
    state.failed = state.failed.filter((iseq) => iseq > covered);
    const ack: InputAckMsg = {
      t: "input-ack",
      tab,
      iseq: covered,
      mode: page === null ? "dispatch" : "page",
      ...(page === null ? {} : { epoch: page.epoch, seq: page.seq, edit: page.edit }),
      ...(failed.length > 0 ? { failed: failed.slice(-MAX_ACK_FAILED) } : {}),
      ...(final ? { final: true as const } : {}),
    };
    state.lastAcked = covered;
    state.lastFinal = final;
    deps.sendTo(state.viewerId, ack);
  };

  /** A quiet fence's ack is final when no fenced input came after what it covers. */
  const finalFor = (state: TabState, covered: number, final: boolean) =>
    final && state.maxEdit <= covered && state.unfenced === 0;

  /** A fence, in the relay's queue: it is sent after every input queued before it. */
  const enqueueFence = (tab: string, state: TabState, final: boolean) => {
    state.unfenced = 0;
    state.firstUnfencedAt = null;
    state.fencing += 1;
    const generation = state.generation;
    deps.enqueue(tab, async () => {
      // What it covers is what was dispatched before it.
      const covered = state.maxIseq;
      const done = () => {
        state.fencing -= 1;
      };
      if (tabs.get(tab) !== state || state.generation !== generation) return done();
      if (agentFor(tab, state) === "legacy") {
        send(tab, state, covered, null, finalFor(state, covered, final));
        return done();
      }
      const n = fenceNumber(tab);
      const started = now();
      fences += 1;
      let reply: CmdRes | "timeout";
      try {
        reply = await withTimeout(deps.fence(tab, n), FENCE_TIMEOUT_MS);
      } catch {
        reply = { reqId: 0, ok: false, err: "fence failed" };
      }
      if (reply !== "timeout" && !reply.ok && reply.err === UNKNOWN_FENCE_ERROR)
        state.agent = "legacy";
      if (reply === "timeout" || !reply.ok) {
        if (tabs.get(tab) === state && state.generation === generation)
          send(tab, state, covered, null, finalFor(state, covered, final));
        return done();
      }
      state.agent = "fence";
      // The page has answered; its place in the stream follows without holding up input.
      const hub = deps.hubFor(tab);
      void (
        hub === undefined
          ? Promise.resolve("timeout" as const)
          : hub.whenFenced(n, FENCE_TIMEOUT_MS)
      ).then((fence) => {
        done();
        if (tabs.get(tab) !== state || state.generation !== generation) return;
        if (fence === "timeout") {
          send(tab, state, covered, null, finalFor(state, covered, final));
          return;
        }
        deps.onFenceTime?.(now() - started);
        send(tab, state, covered, fence, finalFor(state, covered, final));
      });
    });
  };

  const armQuiet = (tab: string, state: TabState) => {
    if (state.quietTimer !== null) clearTimer(state.quietTimer);
    state.quietTimer = setTimer(() => {
      state.quietTimer = null;
      if (tabs.get(tab) !== state || state.composing) return;
      enqueueFence(tab, state, true);
    }, QUIET_FENCE_MS);
  };

  const stateFor = (tab: string, viewerId: string): TabState => {
    const existing = tabs.get(tab);
    if (existing !== undefined && existing.viewerId === viewerId) return existing;
    // Another viewer drives now: what the last one sent is acknowledged as dispatched.
    if (existing !== undefined) retire(tab, existing);
    const state: TabState = {
      viewerId,
      maxIseq: 0,
      maxEdit: 0,
      lastAcked: 0,
      lastFinal: false,
      failed: [],
      unfenced: 0,
      firstUnfencedAt: null,
      fencing: 0,
      composing: false,
      quietTimer: null,
      agent: existing?.agent ?? "unknown",
      agentDoc: existing?.agentDoc,
      generation: 0,
    };
    tabs.set(tab, state);
    return state;
  };

  const retire = (tab: string, state: TabState) => {
    if (state.quietTimer !== null) clearTimer(state.quietTimer);
    state.quietTimer = null;
    state.generation += 1;
    send(tab, state, state.maxIseq, null, true);
    tabs.delete(tab);
  };

  /**
   * Refused input of a viewer without ack state for the tab, or input to a closed tab: one final
   * dispatch ack, soon, for all of it. Nothing is fenced for it.
   */
  const stray = (viewerId: string, tab: string, iseq: number, ok: boolean) => {
    const key = `${viewerId}\n${tab}`;
    let entry = strays.get(key);
    if (entry === undefined) {
      entry = { viewerId, tab, iseq, failed: [], timer: null };
      strays.set(key, entry);
      const pending = entry;
      entry.timer = setTimer(() => {
        strays.delete(key);
        deps.sendTo(pending.viewerId, {
          t: "input-ack",
          tab: pending.tab,
          iseq: pending.iseq,
          mode: "dispatch",
          ...(pending.failed.length > 0 ? { failed: pending.failed.slice(-MAX_ACK_FAILED) } : {}),
          final: true,
        });
      }, QUIET_FENCE_MS);
    }
    if (iseq > entry.iseq) entry.iseq = iseq;
    if (!ok && !entry.failed.includes(iseq)) entry.failed.push(iseq);
  };

  const scheduler: AckScheduler = {
    noteDispatched(viewerId, msg, ok) {
      const iseq = (msg as { iseq?: unknown }).iseq;
      if (!isIseq(iseq)) return;
      const current = tabs.get(msg.tab);
      // Refused input of a viewer that does not drive must not end the driver's acks, and input
      // to a closed tab (dispatched as it closed, or refused) starts nothing for it: each is
      // answered on its own.
      if (
        forgotten.has(msg.tab) ||
        (!ok && current !== undefined && current.viewerId !== viewerId)
      ) {
        stray(viewerId, msg.tab, iseq, ok);
        return;
      }
      const state = stateFor(msg.tab, viewerId);
      // A new connection numbers from 1 again: its viewerId differs, so it has its own state.
      if (iseq > state.maxIseq) state.maxIseq = iseq;
      if (!ok && !state.failed.includes(iseq)) state.failed.push(iseq);
      // Refused after a later input was acknowledged (it was still queued when the tab was
      // reset): the viewer learns of it now, not with some later ack.
      if (!ok && iseq <= state.lastAcked) {
        send(msg.tab, state, state.lastAcked, null, false);
        return;
      }
      // A hover, drag, wheel or scroll: covered by the next ack, never fenced for.
      if (!isAckedInput(msg)) return;
      if (iseq > state.maxEdit) state.maxEdit = iseq;
      state.unfenced += 1;
      state.firstUnfencedAt ??= now();
      if (msg.t === "ime") state.composing = msg.text !== "";
      // A whole-field sync (`value`) may come while the page still composes: only a commit or a
      // key ends it.
      else if (msg.t === "text" || msg.t === "key") state.composing = false;
      if (
        !state.composing &&
        (deps.isIdle(msg.tab) ||
          state.unfenced >= FENCE_AFTER_INPUTS ||
          now() - state.firstUnfencedAt >= FENCE_AFTER_MS)
      )
        enqueueFence(msg.tab, state, false);
      armQuiet(msg.tab, state);
    },

    refuse(viewerId, msg) {
      if (!isIseq((msg as { iseq?: unknown }).iseq)) return;
      deps.enqueue(msg.tab, async () => scheduler.noteDispatched(viewerId, msg, false));
    },

    async beforeDispatch(_viewerId, msg) {
      if (guardMode === "off" || msg.t !== "key" || msg.kind !== "down" || msg.key !== "Enter")
        return true;
      const expect = msg.expect;
      if (expect === undefined || typeof expect !== "object") return true;
      // A password reports no hash: nothing to compare.
      if (expect.hash === "") return true;
      const state = tabs.get(msg.tab);
      if (state !== undefined && agentFor(msg.tab, state) === "legacy") return true;
      const n = fenceNumber(msg.tab);
      fences += 1;
      // One deadline for the page's answer and its place in the stream together.
      const deadline = now() + FENCE_TIMEOUT_MS;
      // Sent now, before Enter: the page reads its field when the command runs.
      const asked = deps.fence(msg.tab, n, true);
      const judged = (async (): Promise<GuardClass | null> => {
        let fence: FenceResult | "timeout" = "timeout";
        try {
          const reply = await withTimeout(asked, FENCE_TIMEOUT_MS);
          if (reply !== "timeout" && reply.ok) {
            const hub = deps.hubFor(msg.tab);
            if (hub !== undefined) fence = await hub.whenFenced(n, Math.max(0, deadline - now()));
          } else if (reply !== "timeout" && reply.err === UNKNOWN_FENCE_ERROR) {
            if (state !== undefined) state.agent = "legacy";
            return null;
          }
        } catch {
          fence = "timeout";
        }
        // Its own password-like report: the page's field has no hash to compare either.
        if (fence !== "timeout" && fence.edit !== null && fence.edit.hash === "") return null;
        return classifySubmit(expect, fence);
      })();
      const record = (kind: GuardClass | null, refused: boolean) => {
        if (kind === null) return;
        guardCounts[kind] += 1;
        deps.onGuard?.(msg.tab, kind, refused);
      };
      // Shadow only counts: Enter goes at once, and the verdict is counted when it comes.
      if (guardMode === "shadow") {
        void judged.then((kind) => record(kind, false)).catch(() => undefined);
        return true;
      }
      const kind = await judged;
      const refused = kind !== null && kind !== "match" && kind !== "rewrite";
      record(kind, refused);
      return !refused;
    },

    reset(tab) {
      const state = tabs.get(tab);
      if (state === undefined) return;
      // What was waiting for a fence is acknowledged as dispatched; nothing more is known, and
      // nothing more comes for it.
      if (state.quietTimer !== null) clearTimer(state.quietTimer);
      state.quietTimer = null;
      state.generation += 1;
      state.unfenced = 0;
      state.firstUnfencedAt = null;
      state.composing = false;
      send(tab, state, state.maxIseq, null, true);
    },

    forget(tab) {
      scheduler.reset(tab);
      tabs.delete(tab);
      nextFence.delete(tab);
      forgotten.add(tab);
      // Closed tabs are only remembered for their stragglers.
      if (forgotten.size > FORGOTTEN_TABS) forgotten.delete(forgotten.values().next().value!);
    },

    guardCounts: () => ({ ...guardCounts }),
    fenceCount: () => fences,
  };
  return scheduler;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
