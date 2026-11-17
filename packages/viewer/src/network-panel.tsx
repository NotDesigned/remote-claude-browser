import { useDialog } from "./dialog";
import type { FrontendUser } from "./users";
import { ProxyPanel } from "./network-proxy-panel";
import { CpaPanel } from "./network-cpa-panel";
import type { CpaBrowserAuthorization } from "./network-api";
import "./network-panel.css";

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
}: {
  user: FrontendUser;
  browserProxyId?: string | null;
  browserSessionId?: string;
  open: boolean;
  tab: "proxies" | "cpa";
  onTabChange(tab: "proxies" | "cpa"): void;
  onOpenBrowser(): void;
  onChooseBrowser(authorization: CpaBrowserAuthorization): void;
  onClose(): void;
  error: string | null;
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
            <h2 id="network-panel-title">代理与 API</h2>
            <p class="network-muted">管理可用节点和独立 CPA 授权。</p>
          </div>
          <button
            type="button"
            class="network-close"
            aria-label="关闭代理与 API 管理"
            onClick={onClose}
          >
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
      </section>
    </div>
  );
}
