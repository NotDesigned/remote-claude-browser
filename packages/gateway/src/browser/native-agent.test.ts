import { describe, expect, it, vi } from "vitest";
import { EventType, type AgentMsg } from "@mirror/protocol";
import { TabHub } from "../hub/tabhub";
import type { TargetRef } from "../types";
import type { BrowserHandle } from "./launch";
import { createNativeAgentLink, recordingMode } from "./native-agent";

function harness() {
  let attach!: (target: TargetRef) => void;
  let detach!: (target: TargetRef) => void;
  let navigate!: (session: string, event: { frame: { parentId?: string } }) => void;
  let loader = "document-1";
  const send = vi.fn(async (_session: string, method: string) => {
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { url: "https://example.test/", loaderId: loader } } };
    if (method === "Page.getLayoutMetrics")
      return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };
    return {};
  });
  const browser = {
    send,
    onAttached(callback: typeof attach) {
      attach = callback;
    },
    onDetached(callback: typeof detach) {
      detach = callback;
    },
    onSessionEvent(_method: string, callback: typeof navigate) {
      navigate = callback;
      return () => {};
    },
  } as unknown as BrowserHandle;
  return {
    browser,
    send,
    attach: (t: TargetRef) => attach(t),
    detach: (t: TargetRef) => detach(t),
    navigate: (session: string) => navigate(session, { frame: {} }),
    nextDocument: () => {
      loader = "document-2";
    },
  };
}
const page: TargetRef = { targetId: "t", sessionId: "s", type: "page" };
async function take(stream: AsyncIterator<AgentMsg>, count: number) {
  const result: AgentMsg[] = [];
  for (let i = 0; i < count; i++) {
    const value = await stream.next();
    expect(value.done).toBe(false);
    result.push(value.value!);
  }
  return result;
}

describe("native pixel lifecycle", () => {
  it("rejects misspelled protection settings", () => {
    expect(recordingMode(undefined)).toBe("dom");
    expect(recordingMode("native")).toBe("native");
    expect(() => recordingMode("natve")).toThrow("MIRROR_RECORDING_MODE");
  });
  it("provides viewport epochs without page code, bindings, or a website DOM snapshot", async () => {
    const h = harness();
    const link = createNativeAgentLink(h.browser);
    h.attach(page);
    const stream = link.msgs(page.targetId)[Symbol.asyncIterator]();
    const initial = await take(stream, 3);
    expect(initial[0]).toMatchObject({ kind: "hello", url: "https://example.test/", isTop: true });
    const hub = new TabHub({ sessionId: "client", tabId: page.targetId });
    const first = initial.flatMap((message) => hub.ingest(message));
    expect(first.some((message) => message.t === "snapshot")).toBe(true);
    hub.requestSnapshot("viewport");
    await link.sendCmd(page.targetId, { cmd: "snapshot" });
    const updated = (await take(stream, 2)).flatMap((message) => hub.ingest(message));
    expect(updated).toContainEqual(expect.objectContaining({ t: "snapshot", reason: "viewport" }));
    expect(
      h.send.mock.calls
        .map(([, method]) => method)
        .filter((method) =>
          [
            "Page.addScriptToEvaluateOnNewDocument",
            "Runtime.addBinding",
            "Runtime.evaluate",
            "DOM.getDocument",
          ].includes(method),
        ),
    ).toEqual([]);
    expect(initial[2]).toMatchObject({ kind: "rrweb", e: { type: EventType.FullSnapshot } });
    h.detach(page);
    await expect(stream.next()).resolves.toEqual({ value: undefined, done: true });
  });
  it("creates a new document epoch on navigation and isolates another target", async () => {
    const h = harness();
    const link = createNativeAgentLink(h.browser);
    h.attach(page);
    const first = link.msgs(page.targetId)[Symbol.asyncIterator]();
    const before = await take(first, 3);
    const other = { ...page, targetId: "other", sessionId: "other-session" };
    h.attach(other);
    const second = link.msgs(other.targetId)[Symbol.asyncIterator]();
    await take(second, 3);
    h.nextDocument();
    h.navigate(page.sessionId);
    const after = await take(first, 3);
    expect(after[0]!.kind).toBe("hello");
    expect((after[0] as Extract<AgentMsg, { kind: "hello" }>).docId).not.toBe(
      (before[0] as Extract<AgentMsg, { kind: "hello" }>).docId,
    );
    expect(await link.sendCmd(page.targetId, { cmd: "rect", nodeId: 42 })).toMatchObject({
      ok: false,
    });
    h.detach(page);
    h.detach(other);
  });
  it("always resumes an iframe and a page whose preparation fails", async () => {
    const h = harness();
    const link = createNativeAgentLink(h.browser, async () => {
      throw new Error("prepare failed");
    });
    h.attach({ ...page, targetId: "iframe", type: "iframe" });
    h.attach(page);
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      h.send.mock.calls.filter(([, m]) => m === "Runtime.runIfWaitingForDebugger"),
    ).toHaveLength(2);
    await expect(link.msgs(page.targetId)[Symbol.asyncIterator]().next()).rejects.toThrow(
      "prepare failed",
    );
  });
});
