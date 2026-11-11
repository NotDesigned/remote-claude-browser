// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIRROR_NODE_FN_NAME, NODE_IN_FRAME_ERROR, type AgentMsg } from "@mirror/protocol";
import {
  createCommandHandler,
  createRecordReadiness,
  installMirrorNodeHelper,
  type CrossOriginIframeMirror,
  type NodeMirror,
  type RecordReadiness,
} from "./commands";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function iframeNode(): HTMLIFrameElement {
  return {
    nodeType: 1,
    nodeName: "IFRAME",
    isConnected: true,
  } as unknown as HTMLIFrameElement;
}

function harness(
  nodes: Map<number, Node>,
  crossOriginIframeMirror: CrossOriginIframeMirror | null,
) {
  const messages: AgentMsg[] = [];
  const nodeMirror: NodeMirror = {
    getIds: () => [...nodes.keys()],
    getNode: (nodeId) => nodes.get(nodeId) ?? null,
  };
  const handler = createCommandHandler(
    { emit: (message) => messages.push(message) },
    { getNodeMirror: () => nodeMirror, getCrossOriginIframeMirror: () => crossOriginIframeMirror },
  );
  return { handler, messages };
}

describe("resolve command", () => {
  it("returns local when the node is in this recorder mirror", () => {
    const local = { isConnected: true } as Node;
    const { handler, messages } = harness(new Map([[21, local]]), null);

    handler({ cmd: "resolve", reqId: 1, nodeId: 21 });

    expect(messages).toEqual([{ kind: "cmdres", reqId: 1, ok: true, data: { kind: "local" } }]);
  });

  it("returns the hosting iframe id and child-local remote id", () => {
    const iframe = iframeNode();
    const remoteMaps = new WeakMap<HTMLIFrameElement, Map<number, number>>([
      [iframe, new Map([[901, 37]])],
    ]);
    const crossOriginIframeMirror: CrossOriginIframeMirror = {
      iframeRemoteIdToIdMap: remoteMaps,
      getRemoteId: (candidate, nodeId) => remoteMaps.get(candidate)?.get(nodeId) ?? -1,
    };
    const { handler, messages } = harness(new Map([[44, iframe]]), crossOriginIframeMirror);

    handler({ cmd: "resolve", reqId: 2, nodeId: 901 });

    expect(messages).toEqual([
      {
        kind: "cmdres",
        reqId: 2,
        ok: true,
        data: { kind: "remote", iframeNodeId: 44, remoteId: 37 },
      },
    ]);
  });

  it("returns ok:false when no local or child mapping exists", () => {
    const iframe = iframeNode();
    const crossOriginIframeMirror: CrossOriginIframeMirror = {
      iframeRemoteIdToIdMap: new WeakMap([[iframe, new Map()]]),
      getRemoteId: () => -1,
    };
    const { handler, messages } = harness(new Map([[44, iframe]]), crossOriginIframeMirror);

    expect(() => handler({ cmd: "resolve", reqId: 3, nodeId: 999 })).not.toThrow();
    expect(messages).toEqual([{ kind: "cmdres", reqId: 3, ok: false, err: "node not found" }]);
  });
});

describe("a node this document does not have", () => {
  it("says when another frame has it, so the gateway resolves it through the frames", () => {
    vi.stubGlobal("Node", { ELEMENT_NODE: 1 });
    const iframe = iframeNode();
    const remoteMaps = new WeakMap<HTMLIFrameElement, Map<number, number>>([
      [iframe, new Map([[901, 37]])],
    ]);
    const crossOriginIframeMirror: CrossOriginIframeMirror = {
      iframeRemoteIdToIdMap: remoteMaps,
      getRemoteId: (candidate, nodeId) => remoteMaps.get(candidate)?.get(nodeId) ?? -1,
    };
    const { handler, messages } = harness(new Map([[44, iframe]]), crossOriginIframeMirror);

    handler({ cmd: "rect", reqId: 1, nodeId: 901 });
    handler({ cmd: "scroll", reqId: 2, nodeId: 901, x: 0, y: 10 });
    handler({ cmd: "rect", reqId: 3, nodeId: 999 });

    expect(messages).toEqual([
      { kind: "cmdres", reqId: 1, ok: false, err: NODE_IN_FRAME_ERROR },
      { kind: "cmdres", reqId: 2, ok: false, err: NODE_IN_FRAME_ERROR },
      { kind: "cmdres", reqId: 3, ok: false, err: "node not found" },
    ]);
  });
});

describe("scroll command", () => {
  class FakeWheelEvent {
    constructor(
      readonly type: string,
      readonly init: { deltaY: number; bubbles: boolean; cancelable: boolean },
    ) {}
  }

  function scroller(scrollTop: number) {
    const calls: unknown[] = [];
    return {
      calls,
      node: {
        nodeType: 1,
        isConnected: true,
        scrollTop,
        dispatchEvent: (event: FakeWheelEvent) => calls.push(["wheel", event.init.deltaY]),
        scrollTo: (x: number, y: number) => calls.push(["scrollTo", x, y]),
      } as unknown as Element & Node,
    };
  }

  function stubDom() {
    vi.stubGlobal("Node", { ELEMENT_NODE: 1 });
    vi.stubGlobal("WheelEvent", FakeWheelEvent);
  }

  it("tells the page a person is scrolling up before moving, so it does not put the scroll back", () => {
    stubDom();
    const { node, calls } = scroller(1_000);
    const { handler, messages } = harness(new Map([[7, node]]), null);

    handler({ cmd: "scroll", reqId: 1, nodeId: 7, x: 0, y: 400 });

    expect(calls).toEqual([
      ["wheel", -600],
      ["scrollTo", 0, 400],
    ]);
    expect(messages).toEqual([{ kind: "cmdres", reqId: 1, ok: true }]);
  });

  it("sends no wheel for a scroll down, no movement, or the mirror's rounding", () => {
    stubDom();
    const { node, calls } = scroller(1_000);
    const { handler } = harness(new Map([[7, node]]), null);

    handler({ cmd: "scroll", reqId: 1, nodeId: 7, x: 0, y: 1_400 });
    handler({ cmd: "scroll", reqId: 2, nodeId: 7, x: 0, y: 1_000 });
    handler({ cmd: "scroll", reqId: 3, nodeId: 7, x: 0, y: 998 });

    expect(calls).toEqual([
      ["scrollTo", 0, 1_400],
      ["scrollTo", 0, 1_000],
      ["scrollTo", 0, 998],
    ]);
  });

  it("does the same for the page's own scroller", () => {
    stubDom();
    const { node, calls } = scroller(500);
    const scrollTo = vi.fn();
    vi.stubGlobal("document", { scrollingElement: node });
    vi.stubGlobal("window", { scrollTo });
    const { handler } = harness(new Map(), null);

    handler({ cmd: "scroll", reqId: 1, nodeId: 0, x: 0, y: 100 });

    expect(calls).toEqual([["wheel", -400]]);
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 100);
  });
});

describe("snapshot command readiness", () => {
  it("waits for recording to start, whose own snapshot answers the request", async () => {
    const messages: AgentMsg[] = [];
    const readiness = createRecordReadiness();
    const takeFullSnapshot = vi.fn();
    const handler = createCommandHandler(
      { emit: (message) => messages.push(message) },
      {
        getNodeMirror: () => ({ getIds: () => [], getNode: () => null }),
        recordReadiness: readiness,
        takeFullSnapshot,
      },
    );

    handler({ cmd: "snapshot", reqId: 10 });
    expect(takeFullSnapshot).not.toHaveBeenCalled();
    expect(messages).toEqual([]);

    readiness.markStarted();
    await Promise.resolve();

    expect(takeFullSnapshot).not.toHaveBeenCalled();
    expect(messages).toEqual([{ kind: "cmdres", reqId: 10, ok: true }]);
  });

  it("returns a clean retryable failure when recording never starts", async () => {
    vi.useFakeTimers();
    const messages: AgentMsg[] = [];
    const readiness = createRecordReadiness();
    const takeFullSnapshot = vi.fn();
    const handler = createCommandHandler(
      { emit: (message) => messages.push(message) },
      {
        getNodeMirror: () => ({ getIds: () => [], getNode: () => null }),
        recordReadiness: readiness,
        snapshotReadyTimeoutMs: 2_000,
        takeFullSnapshot,
      },
    );

    handler({ cmd: "snapshot", reqId: 11 });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(takeFullSnapshot).not.toHaveBeenCalled();
    expect(messages).toEqual([
      { kind: "cmdres", reqId: 11, ok: false, err: "recorder not ready; retry snapshot" },
    ]);
  });

  it("takes the snapshot synchronously once recording has started", () => {
    const messages: AgentMsg[] = [];
    const waitUntilStarted = vi.fn<RecordReadiness["waitUntilStarted"]>();
    const takeFullSnapshot = vi.fn();
    const handler = createCommandHandler(
      { emit: (message) => messages.push(message) },
      {
        getNodeMirror: () => ({ getIds: () => [], getNode: () => null }),
        recordReadiness: {
          isStarted: () => true,
          onStarted: () => () => undefined,
          waitUntilStarted,
        },
        takeFullSnapshot,
      },
    );

    handler({ cmd: "snapshot", reqId: 12 });

    expect(waitUntilStarted).not.toHaveBeenCalled();
    expect(takeFullSnapshot).toHaveBeenCalledOnce();
    expect(messages).toEqual([{ kind: "cmdres", reqId: 12, ok: true }]);
  });

  it("does not expose rrweb's raw startup exception", () => {
    const messages: AgentMsg[] = [];
    const handler = createCommandHandler(
      { emit: (message) => messages.push(message) },
      {
        getNodeMirror: () => ({ getIds: () => [], getNode: () => null }),
        recordReadiness: {
          isStarted: () => true,
          onStarted: () => () => undefined,
          waitUntilStarted: () => Promise.resolve(true),
        },
        takeFullSnapshot: () => {
          throw new Error("please take full snapshot after start recording");
        },
      },
    );

    handler({ cmd: "snapshot", reqId: 13 });

    expect(messages).toEqual([
      { kind: "cmdres", reqId: 13, ok: false, err: "recorder not ready; retry snapshot" },
    ]);
  });
});

describe("mirror node helper", () => {
  it("exposes the actual recorder-mirror node on the main-world global", () => {
    const node = { isConnected: true } as Node;
    const fakeWindow: Record<string, unknown> = {};
    vi.stubGlobal("window", fakeWindow);
    const nodeMirror: NodeMirror = {
      getIds: () => [71],
      getNode: (nodeId) => (nodeId === 71 ? node : null),
    };

    installMirrorNodeHelper(() => nodeMirror);

    const helper = fakeWindow[MIRROR_NODE_FN_NAME] as (nodeId: number) => Node | null;
    expect(helper(71)).toBe(node);
    expect(helper(999)).toBeNull();
  });
});
