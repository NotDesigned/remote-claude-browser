import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { FrontendUser } from "./users";
import { ProxyPanel } from "./network-proxy-panel";
import { CpaPanel } from "./network-cpa-panel";
import "./network-panel.css";

export function NetworkPanel({ user, onClose }: { user: FrontendUser; onClose(): void }) {
  const [tab, setTab] = useState<"proxies" | "cpa">("proxies");
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const previous = document.activeElement;
    close.current!.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const controls = [
          ...panel.current!.querySelectorAll<HTMLElement>(
            "button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]",
          ),
        ].filter((element) => element.getClientRects().length > 0);
        const first = controls[0]!,
          last = controls.at(-1)!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      class="network-panel-backdrop"
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
            ref={close}
            class="network-close"
            aria-label="关闭代理与 API 管理"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div class="network-tabs" role="tablist" aria-label="网络与 API 设置">
          <button
            id="network-proxies-tab"
            type="button"
            role="tab"
            aria-selected={tab === "proxies"}
            onClick={() => setTab("proxies")}
          >
            代理来源
          </button>
          <button
            id="network-cpa-tab"
            type="button"
            role="tab"
            aria-selected={tab === "cpa"}
            onClick={() => setTab("cpa")}
          >
            CPA 授权与 Key
          </button>
        </div>
        <div
          role="tabpanel"
          aria-labelledby={tab === "proxies" ? "network-proxies-tab" : "network-cpa-tab"}
        >
          {tab === "proxies" ? <ProxyPanel user={user} /> : <CpaPanel user={user} />}
        </div>
      </section>
    </div>
  );
}
