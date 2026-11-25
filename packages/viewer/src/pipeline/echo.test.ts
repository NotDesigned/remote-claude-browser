// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";
import { EventPipeline } from "./index";
import { createEchoFilter } from "./echo";

class FakeInput {
  readonly nodeType = 1;
  readonly tagName = "INPUT";
  type = "text";
  getAttribute() {
    return null;
  }
  value = "";
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  selectionDirection: "forward" | "backward" | "none" | null = "none";

  setSelectionRange(start: number, end: number, direction: "forward" | "backward" | "none") {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
}

class FakeContenteditable {
  readonly nodeType = 1;
  readonly tagName = "DIV";
  readonly isContentEditable = true;
  innerHTML = "";
  textContent = "";
  /** Text nodes this editor holds, by rrweb id. */
  readonly children = new Map<number, { textContent: string }>();

  set value(_value: string) {
    throw new Error("contenteditable must never receive a scalar value snap");
  }

  contains(node: unknown): boolean {
    return [...this.children.values()].includes(node as { textContent: string });
  }

  /** The replay's id lookup, as app.tsx wires it from the Replayer's mirror. */
  nodeFor = (id: number) => (this.children.get(id) ?? null) as Node | null;
}

function inputEvent(id: number, text: string, isChecked = false): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: 1,
    data: { source: IncrementalSource.Input, id, text, isChecked },
  } as eventWithTime;
}

function focusEvent(id: number, type: 5 | 6 = 5): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: 1,
    data: { source: IncrementalSource.MouseInteraction, type, id, x: 0, y: 0 },
  } as eventWithTime;
}

function mutationEvent(
  texts: Array<{ id: number; value: string | null }>,
  adds: Array<{
    parentId: number;
    nextId: number | null;
    node: { id: number; type: number; textContent?: string };
  }> = [],
): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: 1,
    data: {
      source: IncrementalSource.Mutation,
      texts,
      attributes: [],
      removes: [],
      adds,
    },
  } as eventWithTime;
}

function removal(parentId: number, id: number): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: 1,
    data: {
      source: IncrementalSource.Mutation,
      texts: [],
      attributes: [],
      removes: [{ parentId, id }],
      adds: [],
    },
  } as eventWithTime;
}

/** Timers the test fires itself. */
function manualTimers() {
  const callbacks: (() => void)[] = [];
  return {
    options: {
      setTimer: ((callback: () => void) => {
        callbacks.push(callback);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimer: (() => {}) as typeof clearTimeout,
    },
    first: () => callbacks[0]!(),
    last: () => callbacks.at(-1)!(),
  };
}

describe("F5 native local typing echo", () => {
  it("keeps a locally typed password through idle, blur and a snapshot, but accepts a remote clear", () => {
    vi.useFakeTimers();
    const echo = createEchoFilter();
    const field = new FakeInput();
    field.type = "password";
    field.value = "Ab9!";
    const focus = { element: field as unknown as HTMLInputElement, nodeId: 41 };
    echo.input(focus);
    expect(echo(inputEvent(41, "****"), { tab: "T1", nowMs: Date.now() })).toBeNull();
    vi.advanceTimersByTime(1500);
    echo.setFocused(null);
    expect(field.value).toBe("Ab9!");
    echo.setFocused(focus);
    expect(echo.restoreHook.capture({} as HTMLIFrameElement)?.value).toBe("Ab9!");
    field.value = "";
    echo.input(focus);
    echo(inputEvent(41, ""), { tab: "T1", nowMs: Date.now() });
    field.value = "New1!";
    echo.input(focus);
    echo(inputEvent(41, "*****"), { tab: "T1", nowMs: Date.now() });
    vi.advanceTimersByTime(1500);
    expect(field.value).toBe("New1!");
    expect(echo(inputEvent(41, ""), { tab: "T1", nowMs: Date.now() })).not.toBeNull();
    echo.reset();
    vi.useRealTimers();
  });
  it("suppresses server input during a native-input burst at simulated 150ms RTT", () => {
    let now = 0;
    const timers: Array<() => void> = [];
    const echo = createEchoFilter({
      now: () => now,
      setTimer: ((callback: () => void) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimer: (() => {}) as typeof clearTimeout,
    });
    const pipeline = new EventPipeline().use(echo).onReset(echo.reset);
    const field = new FakeInput();
    const focus = { element: field as unknown as HTMLInputElement, nodeId: 41 };

    for (const [character, serverValue] of [
      ["a", "a"],
      ["b", "ab"],
      ["c", "abc"],
    ] as const) {
      field.value += character;
      field.selectionStart = field.value.length;
      field.selectionEnd = field.value.length;
      echo.input(focus);
      expect(field.value).toBe(serverValue);
      now += 150;
      expect(pipeline.run(inputEvent(41, serverValue), { tab: "T1", nowMs: now })).toBeNull();
      expect(field.value).toBe(serverValue);
    }

    now = 1_500;
    for (const callback of timers) callback();
    expect(field.value).toBe("abc");
  });

  it("reconciles the authoritative server value on blur and never suppresses checked state", () => {
    let now = 0;
    const echo = createEchoFilter({ now: () => now });
    const field = new FakeInput();
    const focus = { element: field as unknown as HTMLInputElement, nodeId: 7 };
    field.value = "x";
    echo.input(focus);
    now = 150;
    expect(echo(inputEvent(7, "server"), { tab: "T1", nowMs: now })).toBeNull();
    expect(echo(inputEvent(7, "", true), { tab: "T1", nowMs: now })).not.toBeNull();

    echo.setFocused(null);
    expect(field.value).toBe("server");
  });

  it("clears node suppression on pipeline reset", () => {
    const echo = createEchoFilter();
    const pipeline = new EventPipeline().use(echo).onReset(echo.reset);
    const field = new FakeInput();
    field.value = "a";
    echo.input({ element: field as unknown as HTMLInputElement, nodeId: 2 });
    pipeline.reset();
    const event = inputEvent(2, "remote");
    expect(pipeline.run(event, { tab: "T1", nowMs: Date.now() })).toBe(event);
  });

  it("does not arm suppression for a caret-only keydown", () => {
    const echo = createEchoFilter();
    const field = new FakeInput();
    const focus = { element: field as unknown as HTMLInputElement, nodeId: 3 };

    echo.keyDown({ key: "ArrowLeft" } as KeyboardEvent, focus);

    const event = inputEvent(3, "remote");
    expect(echo(event, { tab: "T1", nowMs: Date.now() })).toBe(event);
  });

  it("suppresses delayed focus and blur echoes so native focus remains local", () => {
    const echo = createEchoFilter();

    expect(echo(focusEvent(2), { tab: "T1", nowMs: Date.now() })).toBeNull();
    expect(echo(focusEvent(2, 6), { tab: "T1", nowMs: Date.now() })).toBeNull();
  });

  it("does not replace the submitted text with a delayed echo on Enter", () => {
    let now = 0;
    const echo = createEchoFilter({ now: () => now });
    const field = new FakeInput();
    field.value = "local";
    const focus = { element: field as unknown as HTMLInputElement, nodeId: 4 };
    echo.input(focus);
    now = 100;
    expect(echo(inputEvent(4, "server"), { tab: "T1", nowMs: now })).toBeNull();

    echo.keyDown({ key: "Enter" } as KeyboardEvent, focus);

    expect(field.value).toBe("local");
  });

  it("restores the predicted value through the H3 rebuild hook", () => {
    const echo = createEchoFilter();
    const before = new FakeInput();
    before.value = "a";
    before.selectionStart = 1;
    before.selectionEnd = 1;
    echo.input({ element: before as unknown as HTMLInputElement, nodeId: 9 });
    const snapshot = echo.restoreHook.capture({} as HTMLIFrameElement);
    expect(snapshot).not.toBeNull();
    echo.reset();

    const after = new FakeInput();
    const iframe = {
      contentDocument: { activeElement: after },
    } as unknown as HTMLIFrameElement;
    echo.restoreHook.restore(iframe, snapshot!);

    expect(after.value).toBe("a");
    expect(echo.getFocused()?.nodeId).toBe(9);
    echo.reset();
  });

  it("preserves the caret when an equal-length authoritative value snaps in", () => {
    let now = 0;
    const echo = createEchoFilter({ now: () => now });
    const field = new FakeInput();
    field.value = "local";
    field.selectionStart = 2;
    field.selectionEnd = 2;
    const focus = { element: field as unknown as HTMLInputElement, nodeId: 12 };
    echo.input(focus);
    now = 100;
    expect(echo(inputEvent(12, "SERVER"), { tab: "T1", nowMs: now })).toBeNull();

    echo.setFocused(null);

    expect(field.value).toBe("SERVER");
    expect(field.selectionStart).toBe(2);
    expect(field.selectionEnd).toBe(2);
  });

  it("suppresses only contenteditable subtree mutations during the native-edit window", () => {
    let now = 0;
    const echo = createEchoFilter({ now: () => now });
    const field = new FakeContenteditable();
    field.innerHTML = "local";
    const focus = {
      element: field as unknown as HTMLElement,
      nodeId: 20,
      subtreeNodeIds: new Set([20, 21]),
    };
    echo.setFocused(focus);
    echo.input(focus);

    now = 150;
    const mixed = mutationEvent([
      { id: 21, value: "server echo" },
      { id: 99, value: "unrelated" },
    ]);
    const filtered = echo(mixed, { tab: "T1", nowMs: now });

    expect(filtered).not.toBeNull();
    expect(filtered).not.toBe(mixed);
    expect((filtered!.data as { texts: Array<{ id: number }> }).texts).toEqual([
      { id: 99, value: "unrelated" },
    ]);
    expect(field.innerHTML).toBe("local");

    // Past the window the page's own change shows, even while the editor keeps focus: holding
    // everything back as long as it had focus left a stale editor for good.
    now = 1_001;
    const authoritative = mutationEvent([{ id: 21, value: "authoritative" }]);
    expect(echo(authoritative, { tab: "T1", nowMs: now })).toBe(authoritative);
    echo.setFocused(null);
    expect(echo(authoritative, { tab: "T1", nowMs: now })).toBe(authoritative);
  });

  it("tracks suppressed contenteditable additions and never applies value reconciliation", () => {
    let now = 0;
    const echo = createEchoFilter({ now: () => now });
    const field = new FakeContenteditable();
    field.innerHTML = "<b>local subtree</b>";
    const focus = {
      element: field as unknown as HTMLElement,
      nodeId: 30,
      subtreeNodeIds: new Set([30]),
    };
    echo.setFocused(focus);
    echo.input(focus);

    now = 100;
    expect(
      echo(
        mutationEvent(
          [{ id: 31, value: "same-batch server" }],
          [{ parentId: 30, nextId: null, node: { id: 31, type: 3, textContent: "server" } }],
        ),
        { tab: "T1", nowMs: now },
      ),
    ).toBeNull();
    expect(
      echo(mutationEvent([{ id: 31, value: "server 2" }]), { tab: "T1", nowMs: now }),
    ).toBeNull();

    expect(echo.restoreHook.capture({} as HTMLIFrameElement)).toBeNull();
    echo.setFocused(null);
    expect(field.innerHTML).toBe("<b>local subtree</b>");
  });
  it("lets a clear after the window through, where it applies, without a reconcile", () => {
    let time = 0;
    const reconcile = vi.fn();
    const field = new FakeContenteditable();
    const echo = createEchoFilter({
      now: () => time,
      onContenteditableReconcile: reconcile,
      nodeFor: field.nodeFor,
    });
    field.textContent = "已经发送的问题";
    field.children.set(22, { textContent: "已经发送的问题" });
    const focus = {
      element: field as unknown as HTMLElement,
      nodeId: 20,
      subtreeNodeIds: new Set([20, 21, 22]),
    };
    echo.input(focus);
    time = 2000;
    const clear = mutationEvent([{ id: 22, value: "" }]);
    expect(echo(clear, { nowMs: time } as never)).toBe(clear);
    expect(reconcile).not.toHaveBeenCalled();
    echo.reset();
  });

  it("reconciles when the page changes a node whose addition the echo kept from this replay", () => {
    let time = 0;
    const timers = manualTimers();
    const reconcile = vi.fn();
    const field = new FakeContenteditable();
    const echo = createEchoFilter({
      now: () => time,
      onContenteditableReconcile: reconcile,
      nodeFor: field.nodeFor,
      ...timers.options,
    });
    const focus = {
      element: field as unknown as HTMLElement,
      nodeId: 20,
      subtreeNodeIds: new Set([20]),
    };
    // Typing "hello": the page adds text node 31, which this replay never gets.
    field.textContent = "hello";
    echo.setFocused(focus);
    echo.input(focus);
    time = 80;
    const echoed = mutationEvent(
      [{ id: 31, value: "hello" }],
      [{ parentId: 20, nextId: null, node: { id: 31, type: 3, textContent: "h" } }],
    );
    expect(echo(echoed, { nowMs: time } as never)).toBeNull();
    // Settled: the page holds exactly what was typed here.
    time = 1_000;
    timers.last();
    expect(reconcile).not.toHaveBeenCalled();

    // Sent: the page clears its editor by removing node 31, which this replay cannot do.
    time = 3_000;
    const cleared = removal(20, 31);
    expect(echo(cleared, { nowMs: time } as never)).toBe(cleared);
    expect(reconcile).toHaveBeenCalledOnce();
    // Once until the rebuild that answers it.
    echo(cleared, { nowMs: time } as never);
    expect(reconcile).toHaveBeenCalledOnce();
    echo.reset();
    echo(cleared, { nowMs: time } as never);
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("reconciles when typing settles on text the page has and this replay lacks", () => {
    let time = 0;
    const timers = manualTimers();
    const reconcile = vi.fn();
    const field = new FakeContenteditable();
    const echo = createEchoFilter({
      now: () => time,
      onContenteditableReconcile: reconcile,
      nodeFor: field.nodeFor,
      ...timers.options,
    });
    const focus = {
      element: field as unknown as HTMLElement,
      nodeId: 20,
      subtreeNodeIds: new Set([20]),
    };
    field.textContent = "hel";
    echo.setFocused(focus);
    echo.input(focus);
    time = 100;
    // The page's editor completed the word on its own.
    echo(
      mutationEvent(
        [],
        [{ parentId: 20, nextId: null, node: { id: 31, type: 3, textContent: "hello world" } }],
      ),
      { nowMs: time } as never,
    );
    expect(reconcile).not.toHaveBeenCalled();
    // Leaving the editor mid-burst waits for the window to end.
    echo.setFocused(null);
    expect(reconcile).not.toHaveBeenCalled();
    time = 1_000;
    timers.last();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("does not move the caret for an echo that arrives after its window", () => {
    let time = 0;
    const field = new FakeContenteditable();
    const echo = createEchoFilter({ now: () => time, nodeFor: field.nodeFor });
    field.children.set(21, { textContent: "typed" });
    field.textContent = "typed";
    const focus = {
      element: field as unknown as HTMLElement,
      nodeId: 20,
      subtreeNodeIds: new Set([20, 21]),
    };
    echo.setFocused(focus);
    echo.input(focus);
    time = 1_500;
    expect(echo(mutationEvent([{ id: 21, value: "typed" }]), { nowMs: time } as never)).toBeNull();
    const changed = mutationEvent([{ id: 21, value: "typed!" }]);
    expect(echo(changed, { nowMs: time } as never)).toBe(changed);
    // That change may still wait in the replay buffer: an equal one right after must apply.
    const back = mutationEvent([{ id: 21, value: "typed" }]);
    expect(echo(back, { nowMs: time + 10 } as never)).toBe(back);
  });

  it("keeps new typing protected until the reconciliation window ends", () => {
    let time = 0;
    const timers = manualTimers();
    const reconcile = vi.fn();
    const field = new FakeContenteditable();
    const echo = createEchoFilter({
      now: () => time,
      onContenteditableReconcile: reconcile,
      nodeFor: field.nodeFor,
      ...timers.options,
    });
    field.textContent = "问题一";
    field.children.set(22, { textContent: "问题一" });
    const focus = {
      element: field as unknown as HTMLElement,
      nodeId: 20,
      subtreeNodeIds: new Set([20, 21, 22]),
    };
    echo.input(focus);
    time = 100;
    // The page cleared the sent question; this replay still shows it.
    expect(echo(mutationEvent([{ id: 22, value: "" }]), { nowMs: time } as never)).toBeNull();
    time = 500;
    field.textContent = "问题一下一条问题";
    echo.input(focus);
    time = 1100;
    timers.first();
    expect(reconcile).not.toHaveBeenCalled();
    time = 1500;
    timers.last();
    expect(reconcile).toHaveBeenCalledOnce();
    echo.reset();
  });

  it("asks for nothing when the page and this replay both emptied the editor", () => {
    let time = 0;
    const timers = manualTimers();
    const reconcile = vi.fn();
    const field = new FakeContenteditable();
    const echo = createEchoFilter({
      now: () => time,
      onContenteditableReconcile: reconcile,
      nodeFor: field.nodeFor,
      ...timers.options,
    });
    field.children.set(22, { textContent: "" });
    const focus = {
      element: field as unknown as HTMLElement,
      nodeId: 20,
      subtreeNodeIds: new Set([20, 22]),
    };
    echo.input(focus);
    time = 100;
    echo(mutationEvent([{ id: 22, value: "" }]), { nowMs: time } as never);
    time = 1_000;
    timers.last();
    expect(reconcile).not.toHaveBeenCalled();
  });
});
