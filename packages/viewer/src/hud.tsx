/** Connection diagnostics, folded into the 「连接」 popover under 「诊断」. */
import type { Down, TabId } from "@mirror/protocol";
import type { GatewayConnectionState } from "./ws";
import type { ResyncTabState } from "./resync";

type Tab = Extract<Down, { t: "tabs" }>["tabs"][number];

export interface DiagnosticsProps {
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

/** Tabs that re-synchronised often lately; the popover warns about them outside 「诊断」. */
export function resyncStormTabs(
  resyncByTab: Readonly<Record<TabId, ResyncTabState | undefined>>,
): TabId[] {
  return Object.values(resyncByTab)
    .filter((state): state is ResyncTabState => state !== undefined && state.storm)
    .map((state) => state.tab);
}

export function Diagnostics({
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
}: DiagnosticsProps) {
  const states = Object.values(resyncByTab).filter(
    (state): state is ResyncTabState => state !== undefined,
  );
  const stateByTab = new Map(states.map((state) => [state.tab, state]));
  const stormTabs = resyncStormTabs(resyncByTab);
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
      class="status-diagnostics"
      data-connection={connection}
      data-resync-storm={stormTabs.length > 0 ? "true" : "false"}
      data-resync-storm-tabs={stormTabs.join(",")}
      data-resync-total={String(totalResyncs)}
      data-rtt-ms={roundedRtt === null ? "" : String(roundedRtt)}
    >
      <summary>
        <span>诊断</span>
        {stormTabs.length > 0 && <strong class="status-storm-pill">同步较多</strong>}
        <svg
          class="status-chevron"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          focusable="false"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </summary>
      <dl class="status-diagnostics-metrics">
        <div>
          <dt>连接状态</dt>
          <dd>{connectionLabel}</dd>
        </div>
        <div title="网络往返延迟（RTT），不包含页面处理、回放缓冲和图像绘制耗时">
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

      <div class="status-diagnostics-tabs">
        <h3>页面状态</h3>
        {tabIds.size === 0 ? (
          <p>等待网页加载…</p>
        ) : (
          <ul>
            {[...tabIds].map((tabId) => {
              const tab = tabById.get(tabId);
              const resync = stateByTab.get(tabId);
              return (
                <li key={tabId} data-active={tabId === activeTab ? "true" : "false"}>
                  <span class="status-tab-title" title={tab?.url ?? tabId}>
                    {tab?.title || tabId}
                  </span>
                  <span class="status-tab-mode" data-mode={modeByTab[tabId] ?? "dom"}>
                    {modeByTab[tabId] === "px" ? "图像" : "文字 DOM"}
                  </span>
                  <span class="status-tab-resyncs">{resync?.totalResyncs ?? 0} 次同步</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}
