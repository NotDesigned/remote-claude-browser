import { afterEach, describe, expect, it, vi } from "vitest";
import { EventType, type Down, type Up } from "@mirror/protocol";
import type { Mirror } from "./mirror";
import { createPresentation } from "./presentation";

function snapshot(tab = "a", w = 1280, h = 800): Extract<Down, { t: "snapshot" }> {
  return {
    t: "snapshot",
    tab,
    epoch: 2,
    seq: 3,
    reason: "viewport",
    data: [
      {
        type: EventType.Meta,
        timestamp: 1,
        data: { href: "https://fixture.test", width: w, height: h },
      },
    ],
  };
}

function tabs(active: string): Down {
  return {
    t: "tabs",
    tabs: ["a", "b"].map((id) => ({ id, active: id === active, title: id, url: "" })),
  };
}

function fixture(entryTab: string | null = null) {
  vi.useFakeTimers();
  const host = {
    clientWidth: 1280,
    clientHeight: 800,
    inert: false,
    ownerDocument: { defaultView: { devicePixelRatio: 1 } },
  };
  const mirror = {
    handle: vi.fn(),
    recover: vi.fn(),
    connectionLost: vi.fn(),
    connectionRestored: vi.fn(),
    resumeCursor: vi.fn<Mirror["resumeCursor"]>(() => ({ tab: "a", epoch: 2, nextSeq: 4 })),
    selectTab: vi.fn(),
    getActiveTab: () => "a",
    getIframe: () => null,
    getReplayer: () => null,
    observeRtt: vi.fn(),
    refreshViewportLayout: vi.fn(),
    keepTabs: vi.fn(),
    teardown: vi.fn(),
  } satisfies Mirror;
  const send = vi.fn<(message: Up) => void>();
  const controller = createPresentation({
    host: host as unknown as HTMLElement,
    mirror,
    send,
    entryTab,
    entryMode: entryTab === null ? null : "dom",
    preferredQuality: () => "balanced",
    onTab: vi.fn(),
    onTabMode: vi.fn(),
    onViewMode: vi.fn(),
    onInputReady: vi.fn(),
    onPaint: vi.fn(),
  });
  const hello = (role: "driver" | "viewer" = "driver", resumed?: string[]) =>
    controller.handle({ t: "hello", viewerId: "me", role, sessionId: "fixture", resumed });
  controller.connectionChanged("open", false);
  hello();
  controller.handle(tabs("a"));
  vi.runOnlyPendingTimers();
  const sent = () => send.mock.calls.map(([message]) => message);
  return { host, mirror, controller, send, hello, sent };
}

afterEach(() => vi.useRealTimers());

describe("viewer presentation", () => {
  it("fits an oversized desktop layout and unlocks input at the fitted geometry", () => {
    const { controller, host, send } = fixture();
    host.clientWidth = 3200;
    host.clientHeight = 1800;
    send.mockClear();
    controller.handle({
      t: "hello",
      viewerId: "me",
      role: "driver",
      sessionId: "fixture",
      viewportLimit: { width: 1920, height: 1080 },
    });
    vi.runOnlyPendingTimers();
    expect(send).toHaveBeenCalledExactlyOnceWith({ t: "view", tab: "a", w: 1920, h: 1080, dpr: 1 });
    controller.snapshotApplied(snapshot("a", 1920, 1080));
    expect(controller.canInput("a", "dom")).toBe(true);
    send.mockClear();
    host.clientWidth = 3840;
    host.clientHeight = 2160;
    controller.resized();
    vi.runOnlyPendingTimers();
    expect(send).not.toHaveBeenCalled();
    expect(controller.canInput("a", "dom")).toBe(true);
  });

  it("blocks input during a tab change and negotiates again on a quick return", () => {
    const { controller, sent, host } = fixture();
    controller.snapshotApplied(snapshot());
    expect(controller.canInput("a", "dom")).toBe(true);

    controller.activate("b");
    expect(host.inert).toBe(true);
    controller.handle(tabs("a")); // Arrived before the gateway processed the activation.
    expect(controller.activeTab()).toBe("b");
    controller.activate("a");
    vi.runOnlyPendingTimers();

    expect(
      sent()
        .filter((m) => m.t === "view")
        .map((m) => m.tab),
    ).toEqual(["a", "a"]);
    controller.handle({ t: "view-ok", tab: "b", w: 1280, h: 800 });
    expect(controller.canInput("a", "dom")).toBe(false);
    controller.handle({ t: "view-ok", tab: "a", w: 1280, h: 800 });
    expect(controller.canInput("a", "dom")).toBe(true);
  });

  it("uses pixel snapshots only for geometry and gates delayed input to the owning mode", () => {
    const { controller, mirror, host, sent } = fixture();
    controller.handle({ t: "mode", tab: "a", mode: "px" });
    mirror.handle.mockClear();
    controller.handle(snapshot("b"));
    controller.handle(snapshot("a", 900, 650));
    expect(host.inert).toBe(true);
    controller.handle(snapshot());
    expect(mirror.handle).not.toHaveBeenCalled();
    expect(sent().at(-1)).toEqual({ t: "view-ack", tab: "a", epoch: 2 });
    expect(controller.canInput("a", "px")).toBe(true);
    expect(controller.canInput("a", "dom")).toBe(false);

    controller.handle({ t: "mode", tab: "a", mode: "dom" });
    controller.handle(snapshot());
    expect(mirror.handle).toHaveBeenCalledExactlyOnceWith(snapshot());
  });

  it("reuses matching geometry after a DOM resume and renegotiates after a resize or fresh join", () => {
    const { controller, mirror, host, hello, send } = fixture();
    controller.snapshotApplied(snapshot());
    send.mockClear();
    controller.connectionChanged("closed", true);
    expect(controller.canInput("a", "dom")).toBe(false);
    expect(controller.resumeParam()).not.toBeNull();
    controller.connectionChanged("open", true);
    hello("driver", ["a"]);
    vi.runOnlyPendingTimers();
    expect(controller.canInput("a", "dom")).toBe(true);
    expect(mirror.connectionRestored).toHaveBeenLastCalledWith(true);
    expect(send).not.toHaveBeenCalled();

    controller.connectionChanged("closed", true);
    host.clientWidth = 900;
    controller.connectionChanged("open", true);
    hello("driver", ["a"]);
    expect(controller.canInput("a", "dom")).toBe(false);
    vi.runOnlyPendingTimers();
    expect(send).toHaveBeenCalledExactlyOnceWith({ t: "view", tab: "a", w: 900, h: 800, dpr: 1 });

    send.mockClear();
    controller.connectionChanged("closed", true);
    controller.connectionChanged("open", true);
    hello();
    vi.runOnlyPendingTimers();
    expect(mirror.connectionRestored).toHaveBeenLastCalledWith(false);
    expect(controller.canInput("a", "dom")).toBe(false);
    expect(send).toHaveBeenCalledExactlyOnceWith({ t: "view", tab: "a", w: 900, h: 800, dpr: 1 });
  });

  it("consumes the entry tab once and follows the server's current tab after reconnect", () => {
    const { controller, hello, send, sent } = fixture("b");
    expect(sent()[0]).toEqual({ t: "nav", tab: "b", action: "activate" });
    send.mockClear();
    controller.handle({ t: "mode", tab: "b", mode: "dom" });
    controller.connectionChanged("closed", true);
    controller.connectionChanged("open", true);
    hello("viewer");
    controller.handle(tabs("a"));
    vi.runOnlyPendingTimers();
    expect(controller.activeTab()).toBe("a");
    expect(controller.canInput("a", "dom")).toBe(false);
    expect(sent().some((m) => m.t === "nav" || m.t === "view")).toBe(false);
  });
});
