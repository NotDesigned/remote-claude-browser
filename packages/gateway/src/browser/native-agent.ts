/** CDP-only lifecycle/geometry for native pixel sessions. Never installs code in the MAIN world. */
import { randomBytes } from "node:crypto";
import { EventType, type AgentMsg, type eventWithTime } from "@mirror/protocol";
import type { AgentLink, TargetRef } from "../types";
import type { BrowserHandle } from "./launch";

export function recordingMode(value: string | undefined): "dom" | "native" {
  if (value === undefined || value === "" || value === "dom") return "dom";
  if (value === "native") return "native";
  throw new Error("MIRROR_RECORDING_MODE must be dom or native");
}

class NativeStream implements AsyncIterable<AgentMsg> {
  private values: AgentMsg[] = [];
  private waiters: {
    resolve(value: IteratorResult<AgentMsg>): void;
    reject(error: Error): void;
  }[] = [];
  private ended = false;
  private error?: Error;
  push(value: AgentMsg) {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }
  close() {
    this.ended = true;
    this.values = [];
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }
  fail(error: Error) {
    this.error = error;
    this.ended = true;
    this.values = [];
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
  [Symbol.asyncIterator](): AsyncIterator<AgentMsg> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.error) return Promise.reject(this.error);
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

interface NativeTarget {
  target: TargetRef;
  stream: NativeStream;
  ready: Promise<void>;
  queue: Promise<void>;
  loader?: string;
  docId: number;
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Native geometry timed out")), 2500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createNativeAgentLink(
  browser: BrowserHandle,
  prepare?: (target: TargetRef) => Promise<void>,
): AgentLink {
  const targets = new Map<string, NativeTarget>();
  let reqId = 0;
  const current = (state: NativeTarget) => targets.get(state.target.targetId) === state;
  const snapshot = async (state: NativeTarget) => {
    const [tree, metrics] = (await bounded(
      Promise.all([
        browser.send(state.target.sessionId, "Page.getFrameTree"),
        browser.send(state.target.sessionId, "Page.getLayoutMetrics"),
      ]),
    )) as [
      { frameTree: { frame: { url: string; loaderId?: string } } },
      {
        cssLayoutViewport?: {
          clientWidth: number;
          clientHeight: number;
          pageX: number;
          pageY: number;
        };
        layoutViewport: { clientWidth: number; clientHeight: number; pageX: number; pageY: number };
      },
    ];
    if (!current(state)) return;
    const frame = tree.frameTree.frame;
    const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport;
    if (state.loader !== (frame.loaderId ?? frame.url)) {
      state.loader = frame.loaderId ?? frame.url;
      state.docId = randomBytes(4).readUInt32BE();
      state.stream.push({
        kind: "hello",
        docId: state.docId,
        url: frame.url,
        isTop: true,
        ts: Date.now(),
      });
    }
    const events = [
      {
        type: EventType.Meta,
        timestamp: Date.now(),
        data: { href: frame.url, width: viewport.clientWidth, height: viewport.clientHeight },
      },
      {
        type: EventType.FullSnapshot,
        timestamp: Date.now(),
        data: {
          // A gateway-owned blank control document, not a serialization of the website. Pixel
          // viewers still use the established snapshot epoch to acknowledge viewport changes.
          node: {
            type: 0,
            id: 1,
            childNodes: [
              { type: 1, id: 5, name: "html", publicId: "", systemId: "" },
              {
                type: 2,
                id: 2,
                tagName: "html",
                attributes: {},
                childNodes: [
                  { type: 2, id: 3, tagName: "head", attributes: {}, childNodes: [] },
                  { type: 2, id: 4, tagName: "body", attributes: {}, childNodes: [] },
                ],
              },
            ],
          },
          initialOffset: { left: viewport.pageX, top: viewport.pageY },
        },
      },
    ] as unknown as eventWithTime[];
    for (const e of events) state.stream.push({ kind: "rrweb", docId: state.docId, e });
  };
  const refresh = (state: NativeTarget) => {
    const operation = state.queue.then(async () => {
      await state.ready;
      if (current(state)) await snapshot(state);
    });
    state.queue = operation.catch(() => undefined);
    return operation;
  };
  browser.onSessionEvent("Page.frameNavigated", (sessionId, event) => {
    if (event.frame.parentId !== undefined) return;
    const state = [...targets.values()].find((s) => s.target.sessionId === sessionId);
    if (state) void refresh(state).catch(() => undefined);
  });
  browser.onAttached((target) => {
    if (target.type !== "page") {
      void browser.send(target.sessionId, "Runtime.runIfWaitingForDebugger").catch(() => undefined);
      return;
    }
    const previous = targets.get(target.targetId);
    if (previous?.target.sessionId === target.sessionId) return;
    previous?.stream.close();
    const state: NativeTarget = {
      target,
      stream: new NativeStream(),
      ready: Promise.resolve(),
      queue: Promise.resolve(),
      docId: 0,
    };
    targets.set(target.targetId, state);
    state.ready = (async () => {
      const enabled = browser.send(target.sessionId, "Page.enable");
      void enabled.catch(() => undefined);
      await prepare?.(target);
      await bounded(
        Promise.all([enabled, browser.send(target.sessionId, "Runtime.runIfWaitingForDebugger")]),
      );
      if (current(state)) await snapshot(state);
    })();
    void state.ready.catch((cause: unknown) => {
      if (current(state)) {
        state.stream.fail(
          cause instanceof Error ? cause : new Error("Native page initialization failed"),
        );
      }
      void browser.send(target.sessionId, "Runtime.runIfWaitingForDebugger").catch(() => undefined);
    });
  });
  browser.onDetached((target) => {
    const state = targets.get(target.targetId);
    if (state?.target.sessionId !== target.sessionId) return;
    targets.delete(target.targetId);
    state.stream.close();
  });
  return {
    msgs(targetId) {
      const state = targets.get(targetId);
      if (state) return state.stream;
      const closed = new NativeStream();
      closed.close();
      return closed;
    },
    async sendCmd(targetId, command) {
      const id = ++reqId;
      const state = targets.get(targetId);
      if (!state) throw new Error("Native target detached");
      if (command.cmd === "snapshot") {
        await refresh(state);
        return { reqId: id, ok: true };
      }
      if (command.cmd === "ping") {
        await state.ready;
        await bounded(browser.send(state.target.sessionId, "Page.getLayoutMetrics"));
        return { reqId: id, ok: true };
      }
      if (command.cmd === "scroll" && command.nodeId === 0) {
        const metrics = (await bounded(
          browser.send(state.target.sessionId, "Page.getLayoutMetrics"),
        )) as {
          cssLayoutViewport: { pageX: number; pageY: number };
        };
        await browser.send(state.target.sessionId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: 10,
          y: 10,
          deltaX: command.x - metrics.cssLayoutViewport.pageX,
          deltaY: command.y - metrics.cssLayoutViewport.pageY,
        });
        return { reqId: id, ok: true };
      }
      return { reqId: id, ok: false, err: "DOM commands are unavailable in native pixel mode" };
    },
  };
}
