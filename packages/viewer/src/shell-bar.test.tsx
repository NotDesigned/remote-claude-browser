// @vitest-environment node
import type { ComponentChildren, VNode } from "preact";
import { describe, expect, it, vi } from "vitest";
import { describeConnection } from "./connection-status";
import { Diagnostics, type DiagnosticsProps } from "./hud";
import { ConnectionDetails, type ConnectionDetailsProps } from "./shell-bar";

type TestVNode = VNode<Record<string, unknown>>;

function descendants(root: VNode): TestVNode[] {
  const result: TestVNode[] = [];
  const visit = (value: ComponentChildren): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
    } else if (value !== null && typeof value === "object" && "props" in value) {
      const node = value as TestVNode;
      result.push(node);
      visit(node.props.children as ComponentChildren);
    }
  };
  visit(root.props.children as ComponentChildren);
  return result;
}

function textContent(value: ComponentChildren): string {
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (typeof value === "object" && "props" in value) {
    return textContent((value as TestVNode).props.children as ComponentChildren);
  }
  return String(value);
}

const ready = { clientPhase: "ready", inputUnsynced: false, inputReady: true } as const;
const status = (change: Partial<Parameters<typeof describeConnection>[0]> = {}) =>
  describeConnection({ ...ready, connection: "open", ...change });

const diagnostics: DiagnosticsProps = {
  connection: "open",
  rttMs: 42,
  bufferMs: 90,
  activeTab: "tab-a",
  tabs: [],
  modeByTab: {},
  resyncByTab: {
    "tab-a": {
      tab: "tab-a",
      totalResyncs: 5,
      recentResyncs: 4,
      pending: false,
      backoffMs: 0,
      storm: true,
    },
  },
  speedBps: 2048,
  peakSpeedBps: 4096,
};

const details = (change: Partial<ConnectionDetailsProps> = {}) => {
  const tree = ConnectionDetails({
    status: status(),
    warning: null,
    clock: null,
    rttMs: 42.4,
    speedBps: 2048,
    frameRate: null,
    ...change,
  });
  return { tree, text: textContent(tree), nodes: descendants(tree) };
};
const buttons = (nodes: TestVNode[]) =>
  nodes.filter((node) => node.type === "button").map((node) => textContent(node));

describe("connection status", () => {
  it("names each state with its reason", () => {
    expect(status()).toMatchObject({ kind: "connected", text: "已连接", tone: "ok" });
    expect(status({ inputReady: false })).toMatchObject({ text: "同步中", tone: "busy" });
    expect(status({ inputUnsynced: true })).toEqual({
      kind: "input-unsynced",
      text: "输入未同步",
      tone: "bad",
      reason: "最近一次输入没有同步到页面，回车和点击暂时不会发送。",
    });
    expect(status({ connection: "connecting" })).toMatchObject({ text: "连接中", tone: "busy" });
    expect(status({ connection: "closed" })).toMatchObject({
      kind: "reconnecting",
      text: "重新连接中",
      tone: "busy",
    });
    expect(status({ clientPhase: "starting" })).toMatchObject({ text: "连接中", tone: "busy" });
    expect(status({ clientPhase: "replaced" }).text).toBe("已由另一页面接管");
    expect(status({ clientPhase: "closed" }).text).toBe("已结束");
    expect(status({ clientPhase: "ending" }).text).toBe("结束中");
    expect(status({ clientPhase: "error" })).toMatchObject({ text: "未连接", tone: "bad" });
    for (const phase of ["replaced", "closed", "ending", "error", "starting"] as const)
      expect(status({ clientPhase: phase }).reason).not.toBe("");
  });

  it("puts a lost connection ahead of an unsynchronised input", () => {
    expect(status({ connection: "closed", inputUnsynced: true }).kind).toBe("reconnecting");
  });
});

describe("the 「连接」 popover", () => {
  it("says the state, latency and speed, and leaves frame rate out of the page view", () => {
    const { text, nodes } = details();
    expect(text).toContain("已连接");
    expect(text).toContain("页面已同步");
    expect(text).toContain("延迟42 ms");
    expect(text).toContain("速度2 KB/s");
    expect(text).not.toContain("帧率");
    expect(buttons(nodes)).toEqual([]);
  });

  it("shows the frame rate when there is one", () => {
    expect(details({ frameRate: 24 }).text).toContain("帧率24 fps");
  });

  it("offers 「重新同步」 only while input is unsynchronised and the app can resync", () => {
    const onResyncInput = vi.fn();
    const unsynced = status({ inputUnsynced: true });
    expect(buttons(details({ status: unsynced }).nodes)).toEqual([]);
    const { nodes, text } = details({ status: unsynced, onResyncInput });
    expect(text).toContain("回车和点击暂时不会发送");
    expect(buttons(nodes)).toEqual(["重新同步"]);
    (nodes.find((node) => node.type === "button")!.props.onClick as () => void)();
    expect(onResyncInput).toHaveBeenCalledOnce();
    expect(buttons(details({ onResyncInput }).nodes)).toEqual([]);
  });

  it("offers 「重新连接」 only while the connection is down", () => {
    const onReconnect = vi.fn();
    expect(buttons(details({ onReconnect }).nodes)).toEqual([]);
    for (const connection of ["closed", "connecting"] as const) {
      const { nodes, text } = details({ status: status({ connection }), onReconnect });
      expect(buttons(nodes)).toEqual(["重新连接"]);
      // Numbers from before the drop would mislead.
      expect(text).not.toContain("延迟");
    }
    expect(
      buttons(details({ status: status({ clientPhase: "replaced" }), onReconnect }).nodes),
    ).toEqual([]);
  });

  it("shows the resource warning and the resync storm, but no server-wide numbers", () => {
    const { text } = details({
      warning: "服务器内存紧张，新建会话可能失败；已打开的会话不受影响。",
      diagnostics,
    });
    expect(text).toContain("服务器内存紧张");
    expect(text).toContain("近期有 1 个页面频繁重新同步");
    for (const gone of ["在线设备", "会话数", "CPU", "整机内存", "服务内存"])
      expect(text).not.toContain(gone);
  });

  it("puts the exit's place, local time and zone on separate lines under 「出口」", () => {
    const { nodes } = details({
      profileName: "工作",
      clock: {
        label: "Los Angeles · 08:47",
        title: "",
        place: "Los Angeles，United States",
        dateTime: "2026-11-25 周三 08:47",
        zone: "America/Los_Angeles（GMT-8）",
      },
    });
    const exit = nodes.find((node) => node.props["aria-label"] === "出口")!;
    expect(textContent(descendants(exit).find((node) => node.type === "h3")!)).toBe("出口工作");
    const rows = descendants(exit)
      .filter((node) => node.type === "div")
      .map((node) => textContent(node));
    expect(rows).toEqual([
      "位置Los Angeles，United States",
      "当地时间2026-11-25 周三 08:47",
      "时区America/Los_Angeles（GMT-8）",
    ]);
  });

  it("folds the diagnostics into a closed 「诊断」 section", () => {
    const { nodes } = details({ diagnostics });
    const section = nodes.find((node) => (node.type as unknown) === Diagnostics);
    expect(section?.props).toMatchObject({ rttMs: 42, bufferMs: 90 });
    expect(Diagnostics(diagnostics).props.open).toBeUndefined();
    expect(details().nodes.some((node) => (node.type as unknown) === Diagnostics)).toBe(false);
  });
});
