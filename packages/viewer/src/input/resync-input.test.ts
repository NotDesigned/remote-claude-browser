// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Up } from "@mirror/protocol";
import { createInputResync, focusedValueMessage } from "./resync-input";

function timers() {
  let now = 0;
  const tasks = new Map<number, { run: () => void; at: number }>();
  let next = 1;
  return {
    setTimer: ((run: () => void, delay = 0) => {
      tasks.set(next, { run, at: now + delay });
      return next++;
    }) as unknown as typeof setTimeout,
    clearTimer: ((id: number) => tasks.delete(id)) as unknown as typeof clearTimeout,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...tasks]
          .filter(([, task]) => task.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        tasks.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
    },
  };
}

const value = (text: string): Extract<Up, { t: "value" }> => ({
  t: "value",
  tab: "T1",
  nodeId: 7,
  value: text,
  commit: false,
});

describe("input resync", () => {
  it("re-sends the focused field twice with backoff after a failure", () => {
    const clock = timers();
    const sent: Up[] = [];
    const resync = createInputResync({
      valueFor: () => value("hello"),
      send: (message) => sent.push(message),
      retryDelaysMs: [400, 1500],
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    resync.status("T1", true);
    resync.status("T1", true);
    clock.advance(399);
    expect(sent).toEqual([]);
    clock.advance(1);
    expect(sent).toEqual([value("hello")]);
    clock.advance(1500);
    expect(sent).toHaveLength(2);
    clock.advance(10_000);
    expect(sent).toHaveLength(2);
  });

  it("stops retrying once the gateway reports success, and starts afresh on a new failure", () => {
    const clock = timers();
    const send = vi.fn();
    const resync = createInputResync({
      valueFor: () => value("x"),
      send,
      retryDelaysMs: [400, 1500],
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    resync.status("T1", true);
    clock.advance(400);
    resync.status("T1", false);
    clock.advance(5000);
    expect(send).toHaveBeenCalledTimes(1);
    resync.status("T1", true);
    clock.advance(400);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("offers a manual resync that says whether anything could be sent", () => {
    const send = vi.fn();
    let focused: ReturnType<typeof value> | null = null;
    const resync = createInputResync({ valueFor: () => focused, send });
    expect(resync.resync("T1")).toBe(false);
    focused = value("again");
    expect(resync.resync("T1")).toBe(true);
    expect(send).toHaveBeenCalledWith(value("again"));
    resync.dispose();
  });

  it("reads the focused text field, with its selection, but never a password", () => {
    const field = {
      tagName: "INPUT",
      type: "text",
      value: "abc",
      selectionStart: 1,
      selectionEnd: 2,
      isContentEditable: false,
      getAttribute: () => null,
      parentElement: null,
    };
    const doc = { activeElement: field } as unknown as Document;
    expect(focusedValueMessage(doc, "T1", () => 3)).toEqual({
      t: "value",
      tab: "T1",
      nodeId: 3,
      value: "abc",
      commit: false,
      selectionStart: 1,
      selectionEnd: 2,
    });
    field.type = "password";
    expect(focusedValueMessage(doc, "T1", () => 3)).toBeNull();
  });
});

describe("input resync driven by acks", () => {
  it("sends a refused value again once, at once, and retries nothing on a timer", () => {
    const clock = timers();
    const sent: Up[] = [];
    const resync = createInputResync({
      valueFor: () => value("hello"),
      send: (message) => sent.push(message),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      ackMode: () => true,
    });
    resync.status("T1", true);
    clock.advance(10_000);
    expect(sent).toEqual([]);
    // An ack without a refused value: wait for the next one.
    resync.settled("T1", false);
    expect(sent).toEqual([]);
    resync.settled("T1", true);
    expect(sent).toEqual([value("hello")]);
    // Refused again in the same episode: that is for the person to retry.
    resync.settled("T1", true);
    expect(sent).toHaveLength(1);
    // Synced again: a later refusal is sent again once more.
    resync.status("T1", false);
    resync.settled("T1", true);
    expect(sent).toHaveLength(2);
  });

  it("ignores acks without ack mode", () => {
    const sent: Up[] = [];
    const resync = createInputResync({
      valueFor: () => value("hello"),
      send: (message) => sent.push(message),
      ackMode: () => false,
    });
    resync.settled("T1", true);
    expect(sent).toEqual([]);
  });
});
