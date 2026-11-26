import type { FrontendUser } from "./users";
import { ProxyPanel } from "./network-proxy-panel";
import { CpaPanel } from "./network-cpa-panel";
import { RemoteCcPanel } from "./network-remote-cc-panel";
import type { CpaBrowserAuthorization } from "./network-api";
import { Panel } from "./panel";
import "./network-panel.css";

export type NetworkTab = "proxies" | "cpa" | "remote-cc";

const TABS: [NetworkTab, string][] = [
  ["proxies", "代理来源"],
  ["cpa", "CPA 授权与 Key"],
  ["remote-cc", "remote-cc"],
];

/** The tab an arrow, Home or End key moves to from `current`, or null for any other key. */
export function tabForKey(current: NetworkTab, key: string): NetworkTab | null {
  const index = TABS.findIndex(([tab]) => tab === current);
  const last = TABS.length - 1;
  const next =
    key === "ArrowRight"
      ? (index + 1) % TABS.length
      : key === "ArrowLeft"
        ? (index + last) % TABS.length
        : key === "Home"
          ? 0
          : key === "End"
            ? last
            : null;
  return next === null ? null : TABS[next]![0];
}

export function NetworkPanel({
  user,
  browserProxyId,
  browserSessionId,
  open,
  tab,
  onTabChange,
  onOpenBrowser,
  onChooseBrowser,
  onClose,
  error,
  remoteCcCode,
}: {
  user: FrontendUser;
  browserProxyId?: string | null;
  browserSessionId?: string;
  open: boolean;
  tab: NetworkTab;
  onTabChange(tab: NetworkTab): void;
  onOpenBrowser(): void;
  onChooseBrowser(authorization: CpaBrowserAuthorization): void;
  onClose(): void;
  /** A CPA authorization that could not be opened in the chosen browser. */
  error: string | null;
  /** A remote-cc connection code from an approval link. */
  remoteCcCode?: string | null;
}) {
  return (
    <Panel
      variant="network"
      open={open}
      onClose={onClose}
      titleId="network-panel-title"
      title="网络与接入"
      description="管理可用节点、独立 CPA 授权和 remote-cc 连接。"
      descriptionId="network-panel-description"
      closeLabel="关闭网络与接入"
    >
      <div
        class="network-tabs"
        role="tablist"
        aria-label="网络与接入"
        onKeyDown={(event) => {
          const next = tabForKey(tab, event.key);
          if (next === null) return;
          event.preventDefault();
          onTabChange(next);
          event.currentTarget.querySelector<HTMLElement>(`#network-${next}-tab`)?.focus();
        }}
      >
        {TABS.map(([value, label]) => (
          <button
            key={value}
            id={`network-${value}-tab`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`network-${value}-panel`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => onTabChange(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        id="network-proxies-panel"
        role="tabpanel"
        aria-labelledby="network-proxies-tab"
        hidden={tab !== "proxies"}
      >
        <ProxyPanel open={open && tab === "proxies"} user={user} />
      </div>
      <div
        id="network-cpa-panel"
        role="tabpanel"
        aria-labelledby="network-cpa-tab"
        hidden={tab !== "cpa"}
      >
        {error && (
          <p class="network-message network-error network-panel-error" role="alert">
            {error}
          </p>
        )}
        <CpaPanel
          open={open && tab === "cpa"}
          user={user}
          browserProxyId={browserProxyId}
          browserSessionId={browserSessionId}
          onOpenBrowser={onOpenBrowser}
          onChooseBrowser={onChooseBrowser}
        />
      </div>
      <div
        id="network-remote-cc-panel"
        role="tabpanel"
        aria-labelledby="network-remote-cc-tab"
        hidden={tab !== "remote-cc"}
      >
        <RemoteCcPanel
          open={open && tab === "remote-cc"}
          user={user}
          initialCode={remoteCcCode}
          browserSessionId={browserSessionId}
        />
      </div>
    </Panel>
  );
}
