// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STITCH_ACK_MESSAGE_TYPE,
  STITCH_READY_MESSAGE_TYPE,
  STITCH_SYNC_MESSAGE_TYPE,
  STITCH_SYNC_MIN_INTERVAL_MS,
  acknowledgeAttachedDocument,
  broadcastStitchSync,
  createReturnedDocumentCheck,
  installStitchReadyListener,
  installStitchSyncListener,
  isCrossOriginChild,
  installStitchSyncForwarder,
  isHiddenBlankFrame,
  readStitchMessage,
  rrwebParentMessage,
  setStitchKey,
} from "./stitch";
import { createRecordReadiness, type RecordReadiness } from "./commands";
import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";

afterEach(() => {
  vi.useRealTimers();
  setStitchKey("");
});

interface WindowHarness {
  window: Window;
  dispatch(data: unknown, source?: MessageEventSource | null): void;
}

function windowHarness(frames: Window[] = [], parent?: Window): WindowHarness {
  const listeners = new Set<(event: MessageEvent) => void>();
  const harness = {} as WindowHarness;
  harness.dispatch = (data, source = null) => {
    for (const listener of listeners) listener({ data, source } as MessageEvent);
  };
  harness.window = {
    frames,
    get parent() {
      return parent ?? harness.window;
    },
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener as (event: MessageEvent) => void);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener as (event: MessageEvent) => void);
    },
    postMessage: vi.fn((data: unknown) => harness.dispatch(data)),
  } as unknown as Window;
  return harness;
}

function stitchDependencies(
  readiness: RecordReadiness,
  takeFullSnapshot: () => void,
  now?: () => number,
) {
  return {
    isRecorderStarted: readiness.isStarted,
    onRecorderStarted: readiness.onStarted,
    takeFullSnapshot,
    now,
  };
}

describe("stitch-sync", () => {
  it("detects only children whose parent document access throws", () => {
    const top = {} as Window;
    Object.defineProperties(top, {
      parent: { value: top },
      document: { value: {} },
    });
    const sameOriginChild = { parent: top } as Window;
    const crossOriginParent = {} as Window;
    Object.defineProperty(crossOriginParent, "document", {
      get: () => {
        throw new DOMException("Blocked a frame with origin", "SecurityError");
      },
    });
    const crossOriginChild = { parent: crossOriginParent } as Window;

    expect(isCrossOriginChild(top)).toBe(false);
    expect(isCrossOriginChild(sameOriginChild)).toBe(false);
    expect(isCrossOriginChild(crossOriginChild)).toBe(true);
  });

  /** Past the rate limit's interval after the recorder's own first snapshot. */
  const settle = () => vi.advanceTimersByTimeAsync(STITCH_SYNC_MIN_INTERVAL_MS);

  it("forwards stitch-sync through nested child frames", async () => {
    vi.useFakeTimers();
    const deepest = windowHarness();
    const grandchild = windowHarness([deepest.window]);
    const child = windowHarness([grandchild.window]);
    const childSnapshot = vi.fn();
    const grandchildSnapshot = vi.fn();
    const childReadiness = createRecordReadiness();
    const grandchildReadiness = createRecordReadiness();
    childReadiness.markStarted();
    grandchildReadiness.markStarted();
    installStitchSyncListener(child.window, stitchDependencies(childReadiness, childSnapshot));
    installStitchSyncListener(
      grandchild.window,
      stitchDependencies(grandchildReadiness, grandchildSnapshot),
    );
    await settle();

    child.dispatch({ type: STITCH_SYNC_MESSAGE_TYPE });

    expect(childSnapshot).toHaveBeenCalledOnce();
    expect(grandchildSnapshot).toHaveBeenCalledOnce();
    expect(deepest.window.postMessage).toHaveBeenCalledWith(
      { type: STITCH_SYNC_MESSAGE_TYPE },
      "*",
    );
  });

  it("honors child snapshot requests no more often than every 250ms", async () => {
    vi.useFakeTimers();
    const child = windowHarness();
    const takeFullSnapshot = vi.fn();
    const readiness = createRecordReadiness();
    readiness.markStarted();
    installStitchSyncListener(child.window, stitchDependencies(readiness, takeFullSnapshot));
    await settle();

    child.dispatch({ type: STITCH_SYNC_MESSAGE_TYPE });
    child.dispatch({ type: STITCH_SYNC_MESSAGE_TYPE });
    await vi.advanceTimersByTimeAsync(249);

    expect(takeFullSnapshot).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);

    expect(takeFullSnapshot).toHaveBeenCalledTimes(2);
  });

  it("lets only a snapshot taken with the request skip asking the frames below again", async () => {
    vi.useFakeTimers();
    const descendant = windowHarness();
    const child = windowHarness([descendant.window]);
    const takeFullSnapshot = vi.fn();
    const readiness = createRecordReadiness();
    readiness.markStarted();
    installStitchSyncListener(child.window, stitchDependencies(readiness, takeFullSnapshot));
    await settle();

    child.dispatch({ type: STITCH_SYNC_MESSAGE_TYPE });
    expect(descendant.window.postMessage).toHaveBeenCalledOnce();
    expect(takeFullSnapshot).toHaveBeenLastCalledWith(true);

    // Too soon for another: the snapshot put off asks the frames below itself when it is taken.
    child.dispatch({ type: STITCH_SYNC_MESSAGE_TYPE });
    expect(descendant.window.postMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);
    expect(takeFullSnapshot).toHaveBeenCalledTimes(2);
    expect(takeFullSnapshot).toHaveBeenLastCalledWith(false);
  });

  it("forwards a request received before readiness, which the first snapshot then answers", async () => {
    vi.useFakeTimers();
    const parent = windowHarness();
    const descendant = windowHarness();
    const child = windowHarness([descendant.window], parent.window);
    const takeFullSnapshot = vi.fn();
    const readiness = createRecordReadiness();
    installStitchSyncListener(child.window, stitchDependencies(readiness, takeFullSnapshot));

    child.dispatch({ type: STITCH_SYNC_MESSAGE_TYPE });

    expect(takeFullSnapshot).not.toHaveBeenCalled();
    expect(descendant.window.postMessage).toHaveBeenCalledWith(
      { type: STITCH_SYNC_MESSAGE_TYPE },
      "*",
    );

    // The recorder's first snapshot comes after the request.
    readiness.markStarted();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(takeFullSnapshot).not.toHaveBeenCalled();
    expect(parent.window.postMessage).toHaveBeenCalledWith(
      { type: STITCH_READY_MESSAGE_TYPE },
      "*",
    );
  });

  it("responds to child readiness with a targeted stitch-sync", () => {
    const child = windowHarness();
    const parent = windowHarness([child.window]);
    installStitchReadyListener(parent.window);

    parent.dispatch({ type: STITCH_READY_MESSAGE_TYPE }, child.window);

    expect(child.window.postMessage).toHaveBeenCalledWith(
      { type: STITCH_SYNC_MESSAGE_TYPE, ready: true },
      "*",
    );
  });

  /** A child recorder whose ready message reaches a parent that answers it, as index.ts does. */
  function startingChild() {
    const parent = windowHarness();
    const child = windowHarness([], parent.window);
    installStitchReadyListener(parent.window);
    const takeFullSnapshot = vi.fn();
    const readiness = createRecordReadiness();
    installStitchSyncListener(child.window, stitchDependencies(readiness, takeFullSnapshot));
    return { parent, child, readiness, takeFullSnapshot };
  }

  it("sends a frame's first snapshot once when the frame above took it in", async () => {
    vi.useFakeTimers();
    const { parent, child, readiness, takeFullSnapshot } = startingChild();
    // The frame above takes in the first snapshot before the ready message, and says so.
    parent.window.postMessage = vi.fn((data: unknown) => {
      if ((data as { type?: unknown }).type === STITCH_READY_MESSAGE_TYPE)
        child.dispatch({ type: STITCH_ACK_MESSAGE_TYPE });
      parent.dispatch(data, child.window);
    });
    readiness.markStarted();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(child.window.postMessage).toHaveBeenCalledWith(
      { type: STITCH_SYNC_MESSAGE_TYPE, ready: true },
      "*",
    );
    expect(takeFullSnapshot).not.toHaveBeenCalled();
  });

  it("sends a frame's first snapshot again when the frame above dropped it", async () => {
    vi.useFakeTimers();
    const { parent, child, readiness, takeFullSnapshot } = startingChild();
    parent.window.postMessage = vi.fn((data: unknown) => parent.dispatch(data, child.window));
    readiness.markStarted();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(takeFullSnapshot).toHaveBeenCalledOnce();
  });

  it("lets a snapshot the frame above took in after a request answer it", async () => {
    vi.useFakeTimers();
    const descendant = windowHarness();
    const child = windowHarness([descendant.window]);
    const takeFullSnapshot = vi.fn();
    const readiness = createRecordReadiness();
    readiness.markStarted();
    installStitchSyncListener(child.window, stitchDependencies(readiness, takeFullSnapshot));
    await Promise.resolve();

    // Asked again just after the first snapshot: put off, and not passed down yet.
    child.dispatch({ type: STITCH_SYNC_MESSAGE_TYPE });
    expect(descendant.window.postMessage).not.toHaveBeenCalled();
    // The first snapshot reaches the frame above after the request was sent.
    child.dispatch({ type: STITCH_ACK_MESSAGE_TYPE });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(takeFullSnapshot).not.toHaveBeenCalled();
    expect(descendant.window.postMessage).not.toHaveBeenCalled();
  });

  it("still answers a request whose snapshot was taken in before it was sent", async () => {
    vi.useFakeTimers();
    const child = windowHarness();
    const takeFullSnapshot = vi.fn();
    const readiness = createRecordReadiness();
    readiness.markStarted();
    installStitchSyncListener(child.window, stitchDependencies(readiness, takeFullSnapshot));
    await Promise.resolve();

    child.dispatch({ type: STITCH_ACK_MESSAGE_TYPE });
    child.dispatch({ type: STITCH_SYNC_MESSAGE_TYPE });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(takeFullSnapshot).toHaveBeenCalledOnce();
  });

  it("tells a frame's document that its snapshot was taken in", () => {
    const frameWindow = { postMessage: vi.fn() };
    const frame = { contentWindow: frameWindow } as unknown as Node;
    const attach = (isAttachIframe: boolean, type: number) =>
      ({
        type: EventType.IncrementalSnapshot,
        timestamp: 1,
        data: {
          source: IncrementalSource.Mutation,
          texts: [],
          attributes: [],
          removes: [],
          adds: [{ parentId: 9, nextId: null, node: { type, id: 10, childNodes: [] } }],
          isAttachIframe,
        },
      }) as unknown as eventWithTime;
    const nodeFor = (id: number) => (id === 9 ? frame : null);

    acknowledgeAttachedDocument(attach(false, 0), nodeFor);
    acknowledgeAttachedDocument(attach(true, 2), nodeFor);
    expect(frameWindow.postMessage).not.toHaveBeenCalled();
    acknowledgeAttachedDocument(attach(true, 0), nodeFor);
    expect(frameWindow.postMessage).toHaveBeenCalledWith({ type: STITCH_ACK_MESSAGE_TYPE }, "*");
  });

  it("broadcasts only to immediate child browsing contexts", () => {
    const first = windowHarness();
    const second = windowHarness();
    const parent = windowHarness([first.window, second.window]);

    broadcastStitchSync(parent.window);

    expect(first.window.postMessage).toHaveBeenCalledOnce();
    expect(second.window.postMessage).toHaveBeenCalledOnce();
  });
});

describe("stitch messages under the session's key (hardening)", () => {
  const KEY = "k3x9q2m0p1zz";

  it("sends no fixed name: only the key, with a number", () => {
    setStitchKey(KEY);
    const child = windowHarness();
    const parent = windowHarness([child.window]);
    installStitchReadyListener(parent.window);
    broadcastStitchSync(parent.window);
    expect(child.window.postMessage).toHaveBeenLastCalledWith({ [KEY]: 1 }, "*");
    parent.dispatch({ [KEY]: 2 }, child.window);
    expect(child.window.postMessage).toHaveBeenLastCalledWith({ [KEY]: 4 }, "*");
    expect(rrwebParentMessage({ type: 2 }, "https://child.test", true)).toEqual({
      [KEY]: { event: { type: 2 }, origin: "https://child.test", isCheckout: true },
    });
    for (const sent of vi.mocked(child.window.postMessage).mock.calls)
      expect(JSON.stringify(sent[0])).not.toMatch(/@mirror|rrweb|type/);
  });

  it("ignores the fixed names once there is a key, and the key without one", () => {
    setStitchKey(KEY);
    expect(readStitchMessage({ type: STITCH_SYNC_MESSAGE_TYPE })).toBeNull();
    expect(readStitchMessage({ [KEY]: 3 })).toBe("ack");
    expect(readStitchMessage({ [KEY]: 9 })).toBeNull();
    setStitchKey("");
    expect(readStitchMessage({ [KEY]: 1 })).toBeNull();
    expect(readStitchMessage({ type: STITCH_SYNC_MESSAGE_TYPE, ready: true })).toBe("sync-ready");
    expect(rrwebParentMessage(1, "o", false)).toEqual({
      type: "rrweb",
      event: 1,
      origin: "o",
      isCheckout: false,
    });
  });

  it("runs the whole ready, ack and sync exchange under the key", async () => {
    vi.useFakeTimers();
    setStitchKey(KEY);
    const parent = windowHarness();
    const child = windowHarness([], parent.window);
    installStitchReadyListener(parent.window);
    const takeFullSnapshot = vi.fn();
    const readiness = createRecordReadiness();
    installStitchSyncListener(child.window, stitchDependencies(readiness, takeFullSnapshot));
    // The frame above takes in the first snapshot before the ready message, and says so.
    parent.window.postMessage = vi.fn((data: unknown) => {
      if (readStitchMessage(data) === "ready") child.dispatch({ [KEY]: 3 });
      parent.dispatch(data, child.window);
    });
    readiness.markStarted();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(parent.window.postMessage).toHaveBeenCalledWith({ [KEY]: 2 }, "*");
    expect(takeFullSnapshot).not.toHaveBeenCalled();
    // A later request is honoured.
    child.dispatch({ [KEY]: 1 });
    expect(takeFullSnapshot).toHaveBeenCalledOnce();
  });
});

describe("installStitchSyncForwarder", () => {
  it("passes the request to the frames below, and nothing else", () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    const child = { postMessage: vi.fn() };
    const target = {
      frames: [child],
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MessageEvent) => void) =>
        listeners.delete(listener),
    } as unknown as Window;
    const fire = (data: unknown) => {
      for (const listener of listeners) listener({ data } as MessageEvent);
    };
    const dispose = installStitchSyncForwarder(target);

    fire({ type: "something-else" });
    fire(null);
    expect(child.postMessage).not.toHaveBeenCalled();

    fire({ type: STITCH_SYNC_MESSAGE_TYPE });
    expect(child.postMessage).toHaveBeenCalledWith({ type: STITCH_SYNC_MESSAGE_TYPE }, "*");

    dispose();
    expect(listeners.size).toBe(0);
  });
});

describe("isHiddenBlankFrame", () => {
  const frame = (href: string, display: string | null, blocked = false) =>
    ({
      parent: {},
      location: { href },
      get frameElement() {
        if (blocked) throw new Error("cross-origin");
        return display === null ? null : { style: { display } };
      },
    }) as unknown as Window;

  it("recognises a hidden blank frame, and one whose parent cannot reach it", () => {
    expect(isHiddenBlankFrame(frame("about:blank", "none"))).toBe(true);
    expect(isHiddenBlankFrame(frame("about:blank", null))).toBe(true);
    expect(isHiddenBlankFrame(frame("about:blank", "none", true))).toBe(true);
  });

  it("keeps recording anything that can have content", () => {
    expect(isHiddenBlankFrame(frame("about:blank", ""))).toBe(false);
    expect(isHiddenBlankFrame(frame("https://a.test/", "none"))).toBe(false);
    const top = { location: { href: "about:blank" } } as unknown as Window & { parent: unknown };
    top.parent = top;
    expect(isHiddenBlankFrame(top)).toBe(false);
  });
});

describe("createReturnedDocumentCheck", () => {
  const attach = (id: number): eventWithTime =>
    ({
      type: EventType.IncrementalSnapshot,
      timestamp: 1,
      data: {
        source: IncrementalSource.Mutation,
        texts: [],
        attributes: [],
        removes: [],
        adds: [{ parentId: 5, nextId: null, node: { type: 0, id, childNodes: [] } }],
      },
    }) as unknown as eventWithTime;
  const snapshot = {
    type: EventType.FullSnapshot,
    timestamp: 1,
    data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } },
  } as unknown as eventWithTime;

  const added = (node: unknown): eventWithTime =>
    ({
      type: EventType.IncrementalSnapshot,
      timestamp: 1,
      data: {
        source: IncrementalSource.Mutation,
        texts: [],
        attributes: [],
        removes: [],
        adds: [{ parentId: 5, nextId: null, node }],
      },
    }) as unknown as eventWithTime;
  const frame = (id: number) => ({ type: 2, id, tagName: "iframe", childNodes: [] });
  const wrapper = (id: number, ...childNodes: unknown[]) => ({
    type: 2,
    id,
    tagName: "div",
    childNodes,
  });

  it("recognises a frame added again, even inside a new wrapper", () => {
    const isReturned = createReturnedDocumentCheck();
    expect(isReturned(added(frame(20)))).toBe(false);
    expect(isReturned(added(wrapper(30, frame(21))))).toBe(false);
    expect(isReturned(added(wrapper(31, frame(20))))).toBe(true);
    expect(isReturned(added(frame(21)))).toBe(true);
  });

  it("recognises a frame from a snapshot added again, and forgets it after the next", () => {
    const withFrame = {
      type: EventType.FullSnapshot,
      timestamp: 1,
      data: { node: wrapper(1, frame(40)), initialOffset: { top: 0, left: 0 } },
    } as unknown as eventWithTime;
    const isReturned = createReturnedDocumentCheck();
    expect(isReturned(withFrame)).toBe(false);
    expect(isReturned(added(frame(40)))).toBe(true);
    expect(isReturned(snapshot)).toBe(false);
    expect(isReturned(added(frame(40)))).toBe(false);
  });

  it("does not ask again when a report brings back a document's frames", () => {
    const report = (id: number) => ({ type: 0, id, childNodes: [frame(50)] });
    const isReturned = createReturnedDocumentCheck();
    expect(isReturned(added(report(60)))).toBe(false);
    expect(isReturned(added(report(61)))).toBe(false);
  });

  it("recognises a document attached a second time", () => {
    const isReturned = createReturnedDocumentCheck();
    expect(isReturned(attach(7))).toBe(false);
    expect(isReturned(attach(8))).toBe(false);
    expect(isReturned(attach(7))).toBe(true);
  });

  it("leaves documents attached after a snapshot to the snapshot's own request", () => {
    const isReturned = createReturnedDocumentCheck();
    isReturned(attach(7));
    isReturned(snapshot);
    expect(isReturned(attach(7))).toBe(false);
  });

  it("stops immediate propagation of keyed stitch messages so page listeners never observe them", () => {
    setStitchKey("k9x2m7p4q1w8");
    const child = windowHarness();
    const stopImmediatePropagation = vi.fn();
    let registeredCapture: unknown;
    const origAdd = child.window.addEventListener;
    child.window.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      capture?: boolean,
    ) => {
      registeredCapture = capture;
      origAdd(type, listener);
    }) as typeof child.window.addEventListener;
    const readiness = createRecordReadiness();
    readiness.markStarted();
    installStitchSyncListener(child.window, stitchDependencies(readiness, vi.fn()));
    expect(registeredCapture).toBe(true);

    const listeners = child.window as unknown as Record<string, unknown>;
    void listeners;
    // Dispatch a keyed stitch-ack message and verify stopImmediatePropagation is called,
    // while unrelated page messages are left untouched.
    const keyedAck = {
      data: { k9x2m7p4q1w8: 3 },
      stopImmediatePropagation,
    } as unknown as MessageEvent;
    const unrelated = {
      data: { hello: "world" },
      stopImmediatePropagation: vi.fn(),
    } as unknown as MessageEvent;
    // Trigger via a custom harness listener invoke
    const capturedListeners: Array<(e: MessageEvent) => void> = [];
    const h2 = windowHarness();
    const origAdd2 = h2.window.addEventListener;
    h2.window.addEventListener = ((t: string, l: EventListenerOrEventListenerObject) => {
      capturedListeners.push(l as (e: MessageEvent) => void);
      origAdd2(t, l);
    }) as typeof h2.window.addEventListener;
    installStitchSyncListener(h2.window, stitchDependencies(readiness, vi.fn()));
    capturedListeners[0]!(keyedAck);
    capturedListeners[0]!(unrelated);
    expect(stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(unrelated.stopImmediatePropagation).not.toHaveBeenCalled();
  });
});
