import type { AgentCmdInput, AgentMsg, CmdRes, Up } from "@mirror/protocol";
import { Mod, NODE_IN_FRAME_ERROR } from "@mirror/protocol";
import { describe, expect, it, vi } from "vitest";
import type { AgentLink, CdpSend } from "../types";
import { createInputRelay, type InputMsg } from "./relay";

const pointer = (kind: "move" | "down" | "up" | "wheel"): Extract<Up, { t: "ptr" }> => ({
  t: "ptr",
  tab: "tab-1",
  kind,
  nodeId: 42,
  rx: 0.5,
  ry: 0.25,
  vx: 700,
  vy: 500,
  button: 0,
  buttons: kind === "up" ? 0 : 1,
  mods: Mod.Shift,
  clicks: 2,
  dx: 4,
  dy: 9,
});

function harness(
  options: {
    resolve?: () => Promise<CmdRes>;
    rect?: (call: number) => Promise<CmdRes>;
    driver?: string;
    allowed?: boolean;
    session?: string;
    rectTimeoutMs?: number;
    value?: () => Promise<CmdRes>;
  } = {},
) {
  const cdp: { sessionId: string; method: string; params?: Record<string, unknown> }[] = [];
  const commands: AgentCmdInput[] = [];
  const notes: string[] = [];
  let rectCalls = 0;
  const agentLink: AgentLink = {
    async *msgs(): AsyncIterable<AgentMsg> {},
    async sendCmd(_tabId, command) {
      commands.push(command);
      if (command.cmd === "resolve") {
        return (
          options.resolve?.() ?? {
            reqId: commands.length,
            ok: true,
            data: { kind: "local" },
          }
        );
      }
      if (command.cmd === "rect") {
        rectCalls += 1;
        return (
          options.rect?.(rectCalls) ??
          Promise.resolve({
            reqId: rectCalls,
            ok: true,
            data: { x: 10, y: 20, w: 100, h: 80, visible: true },
          })
        );
      }
      if (command.cmd === "value" && options.value) return options.value();
      return { reqId: commands.length, ok: true };
    },
  };
  const send: CdpSend = async (sessionId, method, params) => {
    cdp.push({ sessionId, method, ...(params === undefined ? {} : { params }) });
    return {};
  };
  const relay = createInputRelay({
    agentLink,
    send,
    sessionFor: () => options.session ?? "session-1",
    isDriver: (viewerId) => viewerId === (options.driver ?? "driver"),
    allowsInput: () => options.allowed ?? true,
    noteInput: (tabId) => notes.push(tabId),
    viewportFor: () => ({ w: 640, h: 480 }),
    rectTimeoutMs: options.rectTimeoutMs ?? 10,
  });
  return { relay, cdp, commands, notes, rectCalls: () => rectCalls };
}

describe("InputRelay", () => {
  it("adds up queued wheel events so a busy page does not fall behind", async () => {
    let release!: (value: CmdRes) => void;
    const h = harness({
      rect: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      rectTimeoutMs: 1000,
    });
    const wheel = (dy: number) => ({ ...pointer("wheel"), buttons: 0, dx: 0, dy });
    const first = h.relay("driver", wheel(10));
    await vi.waitFor(() => expect(h.rectCalls()).toBe(1));
    const queued = Array.from({ length: 50 }, () => h.relay("driver", wheel(2)));
    const down = h.relay("driver", pointer("down"));
    const later = h.relay("driver", wheel(5));
    const answer = (reqId: number) =>
      release({ reqId, ok: true, data: { x: 10, y: 20, w: 100, h: 80, visible: true } });
    answer(1);
    for (let call = 2; call <= 4; call++) {
      await vi.waitFor(() => expect(h.rectCalls()).toBe(call));
      answer(call);
    }
    await Promise.all([first, ...queued, down, later]);
    expect(h.cdp.map(({ params }) => [params?.type, params?.deltaY])).toEqual([
      ["mouseWheel", 10],
      ["mouseWheel", 100],
      ["mousePressed", undefined],
      ["mouseWheel", 5],
    ]);
  });

  it("coalesces queued hover moves while preserving click barriers", async () => {
    let release!: (value: CmdRes) => void;
    const h = harness({
      rect: (call) =>
        call === 1
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve({
              reqId: call,
              ok: true,
              data: { x: 10, y: 20, w: 100, h: 80, visible: true },
            }),
      rectTimeoutMs: 1000,
    });
    const first = h.relay("driver", { ...pointer("move"), buttons: 0 });
    await vi.waitFor(() => expect(h.rectCalls()).toBe(1));
    const queued = Array.from({ length: 50 }, (_, index) =>
      h.relay("driver", { ...pointer("move"), buttons: 0, rx: index / 100 }),
    );
    const down = h.relay("driver", pointer("down"));
    const up = h.relay("driver", pointer("up"));
    const after = Array.from({ length: 20 }, (_, index) =>
      h.relay("driver", { ...pointer("move"), buttons: 0, rx: index / 100 }),
    );
    release({ reqId: 1, ok: true, data: { x: 10, y: 20, w: 100, h: 80, visible: true } });
    await Promise.all([first, ...queued, down, up, ...after]);
    expect(h.cdp.map((entry) => entry.params?.type)).toEqual([
      "mouseMoved",
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
      "mouseMoved",
    ]);
  });
  it("blocks sending stale text after a failed value update and recovers after synchronization", async () => {
    let failed = true;
    const h = harness({ value: async () => ({ reqId: 1, ok: !failed }) });
    const value: InputMsg = {
      t: "value",
      tab: "tab-1",
      nodeId: 42,
      value: "最终问题",
      commit: false,
    };
    const enter: InputMsg = {
      t: "key",
      tab: "tab-1",
      kind: "down",
      key: "Enter",
      code: "Enter",
      mods: 0,
    };
    expect(await h.relay("driver", value)).toBe(false);
    expect(await h.relay("driver", enter)).toBe(false);
    expect(await h.relay("driver", pointer("down"))).toBe(false);
    expect(h.cdp).toEqual([]);
    failed = false;
    expect(await h.relay("driver", value)).toBe(true);
    expect(await h.relay("driver", enter)).toBe(true);
    expect(h.cdp[0]?.params).toMatchObject({ key: "Enter" });
  });
  it.each([
    ["move", 700, -5, 640 - Number.EPSILON, 0, "mouseMoved"],
    ["down", -10, 500, 0, 480 - Number.EPSILON, "mousePressed"],
    ["up", Number.NaN, Number.POSITIVE_INFINITY, 0, 0, "mouseReleased"],
    ["wheel", 21.5, 42.25, 21.5, 42.25, "mouseWheel"],
  ] as const)(
    "dispatches node-less %s with sanitized viewport coordinates without waiting for the agent",
    async (kind, vx, vy, x, y, type) => {
      const h = harness({ resolve: () => new Promise<CmdRes>(() => undefined) });

      await expect(h.relay("driver", { ...pointer(kind), nodeId: -1, vx, vy })).resolves.toBe(true);

      expect(h.commands).toEqual([]);
      expect(h.cdp).toEqual([
        {
          sessionId: "session-1",
          method: "Input.dispatchMouseEvent",
          params: expect.objectContaining({ type, x, y }),
        },
      ]);
      expect(h.relay.rectFallbacksFor("tab-1")).toBe(0);
    },
  );

  it("resolves recorder nodes normally after node-less pointer input", async () => {
    const h = harness();
    await expect(h.relay("driver", { ...pointer("move"), nodeId: -1 })).resolves.toBe(true);
    await expect(h.relay("driver", pointer("down"))).resolves.toBe(true);

    // A node of the top document needs one trip to the page.
    expect(h.commands).toEqual([{ cmd: "rect", nodeId: 42 }]);
    expect(h.cdp[1]?.params).toMatchObject({ type: "mousePressed", x: 60, y: 40 });
  });

  it("keeps driver, viewport, and document generation gates for node-less pointers", async () => {
    const follower = harness();
    const stale = harness({ allowed: false });
    const recovered = harness();
    const msg = { ...pointer("down"), nodeId: -1 };
    const queued = recovered.relay("driver", msg);
    recovered.relay.resetTab("tab-1");

    await expect(follower.relay("viewer", msg)).resolves.toBe(false);
    await expect(stale.relay("driver", msg)).resolves.toBe(false);
    await expect(queued).resolves.toBe(false);
    for (const h of [follower, stale, recovered]) {
      expect(h.commands).toEqual([]);
      expect(h.cdp).toEqual([]);
    }
  });

  it("drops resolving and queued inputs from a crashed document after recovery", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      rectTimeoutMs: 1000,
      rect: async () => {
        await ready;
        return { reqId: 1, ok: true, data: { x: 0, y: 0, w: 20, h: 20, visible: true } };
      },
    });
    const down = h.relay("driver", pointer("down"));
    const up = h.relay("driver", pointer("up"));
    await vi.waitFor(() => expect(h.rectCalls()).toBe(1));
    h.relay.resetTab("tab-1");
    release();
    expect(await Promise.all([down, up])).toEqual([false, false]);
    expect(h.cdp).toEqual([]);
    expect(await h.relay("driver", pointer("move"))).toBe(true);
    expect(h.cdp).toHaveLength(1);
  });
  it("releases a click where its press landed and preserves their wire order", async () => {
    let releaseFirstRect!: () => void;
    const firstRectReady = new Promise<void>((resolve) => (releaseFirstRect = resolve));
    const h = harness({
      rectTimeoutMs: 1_000,
      rect: async (call) => {
        if (call === 1) await firstRectReady;
        return {
          reqId: call,
          ok: true,
          data:
            call === 1
              ? { x: 10, y: 20, w: 100, h: 80, visible: true }
              : { x: 210, y: 120, w: 100, h: 80, visible: true },
        };
      },
    });

    const down = h.relay("driver", pointer("down"));
    const up = h.relay("driver", pointer("up"));
    await vi.waitFor(() => expect(h.rectCalls()).toBe(1));
    releaseFirstRect();
    await expect(Promise.all([down, up])).resolves.toEqual([true, true]);

    expect(h.commands).toEqual([{ cmd: "rect", nodeId: 42 }]);
    expect(h.cdp.map(({ params }) => params)).toEqual([
      expect.objectContaining({
        type: "mousePressed",
        x: 60,
        y: 40,
        button: "left",
        modifiers: Mod.Shift,
        clickCount: 2,
      }),
      expect.objectContaining({
        type: "mouseReleased",
        x: 60,
        y: 40,
        button: "left",
        modifiers: Mod.Shift,
        clickCount: 2,
      }),
    ]);
  });

  it("drags from where the press landed by how far the pointer moved, as a slider's thumb follows", async () => {
    // The thumb moves with the pointer in the page before the mirror shows it there.
    const h = harness({
      rect: async (call) => ({
        reqId: call,
        ok: true,
        data: { x: 10 + 100 * (call - 1), y: 20, w: 100, h: 80, visible: true },
      }),
    });
    await h.relay("driver", pointer("down"));
    await h.relay("driver", { ...pointer("move"), vx: 730, vy: 505 });
    await h.relay("driver", { ...pointer("move"), vx: 790, vy: 503 });
    await h.relay("driver", { ...pointer("up"), vx: 800, vy: 500 });
    await h.relay("driver", { ...pointer("move"), buttons: 0 });

    expect(h.rectCalls()).toBe(2);
    expect(h.cdp.map(({ params }) => [params?.type, params?.x, params?.y])).toEqual([
      ["mousePressed", 60, 40],
      ["mouseMoved", 90, 45],
      ["mouseMoved", 150, 43],
      ["mouseReleased", 160, 40],
      // Hover asks the page again.
      ["mouseMoved", 160, 40],
    ]);
  });

  it("does not resolve through frames a node the top document says is gone", async () => {
    const h = harness({
      rect: async (call) => ({ reqId: call, ok: false, err: "node not found" }),
    });
    await h.relay("driver", pointer("down"));
    expect(h.commands).toEqual([{ cmd: "rect", nodeId: 42 }]);
  });

  it("keeps only the latest of the scrolls of one scroller waiting behind a busy page", async () => {
    let release!: (value: CmdRes) => void;
    const h = harness({
      rect: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      rectTimeoutMs: 1000,
    });
    const down = h.relay("driver", pointer("down"));
    await vi.waitFor(() => expect(h.rectCalls()).toBe(1));
    const scroll = (nodeId: number, y: number) =>
      h.relay("driver", { t: "scroll", tab: "tab-1", nodeId, x: 0, y });
    const scrolls = [scroll(7, 100), scroll(7, 200), scroll(7, 300), scroll(8, 50), scroll(8, 60)];
    release({ reqId: 1, ok: true, data: { x: 10, y: 20, w: 100, h: 80, visible: true } });
    await Promise.all([down, ...scrolls]);
    expect(h.commands.filter((command) => command.cmd === "scroll")).toEqual([
      { cmd: "scroll", nodeId: 7, x: 0, y: 300 },
      { cmd: "scroll", nodeId: 8, x: 0, y: 60 },
    ]);
  });

  it("falls back to raw viewport coordinates only when rect resolution fails", async () => {
    const h = harness({
      rect: async (call) => ({ reqId: call, ok: false, err: "node gone" }),
    });
    await expect(h.relay("driver", pointer("down"))).resolves.toBe(true);
    expect(h.cdp[0]?.params).toMatchObject({ x: 640 - Number.EPSILON, y: 480 - Number.EPSILON });
    expect(h.relay.rectFallbacksFor("tab-1")).toBe(1);
  });

  it("falls back promptly when rect resolution times out", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ rect: () => new Promise<CmdRes>(() => undefined) });
      const dispatched = h.relay("driver", pointer("down"));
      await vi.advanceTimersByTimeAsync(10);
      await expect(dispatched).resolves.toBe(true);
      expect(h.cdp[0]?.params).toMatchObject({ x: 640 - Number.EPSILON, y: 480 - Number.EPSILON });
      expect(h.relay.rectFallbacksFor("tab-1")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [1, "left"],
    [2, "right"],
    [4, "middle"],
  ] as const)(
    "keeps held buttons %i on a drag, which would otherwise end it",
    async (buttons, button) => {
      const h = harness();
      await h.relay("driver", { ...pointer("move"), buttons });
      expect(h.cdp[0]?.params).toMatchObject({ type: "mouseMoved", button, buttons });
    },
  );

  it("forwards hover and the single wheel path through trusted CDP input", async () => {
    const h = harness();
    await h.relay("driver", { ...pointer("move"), buttons: 0 });
    await h.relay("driver", pointer("wheel"));
    expect(h.cdp.map(({ params }) => params)).toEqual([
      expect.objectContaining({ type: "mouseMoved", button: "none", x: 60, y: 40 }),
      expect.objectContaining({
        type: "mouseWheel",
        button: "none",
        x: 60,
        y: 40,
        deltaX: 4,
        deltaY: 9,
      }),
    ]);
  });

  it("maps raw key pairs and reserves insertText for paste and IME commit text", async () => {
    const h = harness();
    const messages: InputMsg[] = [
      { t: "key", tab: "tab-1", kind: "down", key: "!", code: "Digit1", mods: Mod.Shift },
      { t: "key", tab: "tab-1", kind: "up", key: "!", code: "Digit1", mods: Mod.Shift },
      { t: "text", tab: "tab-1", insert: "pasted line one\npasted line two" },
      { t: "value", tab: "tab-1", nodeId: 8, value: "selected", commit: false },
      { t: "value", tab: "tab-1", nodeId: 9, value: "on", checked: true },
      {
        t: "value",
        tab: "tab-1",
        nodeId: 10,
        value: "beta",
        values: ["beta", "gamma"],
      },
      { t: "scroll", tab: "tab-1", nodeId: 7, x: 11, y: 22 },
      { t: "scroll", tab: "tab-1", nodeId: 0, x: 0, y: 300 },
    ];
    for (const msg of messages) await h.relay("driver", msg);

    expect(h.cdp).toEqual([
      {
        sessionId: "session-1",
        method: "Input.dispatchKeyEvent",
        params: {
          type: "keyDown",
          modifiers: Mod.Shift,
          key: "!",
          code: "Digit1",
          text: "!",
          unmodifiedText: "!",
          windowsVirtualKeyCode: 49,
          location: 0,
          isKeypad: false,
        },
      },
      {
        sessionId: "session-1",
        method: "Input.dispatchKeyEvent",
        params: {
          type: "keyUp",
          modifiers: Mod.Shift,
          key: "!",
          code: "Digit1",
          windowsVirtualKeyCode: 49,
          location: 0,
          isKeypad: false,
        },
      },
      {
        sessionId: "session-1",
        method: "Input.insertText",
        params: { text: "pasted line one\npasted line two" },
      },
    ]);
    expect(h.commands.slice(-8)).toEqual([
      { cmd: "resolve", nodeId: 8 },
      { cmd: "value", nodeId: 8, value: "selected", commit: false },
      { cmd: "resolve", nodeId: 9 },
      { cmd: "value", nodeId: 9, value: "on", checked: true },
      { cmd: "resolve", nodeId: 10 },
      { cmd: "value", nodeId: 10, value: "beta", values: ["beta", "gamma"] },
      { cmd: "scroll", nodeId: 7, x: 11, y: 22 },
      { cmd: "scroll", nodeId: 0, x: 0, y: 300 },
    ]);
  });

  it("places a pointer inside a frame's border, and scrolls the frame a node is in by frame id", async () => {
    const commands: { targetId: string; command: AgentCmdInput; frameId: string | undefined }[] =
      [];
    const cdp: { method: string; params?: Record<string, unknown> }[] = [];
    const agentLink: AgentLink = {
      async *msgs(): AsyncIterable<AgentMsg> {},
      async sendCmd(targetId, command, frameId) {
        commands.push({ targetId, command, frameId });
        if (command.cmd === "resolve") {
          return frameId === undefined
            ? { reqId: 1, ok: true, data: { kind: "remote", iframeNodeId: 5, remoteId: 8 } }
            : { reqId: 1, ok: true, data: { kind: "local" } };
        }
        // The top document has the iframe element, 5; the rest are inside the frame.
        if (frameId === undefined && "nodeId" in command && command.nodeId !== 5) {
          return { reqId: 1, ok: false, err: NODE_IN_FRAME_ERROR };
        }
        if (command.cmd === "rect") {
          return {
            reqId: 1,
            ok: true,
            data:
              frameId === undefined
                ? { x: 100, y: 50, w: 300, h: 300, visible: true, borderLeft: 2, borderTop: 3 }
                : { x: 10, y: 20, w: 40, h: 40, visible: true },
          };
        }
        return { reqId: 1, ok: true };
      },
    };
    const send: CdpSend = async (_sessionId, method, params) => {
      cdp.push({ method, ...(params === undefined ? {} : { params }) });
      if (method === "DOM.describeNode") return { node: { frameId: "same-process-frame" } };
      return {};
    };
    const relay = createInputRelay({
      agentLink,
      send,
      callBridge: async () => ({ result: { objectId: "iframe-object" } }),
      callFrame: async () => ({ result: { objectId: "iframe-object" } }),
      // The frame has no target of its own.
      sessionFor: (targetId) => (targetId === "tab-1" ? "top-session" : undefined),
      isDriver: () => true,
      allowsInput: () => true,
      noteInput: () => {},
      viewportFor: () => ({ w: 640, h: 480 }),
    });

    await relay("driver", { ...pointer("down"), rx: 0, ry: 0 });
    await relay("driver", { t: "scroll", tab: "tab-1", nodeId: 44, x: 0, y: 90 });

    expect(cdp.find(({ method }) => method === "Input.dispatchMouseEvent")).toMatchObject({
      params: { x: 112, y: 73, type: "mousePressed" },
    });
    expect(relay.rectFallbacksFor("tab-1")).toBe(0);
    expect(commands).toContainEqual({
      targetId: "tab-1",
      command: { cmd: "scroll", nodeId: 8, x: 0, y: 90 },
      frameId: "same-process-frame",
    });
  });

  it("composes and clamps OOPIF rects while routing rect, value, and scroll to the child", async () => {
    const commands: { targetId: string; command: AgentCmdInput }[] = [];
    const cdp: { sessionId: string; method: string; params?: Record<string, unknown> }[] = [];
    const agentLink: AgentLink = {
      async *msgs(): AsyncIterable<AgentMsg> {},
      async sendCmd(targetId, command) {
        commands.push({ targetId, command });
        if (
          targetId === "tab-1" &&
          command.cmd !== "resolve" &&
          "nodeId" in command &&
          command.nodeId !== 5
        ) {
          return { reqId: commands.length, ok: false, err: NODE_IN_FRAME_ERROR };
        }
        if (command.cmd === "resolve") {
          return targetId === "tab-1"
            ? {
                reqId: commands.length,
                ok: true,
                data: {
                  kind: "remote",
                  iframeNodeId: 5,
                  remoteId: command.nodeId - 35,
                },
              }
            : { reqId: commands.length, ok: true, data: { kind: "local" } };
        }
        if (command.cmd === "rect") {
          return targetId === "child-1"
            ? {
                reqId: commands.length,
                ok: true,
                data: { x: -20, y: 10, w: 80, h: 40, visible: true },
              }
            : {
                reqId: commands.length,
                ok: true,
                data: { x: 100, y: 50, w: 50, h: 50, visible: true },
              };
        }
        return { reqId: commands.length, ok: true };
      },
    };
    const send: CdpSend = async (sessionId, method, params) => {
      cdp.push({ sessionId, method, ...(params === undefined ? {} : { params }) });
      if (method === "Runtime.evaluate") return { result: { objectId: "iframe-object" } };
      if (method === "DOM.describeNode") return { node: { frameId: "child-1" } };
      return {};
    };
    const relay = createInputRelay({
      agentLink,
      send,
      sessionFor: (targetId) =>
        targetId === "tab-1" ? "top-session" : targetId === "child-1" ? "child-session" : undefined,
      isDriver: () => true,
      allowsInput: () => true,
      noteInput: () => {},
      viewportFor: () => ({ w: 640, h: 480 }),
    });

    await expect(relay("driver", { ...pointer("down"), rx: 0, ry: 0 })).resolves.toBe(true);
    await expect(
      relay("driver", { t: "value", tab: "tab-1", nodeId: 43, value: "beta" }),
    ).resolves.toBe(true);
    await expect(
      relay("driver", { t: "scroll", tab: "tab-1", nodeId: 44, x: 3, y: 90 }),
    ).resolves.toBe(true);

    const mouse = cdp.find(({ method }) => method === "Input.dispatchMouseEvent");
    expect(mouse).toMatchObject({
      sessionId: "top-session",
      params: { x: 100.01, y: 60, type: "mousePressed" },
    });
    expect(relay.rectFallbacksFor("tab-1")).toBe(0);
    expect(commands).toContainEqual({
      targetId: "child-1",
      command: { cmd: "rect", nodeId: 7 },
    });
    expect(commands).toContainEqual({
      targetId: "child-1",
      command: { cmd: "value", nodeId: 8, value: "beta" },
    });
    expect(commands).toContainEqual({
      targetId: "child-1",
      command: { cmd: "scroll", nodeId: 9, x: 3, y: 90 },
    });
  });

  it("dispatches in-flight IME composition with the viewer selection", async () => {
    const h = harness();

    await expect(
      h.relay("driver", {
        t: "ime",
        tab: "tab-1",
        text: "にほ",
        selStart: 1,
        selEnd: 2,
      }),
    ).resolves.toBe(true);

    expect(h.cdp).toEqual([
      {
        sessionId: "session-1",
        method: "Input.imeSetComposition",
        params: { text: "にほ", selectionStart: 1, selectionEnd: 2 },
      },
    ]);
    expect(h.notes).toEqual(["tab-1"]);
  });

  it("drops follower, stale-viewport, and unknown-tab input including IME", async () => {
    const follower = harness();
    const stale = harness({ allowed: false });
    const detached = harness({ session: "" });
    // Make this explicit because an empty flat-session id is technically valid to the mock.
    const noSession = createInputRelay({
      agentLink: {
        async *msgs() {},
        async sendCmd() {
          return { reqId: 1, ok: true };
        },
      },
      send: vi.fn(),
      sessionFor: () => undefined,
      isDriver: () => true,
      allowsInput: () => true,
      noteInput: vi.fn(),
      viewportFor: () => ({ w: 1, h: 1 }),
    });

    await expect(follower.relay("viewer", pointer("down"))).resolves.toBe(false);
    await expect(stale.relay("driver", pointer("down"))).resolves.toBe(false);
    await expect(noSession("driver", pointer("down"))).resolves.toBe(false);
    await expect(
      follower.relay("viewer", {
        t: "ime",
        tab: "tab-1",
        text: "x",
        selStart: 0,
        selEnd: 1,
      }),
    ).resolves.toBe(false);
    await expect(
      stale.relay("driver", {
        t: "ime",
        tab: "tab-1",
        text: "x",
        selStart: 0,
        selEnd: 1,
      }),
    ).resolves.toBe(false);
    expect(follower.cdp).toEqual([]);
    expect(stale.cdp).toEqual([]);
    expect(detached.notes).toEqual([]);
  });
});
