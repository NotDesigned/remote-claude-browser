// @vitest-environment node
import type { ComponentChildren, VNode } from "preact";
import { describe, expect, it } from "vitest";
import { Diagnostics, formatSpeed, resyncStormTabs, type DiagnosticsProps } from "./hud";

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

const props: DiagnosticsProps = {
  connection: "open",
  rttMs: 42.4,
  bufferMs: 93,
  activeTab: "tab-b",
  tabs: [
    { id: "tab-a", title: "First", url: "https://first.test/", active: false },
    { id: "tab-b", title: "Second", url: "https://second.test/", active: true },
  ],
  modeByTab: { "tab-a": "dom", "tab-b": "px" },
  resyncByTab: {
    "tab-a": {
      tab: "tab-a",
      totalResyncs: 2,
      recentResyncs: 1,
      pending: false,
      backoffMs: 0,
      storm: false,
    },
    "tab-b": {
      tab: "tab-b",
      totalResyncs: 4,
      recentResyncs: 3,
      pending: false,
      backoffMs: 0,
      storm: true,
    },
  },
  speedBps: 2048,
  peakSpeedBps: 3 * 1024 * 1024,
};

describe("frame rates", () => {
  const frames = { capture: 15, encode: 14, drop: 1, display: 13 };
  const pixelProps = {
    ...props,
    activeTab: "tab-1",
    modeByTab: { "tab-1": "px" as const },
    frames,
  };

  it("shows every stage in the pixel view", () => {
    const text = textContent(Diagnostics(pixelProps));
    expect(text).toContain("13 fps");
    expect(text).toContain("采集帧率15 fps");
    expect(text).toContain("编码帧率14 fps");
    expect(text).toContain("丢弃帧率1 fps");
  });

  it("stays out of the page view", () => {
    expect(textContent(Diagnostics({ ...props, modeByTab: {}, frames }))).not.toContain("fps");
  });
});

describe("formatSpeed", () => {
  it("picks a readable unit", () => {
    expect(formatSpeed(null)).toBe("—");
    expect(formatSpeed(500)).toBe("500 B/s");
    expect(formatSpeed(1536)).toBe("2 KB/s");
    expect(formatSpeed(1.5 * 1024 * 1024)).toBe("1.5 MB/s");
  });
});

describe("diagnostics", () => {
  it("renders Chinese connection diagnostics while preserving RTT and resync attributes", () => {
    const tree = Diagnostics({ ...props, activeTab: "tab-a" });
    const nodes = descendants(tree);
    const allText = textContent(tree);

    expect(tree.type).toBe("details");
    expect(tree.props.open).toBeUndefined();
    expect(tree.props).toMatchObject({
      id: "resync-hud",
      "data-connection": "open",
      "data-rtt-ms": "42",
      "data-resync-total": "6",
      "data-resync-storm": "true",
      "data-resync-storm-tabs": "tab-b",
    });
    const summary = nodes.find((node) => node.type === "summary");
    expect(textContent(summary?.props.children as ComponentChildren)).toBe("诊断同步较多");
    expect(allText).toContain("连接状态已连接");
    expect(allText).toContain("网络往返 RTT42 ms");
    expect(allText).toContain("DOM 回放缓冲93 ms");
    expect(allText).toContain("当前速度2 KB/s");
    expect(allText).toContain("最高速度3.0 MB/s");
    expect(allText).toContain("页面重新同步6 次");
    expect(allText).toContain("First文字 DOM2 次同步");
    expect(allText).toContain("Second图像4 次同步");
    expect(nodes.some((node) => node.type === "iframe")).toBe(false);
  });

  it("marks the DOM replay buffer unused in pixel mode", () => {
    const allText = textContent(Diagnostics(props));
    expect(allText).toContain("DOM 回放缓冲图像模式不使用");
    expect(allText).not.toContain("93 ms");
  });

  it("names the tabs that re-synchronised often", () => {
    expect(resyncStormTabs(props.resyncByTab)).toEqual(["tab-b"]);
    expect(resyncStormTabs({})).toEqual([]);
    const calm = Diagnostics({ ...props, resyncByTab: {} });
    expect(calm.props["data-resync-storm"]).toBe("false");
    expect(textContent(calm)).not.toContain("同步较多");
  });
});
