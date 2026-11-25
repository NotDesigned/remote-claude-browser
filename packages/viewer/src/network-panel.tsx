import { useDialog } from "./dialog";
import type { FrontendUser } from "./users";
import { ProxyPanel } from "./network-proxy-panel";
import { CpaPanel } from "./network-cpa-panel";
import { RemoteCcPanel } from "./network-remote-cc-panel";
import type { CpaBrowserAuthorization } from "./network-api";
import "./network-panel.css";

export type NetworkTab = "proxies" | "cpa" | "remote-cc";

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
  error: string | null;
  /** A remote-cc connection code from an approval link. */
  remoteCcCode?: string | null;
}) {
  const panel = useDialog(open, onClose);
  return (
    <div
      class="network-panel-backdrop"
      style={{ display: open ? undefined : "none" }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        class="network-panel"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="network-panel-title"
      >
        <header class="network-panel-heading">
          <div>
            <h2 id="network-panel-title">网络与接入</h2>
            <p class="network-muted">管理可用节点、独立 CPA 授权和 remote-cc 连接。</p>
          </div>
          <button type="button" class="network-close" aria-label="关闭网络与接入" onClick={onClose}>
            ×
          </button>
        </header>
        {error && (
          <p class="network-message network-error" role="alert">
            {error}
          </p>
        )}
        <div class="network-tabs" role="tablist" aria-label="网络与 API 设置">
          <button
            id="network-proxies-tab"
            type="button"
            role="tab"
            aria-selected={tab === "proxies"}
            onClick={() => onTabChange("proxies")}
          >
            代理来源
          </button>
          <button
            id="network-cpa-tab"
            type="button"
            role="tab"
            aria-selected={tab === "cpa"}
            onClick={() => onTabChange("cpa")}
          >
            CPA 授权与 Key
          </button>
          <button
            id="network-remote-cc-tab"
            type="button"
            role="tab"
            aria-selected={tab === "remote-cc"}
            onClick={() => onTabChange("remote-cc")}
          >
            remote-cc
          </button>
        </div>
        <div role="tabpanel" aria-labelledby="network-proxies-tab" hidden={tab !== "proxies"}>
          <ProxyPanel user={user} />
        </div>
        <div role="tabpanel" aria-labelledby="network-cpa-tab" hidden={tab !== "cpa"}>
          <CpaPanel
            open={open && tab === "cpa"}
            user={user}
            browserProxyId={browserProxyId}
            browserSessionId={browserSessionId}
            onOpenBrowser={onOpenBrowser}
            onChooseBrowser={onChooseBrowser}
          />
        </div>
        <div role="tabpanel" aria-labelledby="network-remote-cc-tab" hidden={tab !== "remote-cc"}>
          <RemoteCcPanel
            open={open && tab === "remote-cc"}
            user={user}
            initialCode={remoteCcCode}
            browserSessionId={browserSessionId}
          />
        </div>
      </section>
    </div>
  );
}
