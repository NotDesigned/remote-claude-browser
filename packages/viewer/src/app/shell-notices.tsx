/** Notices around the mirror: the banners above it, and the load failure drawn over it. */
import type { Up } from "@mirror/protocol";
import { useLayoutEffect, useState, type MutableRef } from "preact/hooks";
import { Presence } from "../chrome/presence";
import { RemoteCcLoginBanner } from "../network-remote-cc-panel";
import type { ChromeMessage, OAuthCallback, PageState, Viewers } from "./runtime-state";

export interface ShellBannersProps {
  /** The remote-cc sign-in banner's session and profile, when it applies. */
  remoteCc: { sid: string; profileId: string } | null;
  /** The active tab's page state. */
  pageState: PageState | undefined;
  clipboardError: string | null;
  buildStale: boolean;
  /** Presence controls; a fixture page shows them. */
  presence: {
    viewers: Viewers;
    viewerId: string | null;
    driverId: string | null;
    send(message: Up): void;
  } | null;
}

export function ShellBanners({
  remoteCc,
  pageState,
  clipboardError,
  buildStale,
  presence,
}: ShellBannersProps) {
  return (
    <div id="shell-banners">
      {remoteCc && <RemoteCcLoginBanner sid={remoteCc.sid} profileId={remoteCc.profileId} />}
      {pageState && pageState !== "ready" && (
        <p id="page-recovery-state" class="shell-banner" data-tone="warn" role="alert">
          {pageState === "recovering"
            ? "远程网页已崩溃，正在恢复…"
            : "远程网页恢复失败，请刷新页面"}
        </p>
      )}
      {clipboardError && (
        <p class="shell-banner clipboard-error" data-tone="warn" role="status">
          {clipboardError}
        </p>
      )}
      {buildStale && (
        <p id="build-stale" class="shell-banner" role="status">
          页面已更新，空闲时会自动刷新。
          <button type="button" onClick={() => window.location.reload()}>
            立即刷新
          </button>
        </p>
      )}
      {presence && (
        <Presence
          viewers={presence.viewers}
          viewerId={presence.viewerId}
          driverId={presence.driverId}
          send={presence.send}
        />
      )}
    </div>
  );
}

export interface PageLoadFailedProps {
  hostRef: MutableRef<HTMLElement | null>;
  /** The active tab's chrome. */
  chrome: ChromeMessage | null;
  /** The active tab's CPA authorization callback, if the page was one. */
  oauth: OAuthCallback | undefined;
  pixelMode: boolean;
  onShowCpa(): void;
  onReload(tab: ChromeMessage["tab"]): void;
}

/** The page could not load, or was a CPA authorization callback: over the mirror. */
export function PageLoadFailed({
  hostRef,
  chrome,
  oauth,
  pixelMode,
  onShowCpa,
  onReload,
}: PageLoadFailedProps) {
  // Where the mirror starts, for the notice drawn over it; read after layout.
  const [hostTop, setHostTop] = useState(0);
  const shown = chrome !== null && (!!oauth || (chrome.failed === true && !pixelMode));
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!shown || host === null) return;
    const measure = () => setHostTop(host.offsetTop);
    measure();
    const observer = new ResizeObserver(measure);
    // Banners above the mirror push it down, and shrink it as they do.
    observer.observe(host);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [shown]);
  if (!shown || chrome === null) return null;
  return (
    // From where the mirror starts: the address bar above it is how to go somewhere else.
    <section id="page-load-failed" role="alert" style={{ top: `${hostTop}px` }}>
      <h2>
        {oauth === "submitted"
          ? "授权回调已提交给 CPA"
          : oauth === "error"
            ? "授权回调自动提交失败"
            : "这个网页打不开"}
      </h2>
      <p>{oauth === "submitted" ? "可以返回 CPA 面板查看授权结果。" : chrome.url}</p>
      {oauth && (
        <>
          {oauth === "error" && <p>自动提交失败，可返回 CPA 面板手动提交上面的回调地址。</p>}
          <button type="button" onClick={onShowCpa}>
            查看 CPA 授权
          </button>
        </>
      )}
      {oauth !== "submitted" && (
        <button type="button" onClick={() => onReload(chrome.tab)}>
          重新加载
        </button>
      )}
    </section>
  );
}
