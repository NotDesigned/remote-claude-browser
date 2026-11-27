/**
 * Agent stream and command channel.
 *
 * Implements the AgentLink boundary contract (../types.ts — FROZEN): per-target
 * AsyncIterable<AgentMsg> with stale-docId filtering, chunk reassembly/dedup keyed directly on
 * the M2 `(docId, msgId)` frame fields, and sendCmd with 3s timeout + reject-on-navigation
 * (pending cmd promises must reject when docId changes, not hang).
 */
import {
  ChunkReassembler,
  parseChunk,
  type AgentCmd,
  type AgentCmdInput,
  type AgentMsg,
  type CmdRes,
  type Down,
} from "@mirror/protocol";

import type { AgentLink, TargetRef } from "../types";
import { acquireAgentBridge, agentBridgeChannel, callAgentBridge, callFrameAgent } from "./bridge";
import { injectAgent } from "./inject";
import type { BrowserHandle } from "./launch";

const COMMAND_TIMEOUT_MS = 3_000;

type ClipboardDown = Extract<Down, { t: "clip" }>;

interface ClipboardAgentMsg {
  kind: "clip";
  docId: number;
  text: string;
}

/** Voice from the agent: a frame of what the page plays, or its microphone going on or off. */
export type VoiceAgentMsg = { audio: string } | { mic: boolean };

export interface AgentLinkOptions {
  publishVoice?: (message: VoiceAgentMsg, targetId: string) => void;
  /**
   * A website-notification message from the page's current document (NotifyAgentOut, not yet
   * validated: the relay checks every field).
   */
  publishNotify?: (message: object, targetId: string) => void;
  /** Relays private agent clipboard messages onto the frozen viewer Down lane. */
  publishClipboard?: (message: ClipboardDown, targetId: string) => void;
  /**
   * Runs on a new target while it is still paused, before its first document can load. It resolves
   * once its commands are sent: a paused target may not answer them until it has been resumed.
   */
  prepareTarget?: (target: TargetRef) => Promise<void>;
}

interface Waiter<T> {
  resolve(result: IteratorResult<T>): void;
  reject(error: unknown): void;
}

class AsyncMessageQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly queued: T[] = [];
  private readonly waiters: Waiter<T>[] = [];
  private ended = false;
  private failure: unknown;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.queued.push(value);
    else waiter.resolve({ done: false, value });
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.queued.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

interface PendingCommand {
  /** The document it was sent to. A command sent to a frame by id is answered by that frame. */
  docId: number | undefined;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: CmdRes): void;
  reject(error: Error): void;
}

interface TargetState {
  target: TargetRef;
  stream: AsyncMessageQueue<AgentMsg>;
  docId?: number;
  seenDocIds: Set<number>;
  nextReqId: number;
  pending: Map<number, PendingCommand>;
  reassembler: ChunkReassembler;
  /** Per document, the next message number its agent will send; insertion-ordered for pruning. */
  nextMsgIds: Map<number, number>;
  cleanedDocuments: Set<string>;
  bridgeReady?: Promise<void>;
}

function navigationError(targetId: string): Error {
  return new Error(`Agent command rejected: target ${targetId} navigated`);
}

function detachedError(targetId: string): Error {
  return new Error(`Agent target ${targetId} detached`);
}

function rejectPending(state: TargetState, error: Error): void {
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  state.pending.clear();
}

function closeState(state: TargetState, error?: Error): void {
  rejectPending(state, error ?? detachedError(state.target.targetId));
  if (error === undefined) state.stream.close();
  else state.stream.fail(error);
}

function asClipboardAgentMsg(msg: AgentMsg): ClipboardAgentMsg | null {
  const value = msg as unknown as Partial<ClipboardAgentMsg>;
  return value.kind === "clip" && typeof value.docId === "number" && typeof value.text === "string"
    ? (value as ClipboardAgentMsg)
    : null;
}

function asVoiceAgentMsg(msg: AgentMsg): VoiceAgentMsg | null {
  const value = msg as unknown as { kind?: unknown; audio?: unknown; mic?: unknown };
  if (value.kind !== "voice") return null;
  if (typeof value.audio === "string") return { audio: value.audio };
  return typeof value.mic === "boolean" ? { mic: value.mic } : null;
}

/** Documents per target whose message numbering is followed (same-process frames each have one). */
export const MAX_TRACKED_DOCUMENTS = 64;
/**
 * Documents (and execution contexts) per target remembered as seen. A long-lived tab goes through
 * one per navigation; only recent ones can still send a delayed hello.
 */
export const MAX_SEEN_DOCUMENTS = 256;

/** Adds value as the newest member, dropping the oldest past `max` (but never `keep`). */
export function remember<T>(set: Set<T>, value: T, max: number, keep?: T): void {
  set.delete(value);
  set.add(value);
  for (const oldest of set) {
    if (set.size <= max) break;
    if (oldest !== keep && oldest !== value) set.delete(oldest);
  }
}

export function createAgentLink(browser: BrowserHandle, options: AgentLinkOptions = {}): AgentLink {
  const statesByTarget = new Map<string, TargetState>();
  const statesBySession = new Map<string, TargetState>();
  const lossListeners = new Set<(targetId: string) => void>();

  /** Only the canonical document's stream feeds the hub; losses elsewhere change nothing. */
  const lost = (state: TargetState, docId: number) => {
    if (state.docId !== docId || statesByTarget.get(state.target.targetId) !== state) return;
    for (const listener of lossListeners) {
      try {
        listener(state.target.targetId);
      } catch {
        // One listener's failure must not keep the others from recovering.
      }
    }
  };

  /**
   * The agent numbers its document's messages 0, 1, 2… and sends each one's chunks in order, so
   * a completed message past the next expected number means those in between were lost.
   */
  const noteMessage = (state: TargetState, docId: number, msgId: number) => {
    const expected = state.nextMsgIds.get(docId);
    if (expected === undefined) {
      state.nextMsgIds.set(docId, msgId + 1);
      // The oldest goes first, but never the page's current document: losing its numbering would
      // hide the next lost message on the stream that matters.
      for (const oldest of state.nextMsgIds.keys()) {
        if (state.nextMsgIds.size <= MAX_TRACKED_DOCUMENTS) break;
        if (oldest !== state.docId && oldest !== docId) state.nextMsgIds.delete(oldest);
      }
      return;
    }
    if (msgId < expected) return;
    state.nextMsgIds.set(docId, msgId + 1);
    if (msgId > expected) lost(state, docId);
  };

  browser.onSessionEvent("Runtime.bindingCalled", (sessionId, event) => {
    if (event.name !== agentBridgeChannel(browser, sessionId)?.bindingName) return;
    const state = statesBySession.get(sessionId);
    if (state === undefined) return;

    const chunk = parseChunk(event.payload);
    if (chunk === null) return;

    let msg: AgentMsg | null;
    try {
      msg = state.reassembler.add(event.payload);
    } catch {
      // Malformed JSON is a lost message too.
      noteMessage(state, chunk.docId, chunk.msgId);
      lost(state, chunk.docId);
      return;
    }
    if (msg === null) return;
    // Numbering follows completed messages only: chunks of one message arrive back to back.
    noteMessage(state, chunk.docId, chunk.msgId);

    const clipboard = asClipboardAgentMsg(msg);
    if (clipboard !== null) {
      if (
        clipboard.docId !== chunk.docId ||
        state.docId === undefined ||
        clipboard.docId !== state.docId
      )
        return;
      options.publishClipboard?.({ t: "clip", text: clipboard.text }, state.target.targetId);
      return;
    }

    const voice = asVoiceAgentMsg(msg);
    if (voice !== null) {
      if (chunk.docId === state.docId) options.publishVoice?.(voice, state.target.targetId);
      return;
    }

    if ((msg as unknown as { kind?: unknown }).kind === "notify") {
      // Only the page's own top document: a same-process frame's agent has no notifications.
      if (chunk.docId === state.docId && state.target.type === "page") {
        const {
          kind: _kind,
          docId: _docId,
          ...message
        } = msg as unknown as Record<string, unknown>;
        // Its answers go through the document's bridge, which its hello has only begun to
        // acquire; in order, since every message waits on the same promise.
        const docId = chunk.docId;
        void (state.bridgeReady ?? Promise.resolve()).then(
          () => {
            if (state.docId === docId) options.publishNotify?.(message, state.target.targetId);
          },
          () => undefined,
        );
      }
      return;
    }

    if (msg.kind === "hello") {
      if (msg.docId !== chunk.docId) return;
      const ignoredAboutBlank = state.target.type === "iframe" && msg.url === "about:blank";
      const ignoredSameProcessChild = state.target.type === "page" && !msg.isTop;
      const canonical = !ignoredAboutBlank && !ignoredSameProcessChild;
      // Chromium may reuse a numeric executionContextId after navigation. Pair it with the agent's
      // document epoch so every replacement bridge is acquired exactly once.
      const cleanupKey = `${event.executionContextId}:${msg.docId}`;
      if (!state.cleanedDocuments.has(cleanupKey)) {
        remember(state.cleanedDocuments, cleanupKey, MAX_SEEN_DOCUMENTS);
        const acquired = acquireAgentBridge(
          browser,
          state.target.sessionId,
          event.executionContextId,
          canonical,
        ).then(() => undefined);
        if (canonical) {
          state.bridgeReady = acquired;
          // A hard navigation can destroy this context after hello has opened the stream but before
          // the CDP acquisition response returns. Preserve the stream; the replacement hello installs
          // a new bridgeReady promise. Commands in the disappearing epoch still observe the failure.
          void acquired.catch(() => undefined);
        } else {
          void acquired.catch(() => undefined);
        }
      }
      // OOPIF targets never legitimately host about:blank. A delayed child-frame hello can
      // otherwise replace the real-origin document epoch and reject its command channel.
      if (ignoredAboutBlank) return;
      // addScriptToEvaluateOnNewDocument also runs in same-process child frames. Their hello
      // must not reset the canonical page epoch; OOPIF targets retain their diagnostic hello.
      if (ignoredSameProcessChild) return;
      // Once a newer canonical hello has been accepted, a delayed duplicate hello from an older
      // document must not roll the target back to that stale epoch.
      if (state.docId !== msg.docId && state.seenDocIds.has(msg.docId)) return;
      const navigated = state.docId !== undefined && state.docId !== msg.docId;
      if (navigated) rejectPending(state, navigationError(state.target.targetId));
      if (!navigated && state.docId === msg.docId) return;
      state.docId = msg.docId;
      remember(state.seenDocIds, msg.docId, MAX_SEEN_DOCUMENTS);
      state.stream.push(msg);
      return;
    }

    // A fence answers for the input before it, so it keeps its place among the recorder's events
    // instead of resolving a command the moment it arrives.
    if (msg.kind === "rrweb" || msg.kind === "fence") {
      if (msg.docId !== chunk.docId || state.docId === undefined || msg.docId !== state.docId)
        return;
      state.stream.push(msg);
      return;
    }

    const pending = state.pending.get(msg.reqId);
    if (pending === undefined) return;
    if (
      pending.docId !== undefined &&
      (chunk.docId !== state.docId || pending.docId !== state.docId)
    )
      return;
    state.pending.delete(msg.reqId);
    clearTimeout(pending.timer);
    pending.resolve({
      reqId: msg.reqId,
      ok: msg.ok,
      ...(msg.data === undefined ? {} : { data: msg.data }),
      ...(msg.err === undefined ? {} : { err: msg.err }),
    });
  });

  browser.onDetached((target) => {
    const state = statesByTarget.get(target.targetId);
    if (state?.target.sessionId !== target.sessionId) return;
    statesByTarget.delete(target.targetId);
    statesBySession.delete(target.sessionId);
    closeState(state);
  });

  browser.onAttached((target) => {
    const replaced = statesByTarget.get(target.targetId);
    if (replaced !== undefined && replaced.target.sessionId !== target.sessionId) {
      statesBySession.delete(replaced.target.sessionId);
      closeState(replaced);
    }

    if (statesBySession.has(target.sessionId)) return;
    const state: TargetState = {
      target,
      stream: new AsyncMessageQueue(),
      seenDocIds: new Set(),
      nextReqId: 1,
      pending: new Map(),
      // A message given up as incomplete is lost from its document's stream.
      reassembler: new ChunkReassembler((docId) => lost(state, docId)),
      nextMsgIds: new Map(),
      cleanedDocuments: new Set(),
    };
    statesByTarget.set(target.targetId, state);
    statesBySession.set(target.sessionId, state);

    void injectAgent(browser, target, options.prepareTarget).catch(async (cause: unknown) => {
      // Do not leave Chromium paused if an attach step fails. The failed stream makes the
      // injection error observable to its consumer.
      await browser
        .send(target.sessionId, "Runtime.runIfWaitingForDebugger")
        .catch(() => undefined);
      if (statesBySession.get(target.sessionId) !== state) return;
      statesByTarget.delete(target.targetId);
      statesBySession.delete(target.sessionId);
      closeState(
        state,
        new Error(`Agent injection failed for target ${target.targetId}`, { cause }),
      );
    });
  });

  return {
    onStreamLoss(listener) {
      lossListeners.add(listener);
      return () => lossListeners.delete(listener);
    },
    msgs(targetId) {
      const state = statesByTarget.get(targetId);
      if (state !== undefined) return state.stream;
      const ended = new AsyncMessageQueue<AgentMsg>();
      ended.close();
      return ended;
    },
    async sendCmd(targetId: string, input: AgentCmdInput, frameId?: string): Promise<CmdRes> {
      const state = statesByTarget.get(targetId);
      if (state === undefined) return Promise.reject(detachedError(targetId));
      if (frameId === undefined) {
        if (state.docId === undefined) {
          return Promise.reject(new Error(`Agent target ${targetId} has not announced a document`));
        }
        await state.bridgeReady;
        if (statesByTarget.get(targetId) !== state) throw detachedError(targetId);
      }

      const reqId = state.nextReqId++;
      const cmd = { ...input, reqId } as AgentCmd;
      return new Promise<CmdRes>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!state.pending.delete(reqId)) return;
          reject(new Error(`Agent command ${reqId} timed out after ${COMMAND_TIMEOUT_MS}ms`));
        }, COMMAND_TIMEOUT_MS);
        state.pending.set(reqId, {
          docId: frameId === undefined ? state.docId! : undefined,
          timer,
          resolve,
          reject,
        });

        void (
          frameId === undefined
            ? callAgentBridge(browser, state.target.sessionId, "command", [cmd])
            : callFrameAgent(browser, state.target.sessionId, frameId, "command", [cmd])
        ).catch((cause: unknown) => {
          const pending = state.pending.get(reqId);
          if (pending === undefined) return;
          state.pending.delete(reqId);
          clearTimeout(pending.timer);
          pending.reject(new Error(`Agent command ${reqId} could not be evaluated`, { cause }));
        });
      });
    },
  };
}
