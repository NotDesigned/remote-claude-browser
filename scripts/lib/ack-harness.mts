// Input acks for the in-process gateways of the input smokes: the scheduler the gateway runs
// (packages/gateway/src/input/acks.ts) wired to a smoke's own TabHub and input relay, plus what
// the smokes check about it.
import {
  EventType,
  IncrementalSource,
  editHash,
  type AgentCmdInput,
  type CmdRes,
  type Down,
  type InputAckMsg,
} from "../../packages/protocol/src/index";
import { deflateRawSync } from "node:zlib";
import {
  ackCaps,
  createAckScheduler,
  parseAckMode,
  type AckScheduler,
  type GuardClass,
  type InputAcksMode,
} from "../../packages/gateway/src/input/acks";
import type { TabHub } from "../../packages/gateway/src/hub/tabhub";
import type { InputMsg, InputRelayDeps } from "../../packages/gateway/src/input/relay";

/** MIRROR_INPUT_ACKS for a smoke: "on" unless set. */
export function smokeAckMode(env: Record<string, string | undefined> = process.env): InputAcksMode {
  return parseAckMode("MIRROR_INPUT_ACKS", env.MIRROR_INPUT_ACKS, "on");
}

export interface AckHarness {
  mode: InputAcksMode;
  caps: string[];
  /** Spread into createInputRelay's deps. */
  relayDeps: Pick<InputRelayDeps, "onDispatched" | "beforeDispatch" | "onReset" | "onForget">;
  /** Once the relay exists. */
  attach(relay: { enqueue(tab: string, task: () => Promise<void>): void }): void;
  /** Where acks for a viewer go (its connection, through the slow link). */
  route(viewerId: string, send: ((down: Down) => void) | null): void;
  /** Feed every Down the hub produced, to know which stream position carried which text. */
  observe(downs: readonly Down[]): void;
  /**
   * Acks sent, with their size as JSON and alone in a fresh permessage-deflate context (the
   * measure of the protocol's 160-byte budget).
   */
  sent: Array<{ viewerId: string; ack: InputAckMsg; bytes: number; deflated: number }>;
  guard: Record<GuardClass, number>;
  fenceTimes: number[];
  /** Each final ack: how long after its last input was dispatched the gateway sent it. */
  finalLags: number[];
  /** Final page acks whose field is a value control: was its last value at or before ack.seq? */
  ordering: { inOrder: number; outOfOrder: number };
  /**
   * Final page acks whose field is a rich editor (no rrweb Input events): with the page's text
   * read right after the ack still hashing as the ack says, did a text mutation at or before
   * ack.seq already carry the end of its last line?
   */
  richOrdering: { inOrder: number; outOfOrder: number };
  /** Final page acks: does edit.hash hash the page's own text (read right after the ack)? */
  pageHash: { match: number; mismatch: number };
  /** Reads of the page's text still on their way. */
  settle(): Promise<void>;
  scheduler(): AckScheduler | undefined;
}

export function createAckHarness(options: {
  mode?: InputAcksMode;
  hub: () => TabHub;
  sendCmd(tab: string, command: AgentCmdInput): Promise<CmdRes>;
  /** The page's focused field's own text, or null when none (for pageHash). */
  pageText?: () => Promise<string | null>;
}): AckHarness {
  const reads = new Set<Promise<void>>();
  const mode = options.mode ?? smokeAckMode();
  let scheduler: AckScheduler | undefined;
  const routes = new Map<string, (down: Down) => void>();
  /** When the relay dispatched each iseq (one viewer per run). */
  const dispatchedAt = new Map<number, number>();
  /** The last value of each value control, by stream position. */
  const values = new Map<number, Array<{ seq: number; text: string }>>();
  /** The text of each text node the page changed or added, by stream position. */
  const texts = new Map<number, Array<{ seq: number; text: string }>>();
  const noteText = (id: number, seq: number, text: string) => {
    const history = texts.get(id) ?? [];
    history.push({ seq, text: text.replace(/\u00a0/g, " ") });
    texts.set(id, history.slice(-64));
  };
  const addedTexts = (node: any, seq: number) => {
    if (node === null || typeof node !== "object") return;
    if (node.type === 3 && typeof node.id === "number")
      noteText(node.id, seq, node.textContent ?? "");
    for (const child of node.childNodes ?? []) addedTexts(child, seq);
  };
  /**
   * Whether text nodes at stream position `seq` already held the end of `line` — either in one
   * text node or split across an inline mark boundary (e.g. `<strong>bold</strong>` + `" "`/`" t"`).
   */
  const carried = (line: string, seq: number) => {
    const tail = line.replace(/\u00a0/g, " ").slice(-3);
    const atSeq: string[] = [];
    for (const history of texts.values()) {
      const last = history.filter((entry) => entry.seq <= seq).at(-1);
      if (last !== undefined) {
        if (last.text.endsWith(tail)) return true;
        atSeq.push(last.text);
      }
    }
    for (let i = 0; i < atSeq.length; i++) {
      const b = atSeq[i]!;
      if (b.length === 0 || b.length >= tail.length || !tail.endsWith(b)) continue;
      const prefix = tail.slice(0, tail.length - b.length);
      for (let j = 0; j < atSeq.length; j++) {
        if (i !== j && atSeq[j]!.endsWith(prefix)) return true;
      }
    }
    return false;
  };
  const harness: AckHarness = {
    mode,
    caps: ackCaps(mode),
    relayDeps:
      mode === "off"
        ? {}
        : {
            onDispatched: (viewerId: string, message: InputMsg, ok: boolean) => {
              const iseq = (message as { iseq?: number }).iseq;
              if (iseq !== undefined) dispatchedAt.set(iseq, performance.now());
              scheduler?.noteDispatched(viewerId, message, ok);
            },
            beforeDispatch: async (viewerId: string, message: InputMsg) =>
              (await scheduler?.beforeDispatch(viewerId, message)) ?? true,
            onReset: (tab: string) => scheduler?.reset(tab),
            onForget: (tab: string) => scheduler?.forget(tab),
          },
    attach(relay) {
      if (mode === "off") return;
      scheduler = createAckScheduler({
        fence: (tab, n, text) =>
          options.sendCmd(tab, { cmd: "fence", n, ...(text === true ? { text: true } : {}) }),
        hubFor: () => options.hub(),
        sendTo(viewerId, ack) {
          const json = JSON.stringify(ack);
          harness.sent.push({
            viewerId,
            ack,
            bytes: Buffer.byteLength(json),
            deflated: deflateRawSync(json).length,
          });
          // A password reports no hash: there is nothing to compare.
          if (
            ack.mode === "page" &&
            ack.final &&
            ack.edit &&
            ack.edit.hash !== "" &&
            ack.seq !== undefined
          ) {
            const history = values.get(ack.edit.node);
            if (history !== undefined) {
              const last = history.filter((entry) => entry.seq <= ack.seq!).at(-1);
              if (last !== undefined && editHash(last.text) === ack.edit.hash)
                harness.ordering.inOrder += 1;
              else harness.ordering.outOfOrder += 1;
            }
          }
          const edit = ack.mode === "page" && ack.final ? ack.edit : undefined;
          if (edit && edit.hash !== "" && options.pageText !== undefined) {
            const rich = !values.has(edit.node);
            const read = options
              .pageText()
              .then((text) => {
                if (text === null) return;
                if (editHash(text) !== edit.hash) {
                  harness.pageHash.mismatch += 1;
                  return;
                }
                harness.pageHash.match += 1;
                const line = text.split("\n").at(-1) ?? "";
                if (!rich || line.trim() === "" || ack.seq === undefined) return;
                if (carried(line, ack.seq)) harness.richOrdering.inOrder += 1;
                else harness.richOrdering.outOfOrder += 1;
              })
              .catch(() => undefined)
              .finally(() => reads.delete(read));
            reads.add(read);
          }
          const at = dispatchedAt.get(ack.iseq);
          if (ack.final && at !== undefined) harness.finalLags.push(performance.now() - at);
          routes.get(viewerId)?.(ack);
        },
        enqueue: relay.enqueue,
        guard: "shadow",
        onGuard: (_tab, kind) => {
          harness.guard[kind] += 1;
        },
        onFenceTime: (ms) => harness.fenceTimes.push(ms),
      });
    },
    route(viewerId, send) {
      if (send === null) routes.delete(viewerId);
      else routes.set(viewerId, send);
    },
    observe(downs) {
      for (const down of downs) {
        if (down.t !== "delta") continue;
        down.data.forEach((event, index) => {
          if (event.type !== EventType.IncrementalSnapshot) return;
          if (event.data.source === IncrementalSource.Mutation) {
            for (const change of event.data.texts)
              noteText(change.id, down.seq + index, change.value ?? "");
            for (const add of event.data.adds) addedTexts(add.node, down.seq + index);
            return;
          }
          if (event.data.source !== IncrementalSource.Input) return;
          const history = values.get(event.data.id) ?? [];
          history.push({ seq: down.seq + index, text: event.data.text });
          values.set(event.data.id, history.slice(-64));
        });
      }
    },
    sent: [],
    guard: { match: 0, rewrite: 0, stale: 0, focus: 0, timeout: 0 },
    fenceTimes: [],
    finalLags: [],
    ordering: { inOrder: 0, outOfOrder: 0 },
    richOrdering: { inOrder: 0, outOfOrder: 0 },
    pageHash: { match: 0, mismatch: 0 },
    settle: async () => {
      await Promise.all([...reads]);
    },
    scheduler: () => scheduler,
  };
  return harness;
}

export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/** What a viewer's inputlab recorded (window.__mirrorInputLab, read in the page). */
export interface LabReport {
  caps: { acks: boolean; echo: boolean };
  stamped: number;
  acks: InputAckMsg[];
  settled: Array<{
    iseq: number;
    mode: "page" | "dispatch";
    final: boolean;
    failed: number[];
    edit?: { node: number; hash: string } | null;
    localHash?: string;
    rtt?: number;
  }>;
  /** Each typing echo window as it closed: how long after its last key, and by what. */
  windows: Array<{ ms: number; how: "ack" | "liveness" | "decay" }>;
  stats: {
    hashMatchAtFinal: number;
    hashMismatchAtFinal: number;
    decayWhileOutstanding: number;
    dispatchOnlyAcks: number;
    ackRttP50: number | null;
    ackRttP95: number | null;
  };
}

/** Reads a viewer page's inputlab for a tab. */
export const readLabScript = (tab: string): LabReport => {
  const lab = (window as unknown as { __mirrorInputLab?: any }).__mirrorInputLab;
  if (lab === undefined) throw new Error("no inputlab: open the viewer with ?inputlab=1");
  return {
    caps: lab.caps(),
    stamped: lab.lastStamped(tab),
    acks: lab.acks.filter((ack: InputAckMsg) => ack.tab === tab),
    settled: lab.settled.filter((settled: { tab: string }) => settled.tab === tab),
    windows: lab.windows.filter((closed: { tab: string | null }) => closed.tab === tab),
    stats: lab.stats(),
  };
};

/**
 * Every stamped input covered by exactly one cumulative ack, in order, with no gap: acks never go
 * back, the same iseq comes again only as its final ack, and the last covers the last input.
 * Returns what is wrong, or [] when nothing is.
 */
export function coverageProblems(report: LabReport): string[] {
  const problems: string[] = [];
  let previous = 0;
  let previousFinal = false;
  for (const ack of report.acks) {
    if (ack.iseq < previous) problems.push(`ack ${ack.iseq} after ${previous}`);
    if (ack.iseq === previous && (ack.final !== true || previousFinal))
      problems.push(`ack ${ack.iseq} twice`);
    if ((ack.failed ?? []).length > 0) problems.push(`ack ${ack.iseq} failed ${ack.failed}`);
    previous = ack.iseq;
    previousFinal = ack.final === true;
  }
  if (previous !== report.stamped)
    problems.push(`last ack ${previous}, but ${report.stamped} inputs were sent`);
  return problems;
}
