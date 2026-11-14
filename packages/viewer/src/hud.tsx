/** Compact connection diagnostics outside the mirrored document. */
import type { Down, TabId } from "@mirror/protocol";
import type { GatewayConnectionState } from "./ws";
import type { ResyncTabState } from "./resync";

type Tab = Extract<Down, { t: "tabs" }>["tabs"][number];

export interface HudProps {
  connection: GatewayConnectionState;
  rttMs: number | null;
  bufferMs: number;
  activeTab: TabId | null;
  tabs: readonly Tab[];
  modeByTab: Readonly<Record<TabId, "dom" | "px" | undefined>>;
  resyncByTab: Readonly<Record<TabId, ResyncTabState | undefined>>;
  speedBps: number | null;
  peakSpeedBps: number | null;
  frames?: FrameRates | null;
}

/** Pictures per second reaching each stage of the pixel view. */
export interface FrameRates {
  capture: number;
  encode: number;
  drop: number;
  display: number;
}

/** Network speeds in the unit people read them in, or a dash before the first measurement. */
export function formatSpeed(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null) return "—";
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${Math.round(bytesPerSecond / 1024)} KB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function HudLayer(props: HudProps) {
  return (
    <aside id="viewer-hud-layer" aria-label="Viewer diagnostics">
      <Hud {...props} />
    </aside>
  );
}

export function Hud({
  connection,
  rttMs,
  bufferMs,
  activeTab,
  tabs,
  modeByTab,
  resyncByTab,
  speedBps,
  peakSpeedBps,
  frames,
}: HudProps) {
  const states = Object.values(resyncByTab).filter(
    (state): state is ResyncTabState => state !== undefined,
  );
  const stateByTab = new Map(states.map((state) => [state.tab, state]));
  const stormTabs = states.filter((state) => state.storm).map((state) => state.tab);
  const totalResyncs = states.reduce((total, state) => total + state.totalResyncs, 0);
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]));
  const tabIds = new Set<TabId>([
    ...tabs.map((tab) => tab.id),
    ...Object.keys(modeByTab),
    ...states.map((state) => state.tab),
  ]);
  const roundedRtt = rttMs === null ? null : Math.round(rttMs);
  const pixelMode = activeTab !== null && modeByTab[activeTab] === "px";
  const connectionLabel =
    connection === "open"
      ? "已连接"
      : connection === "connecting"
        ? "连接中…"
        : connection === "replaced"
          ? "已由另一页面接管"
          : connection === "ended"
            ? "会话已结束"
            : "正在重新连接…";

  return (
    <details
      id="resync-hud"
      class="connection-hud"
      data-connection={connection}
      data-resync-storm={stormTabs.length > 0 ? "true" : "false"}
      data-resync-storm-tabs={stormTabs.join(",")}
      data-resync-total={String(totalResyncs)}
      data-rtt-ms={roundedRtt === null ? "" : String(roundedRtt)}
    >
      <summary
        aria-label="Toggle connection diagnostics"
        title="网络往返延迟（RTT）和当前下载速度。延迟不包含页面处理、回放缓冲和图像绘制耗时"
      >
        <span class="hud-state-dot" aria-hidden="true" />
        <span class="hud-summary-text">
          {roundedRtt === null ? "RTT —" : `RTT ${roundedRtt} ms`}
          <span class="hud-summary-extra">
            {speedBps === null ? "" : ` · ${formatSpeed(speedBps)}`}
            {pixelMode && frames ? ` · ${frames.display} fps` : ""}
          </span>
        </span>
        {stormTabs.length > 0 && <strong class="hud-storm-pill">同步较多</strong>}
        <svg
          class="hud-chevron"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          focusable="false"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </summary>
      <section class="hud-panel">
        <dl class="hud-metrics">
          <div>
            <dt>连接状态</dt>
            <dd>{connectionLabel}</dd>
          </div>
          <div>
            <dt>网络往返 RTT</dt>
            <dd>{roundedRtt === null ? "测量中…" : `${roundedRtt} ms`}</dd>
          </div>
          <div>
            <dt>DOM 回放缓冲</dt>
            <dd>{pixelMode ? "图像模式不使用" : `${Math.round(bufferMs)} ms`}</dd>
          </div>
          <div>
            <dt>当前速度</dt>
            <dd>{speedBps === null ? "测量中…" : formatSpeed(speedBps)}</dd>
          </div>
          <div>
            <dt>最高速度</dt>
            <dd>{formatSpeed(peakSpeedBps)}</dd>
          </div>
          {pixelMode && frames && (
            <>
              <div>
                <dt>显示帧率</dt>
                <dd>{frames.display} fps</dd>
              </div>
              <div>
                <dt>采集帧率</dt>
                <dd>{frames.capture} fps</dd>
              </div>
              <div>
                <dt>编码帧率</dt>
                <dd>{frames.encode} fps</dd>
              </div>
              <div>
                <dt>丢弃帧率</dt>
                <dd>{frames.drop} fps</dd>
              </div>
            </>
          )}
          <div>
            <dt>页面重新同步</dt>
            <dd>{totalResyncs} 次</dd>
          </div>
        </dl>

        {stormTabs.length > 0 && (
          <div class="hud-storm" role="alert">
            近期有 {stormTabs.length} 个页面频繁重新同步，画面可能短暂停顿。
          </div>
        )}

        <div class="hud-tabs" aria-label="Tab modes">
          <h2>页面状态</h2>
          {tabIds.size === 0 ? (
            <p>等待网页加载…</p>
          ) : (
            <ul>
              {[...tabIds].map((tabId) => {
                const tab = tabById.get(tabId);
                const resync = stateByTab.get(tabId);
                return (
                  <li key={tabId} data-active={tabId === activeTab ? "true" : "false"}>
                    <span class="hud-tab-title" title={tab?.url ?? tabId}>
                      {tab?.title || tabId}
                    </span>
                    <span class="hud-mode" data-mode={modeByTab[tabId] ?? "dom"}>
                      {modeByTab[tabId] === "px" ? "图像" : "文字 DOM"}
                    </span>
                    <span class="hud-resync-count">{resync?.totalResyncs ?? 0} 次同步</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </details>
  );
}
