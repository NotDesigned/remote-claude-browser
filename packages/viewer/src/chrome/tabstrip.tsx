/**
 * Viewer tab strip.
 * (Gateway half P2-TABS-G = gateway/src/session/tabs.ts, browser domain.)
 * Renders `tabs` Down msgs; sends `nav` activate/newtab/close.
 */
import type { Down, TabId, TabMeta, Up } from "@mirror/protocol";

type ChromeState = Extract<Down, { t: "chrome" }>;
type TabNav = Extract<Up, { t: "nav" }>;

export interface TabStripProps {
  tabs: readonly TabMeta[];
  chromeByTab?: Readonly<Record<TabId, ChromeState | undefined>>;
  send(message: TabNav): void;
  onActivate?(tab: TabId): void;
}

export function TabStrip({ tabs, chromeByTab = {}, send, onActivate }: TabStripProps) {
  const activeTab = tabs.find((tab) => tab.active) ?? tabs[0];
  const activate = (tab: TabId) => {
    onActivate?.(tab);
    send({ t: "nav", tab, action: "activate" });
  };

  return (
    <nav id="tabstrip" aria-label="Browser tabs">
      <span className="tabstrip-brand" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" focusable="false">
          <rect x="3" y="4" width="18" height="14" rx="3" />
          <path d="M8 21h8m-4-3v3M3 9h18" />
        </svg>
        <span>远程浏览器</span>
      </span>
      <div className="tabstrip-tabs">
        <div role="tablist">
          {tabs.map((tab) => {
            const chrome = chromeByTab[tab.id];
            const url = chrome?.url ?? tab.url;
            const loading = chrome?.loading ?? false;
            const label = tab.title || url || "新标签页";
            return (
              <div
                className="browser-tab"
                data-active={tab.active || undefined}
                data-loading={loading || undefined}
                key={tab.id}
              >
                <button
                  className="tab-activate"
                  type="button"
                  role="tab"
                  aria-selected={tab.active}
                  aria-controls="mirror-host"
                  title={url}
                  onClick={() => activate(tab.id)}
                >
                  {tab.favicon === undefined ? (
                    <span className="tab-favicon-placeholder" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" focusable="false">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M3 12h18M12 3c4 4 4 14 0 18-4-4-4-14 0-18Z" />
                      </svg>
                    </span>
                  ) : (
                    <img
                      className="tab-favicon"
                      src={tab.favicon}
                      alt=""
                      onLoad={(event) => {
                        event.currentTarget.hidden = false;
                      }}
                      onError={(event) => {
                        // The asset proxy intentionally preserves upstream failures. Hide the
                        // browser's broken-image glyph when a site's icon cannot be fetched.
                        event.currentTarget.hidden = true;
                      }}
                    />
                  )}
                  <span className="tab-title">{label}</span>
                  <span
                    className="tab-loading"
                    aria-label={loading ? "Loading" : undefined}
                    title="网页加载中"
                  />
                </button>
                <button
                  className="tab-close"
                  type="button"
                  aria-label={`Close ${label}`}
                  title={`关闭 ${label}`}
                  onClick={() => send({ t: "nav", tab: tab.id, action: "close" })}
                >
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
                    <path d="m7 7 10 10M17 7 7 17" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
        <button
          id="new-tab"
          type="button"
          aria-label="New tab"
          title="新建标签页"
          onClick={() => send({ t: "nav", tab: activeTab?.id ?? "", action: "newtab" })}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
    </nav>
  );
}
