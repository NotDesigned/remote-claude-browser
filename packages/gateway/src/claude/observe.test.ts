import { describe, expect, it, vi } from "vitest";
import type { BrowserHandle } from "../browser/launch";
import { observeChat } from "./observe";

describe("native chat DOM invalidations", () => {
  it("accepts only its private binding and removes observers when the lease ends", async () => {
    const listeners = new Map<string, (session: string, event: any) => void>();
    const send = vi.fn(
      async (_session: string, method: string, _params?: Record<string, unknown>) => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 42 };
        return {};
      },
    );
    const browser = {
      send,
      onSessionEvent(method: string, callback: (session: string, event: any) => void) {
        listeners.set(method, callback);
        return () => listeners.delete(method);
      },
    } as unknown as BrowserHandle;
    const changed = vi.fn();
    const observer = observeChat(
      browser,
      { targetId: "tab", sessionId: "cdp-one", type: "page" },
      changed,
      (error) => {
        throw error;
      },
    );
    await vi.waitFor(() => expect(observer.available()).toBe(true));
    const binding = send.mock.calls.find((call) => call[1] === "Runtime.addBinding")![2]!.name;
    const event = { name: binding, executionContextId: 42, payload: "https://claude.ai/new" };
    changed.mockClear();
    listeners.get("Runtime.bindingCalled")!("another-client", event);
    listeners.get("Runtime.bindingCalled")!("cdp-one", { ...event, executionContextId: 99 });
    expect(changed).not.toHaveBeenCalled();
    listeners.get("Runtime.bindingCalled")!("cdp-one", event);
    expect(changed).toHaveBeenCalledOnce();
    observer.close();
    expect(listeners.size).toBe(0);
    expect(send.mock.calls.some((call) => call[1] === "Runtime.removeBinding")).toBe(true);
  });
});
