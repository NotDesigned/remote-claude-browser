import { describe, expect, it, vi } from "vitest";

import { callFrameAgent, ensureAgentBridgeChannel } from "./bridge";
import type { BrowserHandle } from "./launch";

function browserWith(send: (method: string, params: Record<string, unknown>) => unknown) {
  return {
    onDetached: vi.fn(),
    send: vi.fn(async (_session: string, method: string, params: Record<string, unknown>) =>
      send(method, params),
    ),
  } as unknown as BrowserHandle;
}

describe("calling a frame's agent", () => {
  it("opens one private world per frame and uses it again", async () => {
    let worlds = 100;
    const opened: unknown[] = [];
    const used: unknown[] = [];
    const browser = browserWith((method, params) => {
      if (method === "Page.createIsolatedWorld") {
        opened.push(params.frameId);
        return { executionContextId: ++worlds };
      }
      used.push(params.contextId);
      return { result: {} };
    });

    await callFrameAgent(browser, "session", "frame-a", "command", [{ cmd: "ping" }]);
    await callFrameAgent(browser, "session", "frame-a", "command", [{ cmd: "ping" }]);
    await callFrameAgent(browser, "session", "frame-b", "command", [{ cmd: "ping" }]);

    expect(opened).toEqual(["frame-a", "frame-b"]);
    expect(used).toEqual([101, 101, 102]);
  });

  it("opens a new world when a navigation has taken the old one", async () => {
    let worlds = 0;
    let failing = false;
    const browser = browserWith((method) => {
      if (method === "Page.createIsolatedWorld") return { executionContextId: ++worlds };
      if (failing) {
        failing = false;
        throw new Error("Cannot find context with specified id");
      }
      return { result: {} };
    });

    await callFrameAgent(browser, "session", "frame", "command", [{ cmd: "ping" }]);
    failing = true;
    await expect(
      callFrameAgent(browser, "session", "frame", "command", [{ cmd: "ping" }]),
    ).resolves.toEqual({ result: {} });
    expect(worlds).toBe(2);
  });

  it("sends a command through the channel's private event, whatever it contains", async () => {
    let expression = "";
    const browser = browserWith((method, params) => {
      if (method === "Runtime.evaluate") expression = params.expression as string;
      return { executionContextId: 1, result: {} };
    });
    const channel = ensureAgentBridgeChannel(browser, "session");
    const cmd = { cmd: "value", value: '"</x>\\' };

    await callFrameAgent(browser, "session", "frame", "command", [cmd]);

    const heard: { name: string; detail: string }[] = [];
    class FakeEvent {
      constructor(
        readonly name: string,
        readonly init: { detail: string },
      ) {}
    }
    new Function("document", "CustomEvent", expression)(
      {
        dispatchEvent: (event: FakeEvent) =>
          heard.push({ name: event.name, detail: event.init.detail }),
      },
      FakeEvent,
    );
    expect(heard[0]?.name).toBe(channel.inboundEventName);
    expect(JSON.parse(heard[0]!.detail)).toEqual({ method: "command", args: [cmd] });
  });
});
