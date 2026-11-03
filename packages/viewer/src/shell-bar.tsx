/**
 * The unified page's single top bar: view switch (聊天 / 页面 / 画面), connection status and the
 * ⋯ menu. Browser chrome (tabs and address bar) can be hidden; the compact navigation then lives
 * here and the address in the menu.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { normalizeNavigationUrl } from "./chrome/urlbar";
import { SERVER_STATUS_STALE_MS, type ReceivedServerStatus } from "./server-status";
import type { ViewMode } from "./client-session";

export type ThemePreference = "auto" | "light" | "dark";
export type StatusTone = "ok" | "busy" | "bad";

export interface ShellBarProps {
  viewMode: ViewMode;
  onViewMode(mode: ViewMode): void;
  /** False when the shared browser cannot start another pixel stream. */
  pixelAvailable: boolean;
  status: { text: string; tone: StatusTone };
  chromeVisible: boolean;
  onToggleChrome(): void;
  /** Current remote address in the browser views; null in chat or before a tab exists. */
  url: string | null;
  canBack: boolean;
  onNav(action: "back" | "reload" | "go", url?: string): void;
  theme: ThemePreference;
  onTheme(theme: ThemePreference): void;
  serverStatus: ReceivedServerStatus | null;
  rttMs: number | null;
  sessionLabel: string | null;
  onEndSession?(): void;
}

const VIEWS: { mode: ViewMode; label: string; title: string }[] = [
  { mode: "chat", label: "聊天", title: "文字聊天：日常使用" },
  { mode: "dom", label: "页面", title: "页面：登录、设置等网页操作" },
  { mode: "px", label: "画面", title: "画面：远程浏览器的实时图像，用于验证码等" },
];

export function ShellBar(props: ShellBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [address, setAddress] = useState(props.url ?? "");
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const browserView = props.viewMode !== "chat";
  const compactNav = browserView && !props.chromeVisible;

  useEffect(() => setAddress(props.url ?? ""), [props.url, menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !menuRef.current?.contains(target) && !toggleRef.current?.contains(target))
        setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [menuOpen]);

  // A sample older than ~10 s is stale: hide numbers rather than show a false reading.
  const sample =
    props.serverStatus && Date.now() - props.serverStatus.receivedAt < SERVER_STATUS_STALE_MS
      ? props.serverStatus.value
      : null;
  const gib = (bytes: number | null | undefined) =>
    bytes === null || bytes === undefined ? "—" : (bytes / 1024 ** 3).toFixed(1);

  return (
    <header id="shell-bar">
      <div class="shell-bar-start">
        {compactNav ? (
          <>
            <button
              type="button"
              class="shell-icon"
              aria-label="后退"
              disabled={!props.canBack}
              onClick={() => props.onNav("back")}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="m14 6-6 6 6 6" />
              </svg>
            </button>
            <button
              type="button"
              class="shell-icon shell-wide-only"
              aria-label="刷新"
              onClick={() => props.onNav("reload")}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6" />
              </svg>
            </button>
            <button
              type="button"
              class="shell-address shell-wide-only"
              title={props.url ?? ""}
              onClick={() => setMenuOpen(true)}
            >
              {displayUrl(props.url)}
            </button>
          </>
        ) : (
          <span class="shell-brand">远程 Claude</span>
        )}
      </div>

      <div class="shell-views" role="group" aria-label="视图">
        {VIEWS.map((view) => (
          <button
            key={view.mode}
            type="button"
            data-view-mode={view.mode}
            title={view.title}
            aria-pressed={props.viewMode === view.mode}
            disabled={view.mode === "px" && props.viewMode !== "px" && !props.pixelAvailable}
            onClick={() => props.onViewMode(view.mode)}
          >
            {view.label}
          </button>
        ))}
      </div>

      <div class="shell-bar-end">
        <span
          id="shell-status"
          role="status"
          data-tone={props.status.tone}
          title={props.status.text}
        >
          <span class="shell-status-dot" aria-hidden="true" />
          <span class="shell-status-text">{props.status.text}</span>
        </span>
        <button
          ref={toggleRef}
          type="button"
          class="shell-icon"
          id="shell-menu-toggle"
          aria-label="更多"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="5" cy="12" r="1.2" />
            <circle cx="12" cy="12" r="1.2" />
            <circle cx="19" cy="12" r="1.2" />
          </svg>
        </button>
      </div>

      {menuOpen && (
        <div id="shell-menu" ref={menuRef} role="dialog" aria-label="更多">
          {browserView && (
            <form
              class="shell-menu-address"
              onSubmit={(event) => {
                event.preventDefault();
                const url = normalizeNavigationUrl(address);
                if (url === null) return;
                props.onNav("go", url);
                setMenuOpen(false);
              }}
            >
              <label for="shell-menu-url">网址</label>
              <input
                id="shell-menu-url"
                type="text"
                value={address}
                autoCapitalize="off"
                autoCorrect="off"
                spellcheck={false}
                onInput={(event) => setAddress(event.currentTarget.value)}
              />
            </form>
          )}
          <button
            type="button"
            class="shell-menu-switch"
            aria-pressed={props.chromeVisible}
            onClick={props.onToggleChrome}
          >
            <span>页面和画面模式显示标签栏和地址栏</span>
            <span class="shell-switch" aria-hidden="true" />
          </button>
          <a class="shell-menu-item" href="/?new=1" target="_blank" rel="noopener">
            打开另一个独立会话
          </a>
          {props.onEndSession && (
            <button
              type="button"
              class="shell-menu-item"
              onClick={() => {
                setMenuOpen(false);
                props.onEndSession?.();
              }}
            >
              结束本会话{props.sessionLabel ? `（${props.sessionLabel}）` : ""}
            </button>
          )}
          <div class="shell-menu-section" role="group" aria-label="外观">
            <span>外观</span>
            <div class="shell-menu-choices">
              {(
                [
                  ["auto", "跟随系统"],
                  ["light", "浅色"],
                  ["dark", "深色"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={props.theme === value}
                  onClick={() => props.onTheme(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div class="shell-menu-section" aria-label="服务状态">
            <span>服务状态</span>
            <dl class="shell-menu-stats">
              <div>
                <dt>在线设备</dt>
                <dd>{sample?.clientsOnline ?? "—"}</dd>
              </div>
              <div>
                <dt>会话</dt>
                <dd>{sample ? `${sample.clientsAllocated} / ${sample.clientsMax}` : "—"}</dd>
              </div>
              <div>
                <dt>CPU</dt>
                <dd>
                  {sample?.cpuPercent === null || sample?.cpuPercent === undefined
                    ? "—"
                    : `${Math.round(sample.cpuPercent)}%`}
                </dd>
              </div>
              <div>
                <dt>内存</dt>
                <dd>
                  {sample
                    ? `${gib(sample.memoryUsedBytes)} / ${gib(sample.memoryTotalBytes)} GiB`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>延迟</dt>
                <dd>{props.rttMs === null ? "—" : `${Math.round(props.rttMs)} ms`}</dd>
              </div>
            </dl>
          </div>
        </div>
      )}
    </header>
  );
}

function displayUrl(url: string | null): string {
  if (!url) return "未打开网页";
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

/** Resource pressure worth telling every user about, rather than only in the menu. */
export function resourceWarning(received: ReceivedServerStatus | null): string | null {
  const sample = received?.value;
  if (!sample) return null;
  const free =
    sample.memoryTotalBytes !== null && sample.memoryUsedBytes !== null
      ? sample.memoryTotalBytes - sample.memoryUsedBytes
      : null;
  if (sample.clientsAllocated >= sample.clientsMax)
    return `会话名额已满（${sample.clientsAllocated} / ${sample.clientsMax}），暂时无法新建会话；已打开的会话不受影响。`;
  if (free !== null && free < 384 * 1024 ** 2)
    return "服务器内存紧张，新建会话可能失败；已打开的会话不受影响。";
  return null;
}
