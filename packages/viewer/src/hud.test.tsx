// @vitest-environment node
import type { ComponentChildren, VNode } from "preact";
import { describe, expect, it } from "vitest";
import { Hud, HudLayer, formatSpeed, type HudProps } from "./hud";

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

const props: HudProps = {
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

describe("formatSpeed", () => {
  it("picks a readable unit", () => {
    expect(formatSpeed(null)).toBe("—");
    expect(formatSpeed(500)).toBe("500 B/s");
    expect(formatSpeed(1536)).toBe("2 KB/s");
    expect(formatSpeed(1.5 * 1024 * 1024)).toBe("1.5 MB/s");
  });
});

describe("P3-HUD", () => {
  it("renders Chinese connection diagnostics while preserving RTT and resync attributes", () => {
    const tree = Hud({ ...props, activeTab: "tab-a" });
    const nodes = descendants(tree);
    const allText = textContent(tree);

    expect(tree.type).toBe("details");
    expect(tree.props).toMatchObject({
      id: "resync-hud",
      "data-connection": "open",
      "data-rtt-ms": "42",
      "data-resync-total": "6",
      "data-resync-storm": "true",
      "data-resync-storm-tabs": "tab-b",
    });
    expect(allText).toContain("RTT 42 ms");
    expect(allText).toContain("DOM 回放缓冲");
    expect(allText).toContain("93 ms");
    const summary = nodes.find((node) => node.type === "summary");
    expect(summary?.props.title).toBe(
      "网络往返延迟（RTT）和当前下载速度。延迟不包含页面处理、回放缓冲和图像绘制耗时",
    );
    expect(allText).toContain("已连接");
    expect(allText).not.toContain("操作权限");
    expect(allText).toContain("当前速度2 KB/s");
    expect(allText).toContain("最高速度3.0 MB/s");
    expect(allText).toContain("RTT 42 ms · 2 KB/s");
    expect(allText).toContain("First文字 DOM2 次同步");
    expect(allText).toContain("Second图像4 次同步");
    expect(allText).toContain("个页面频繁重新同步");
    expect(nodes.some((node) => node.type === "iframe")).toBe(false);
  });

  it("marks the DOM replay buffer unused in pixel mode", () => {
    const tree = Hud(props);
    const allText = textContent(tree);
    expect(tree.props["data-rtt-ms"]).toBe("42");
    expect(allText).toContain("RTT 42 ms");
    expect(allText).toContain("DOM 回放缓冲图像模式不使用");
    expect(allText).not.toContain("93 ms");
  });

  it("mounts in a dedicated toggleable layer outside the mirror document", () => {
    const layer = HudLayer(props);
    expect(layer.type).toBe("aside");
    expect(layer.props.id).toBe("viewer-hud-layer");
    expect(descendants(Hud(props)).some((node) => node.type === "iframe")).toBe(false);
    expect(Hud(props).type).toBe("details");
  });
});
