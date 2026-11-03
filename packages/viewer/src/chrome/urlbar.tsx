/**
 * URL bar with back, forward, and reload controls.
 * (Gateway half P1-NAV-G = gateway/src/browser/nav.ts, browser domain. Split at the wire:
 * this component only sends `nav` Up msgs and renders `chrome` Down msgs.)
 */
import { useEffect, useState } from "preact/hooks";
import type { Down, TabId, Up } from "@mirror/protocol";

type ChromeState = Extract<Down, { t: "chrome" }>;
type NavAction = Extract<Up, { t: "nav" }>["action"];

export interface UrlBarProps {
  tab: TabId | null;
  chrome: ChromeState | null;
  fallbackUrl?: string;
  send(message: Extract<Up, { t: "nav" }>): void;
}

export function UrlBar({ tab, chrome, fallbackUrl = "", send }: UrlBarProps) {
  const [value, setValue] = useState(chrome?.url ?? fallbackUrl);
  useEffect(() => setValue(chrome?.url ?? fallbackUrl), [chrome?.url, fallbackUrl, tab]);
  const navigate = (action: NavAction, url?: string) => {
    if (tab === null) return;
    send(url === undefined ? { t: "nav", tab, action } : { t: "nav", tab, action, url });
  };

  return (
    <nav id="urlbar" aria-label="Browser navigation">
      <button
        type="button"
        aria-label="Back"
        title="后退"
        disabled={tab === null || !chrome?.canBack}
        onClick={() => navigate("back")}
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
          <path d="m14 6-6 6 6 6" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Forward"
        title="前进"
        disabled={tab === null || !chrome?.canFwd}
        onClick={() => navigate("fwd")}
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
          <path d="m10 6 6 6-6 6" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Reload"
        title="刷新页面"
        disabled={tab === null}
        onClick={() => navigate("reload")}
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
          <path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6" />
        </svg>
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const url = normalizeNavigationUrl(value);
          if (url !== null) navigate("go", url);
        }}
      >
        <span className="address-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" focusable="false">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c4 4 4 14 0 18-4-4-4-14 0-18Z" />
          </svg>
        </span>
        <span
          className="loading-indicator"
          data-loading={chrome?.loading || undefined}
          aria-hidden="true"
        />
        <input
          aria-label="Address"
          type="text"
          placeholder="输入网址，按 Enter 打开"
          value={value}
          disabled={tab === null}
          autoCapitalize="off"
          autoCorrect="off"
          spellcheck={false}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
      </form>
    </nav>
  );
}

export function normalizeNavigationUrl(input: string): string | null {
  const value = input.trim();
  if (value === "") return null;
  return /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
}
