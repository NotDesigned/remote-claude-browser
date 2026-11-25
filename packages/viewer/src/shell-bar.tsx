/**
 * The unified page's single top bar: view switch (页面 / 画面), the browser's tabs when it is
 * showing, the time where the remote browser is, the connection status pill (which opens the
 * 「连接」 popover) and the ⋯ menu: the workbench's pages, the settings, and the account.
 */
import {
  MenuIcon,
  WorkspaceAccount,
  WorkspaceNav,
  type WorkspaceMenuProps,
} from "./workspace-menu";
import type { PxQuality } from "@mirror/protocol";
import { Diagnostics, formatSpeed, resyncStormTabs, type DiagnosticsProps } from "./hud";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { SERVER_STATUS_STALE_MS, type ReceivedServerStatus } from "./server-status";
import {
  formatStatusClock,
  msToNextMinute,
  remoteClockNow,
  type RemoteClockText,
} from "./remote-clock";
import type { ViewMode } from "./client-session";
import type { ConnectionStatus } from "./connection-status";

export type { StatusTone } from "./connection-status";
export type ThemePreference = "auto" | "light" | "dark";
export type LinkTarget = "inside" | "device";

export interface ShellBarProps {
  viewMode: ViewMode;
  onViewMode(mode: ViewMode): void;
  /** False when the shared browser cannot start another pixel stream. */
  pixelAvailable: boolean;
  status: ConnectionStatus;
  /** The browser's tabs, between the view switch and the status. */
  children?: ComponentChildren;
  theme: ThemePreference;
  onTheme(theme: ThemePreference): void;
  linkTarget: LinkTarget;
  onLinkTarget(target: LinkTarget): void;
  pxQuality: PxQuality;
  onPxQuality(quality: PxQuality): void;
  serverStatus: ReceivedServerStatus | null;
  rttMs: number | null;
  speedBps: number | null;
  /** Only in the pixel view, where it means something. */
  frameRate: number | null;
  /** The numbers behind 「诊断」; absent until a session is running. */
  diagnostics?: DiagnosticsProps | null;
  /** The current browser profile, named next to its exit. */
  profileName?: string;
  /** Offered while input is not synchronised; the button is hidden without it. */
  onResyncInput?: () => void;
  /** Offered while the connection is down; the button is hidden without it. */
  onReconnect?: () => void;
  workspace?: WorkspaceMenuProps;
  onMenuOpen?(): void;
}

const VIEWS: { mode: ViewMode; label: string; title: string }[] = [
  { mode: "dom", label: "页面", title: "页面：Claude 的网页，日常使用" },
  { mode: "px", label: "画面", title: "画面：远程浏览器的实时图像，用于验证码等" },
];

/** Phones show one view button, the current one; a tap switches to the other view. */
const COMPACT_VIEWS = "(max-width: 760px)";

type Popup = "menu" | "connection";

export function ShellBar(props: ShellBarProps) {
  const [open, setOpen] = useState<Popup | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const connectionRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLButtonElement>(null);
  const toggle = (popup: Popup) => setOpen((current) => (current === popup ? null : popup));

  useEffect(() => {
    if (open === "menu") props.onMenuOpen?.();
    // Keyboard users land inside the popover, as they would in a dialog.
    if (open === "connection") connectionRef.current?.focus();
  }, [open]);

  // Listen as soon as the popup is drawn, not after the next frame: an Escape pressed right
  // after switching from one popup to the other must still close it.
  useLayoutEffect(() => {
    if (open === null) return;
    const panel = open === "menu" ? menuRef : connectionRef;
    const trigger = open === "menu" ? toggleRef : statusRef;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(null);
        trigger.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !panel.current?.contains(target) && !trigger.current?.contains(target))
        setOpen(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open]);

  // A sample older than ~10 s is stale: say nothing rather than warn on an old reading.
  const fresh =
    props.serverStatus !== null &&
    Date.now() - props.serverStatus.receivedAt < SERVER_STATUS_STALE_MS;
  const warning = fresh ? resourceWarning(props.serverStatus) : null;
  const stormTabs = props.diagnostics ? resyncStormTabs(props.diagnostics.resyncByTab) : [];
  // The zone does not go stale with the numbers: keep showing the last one heard.
  const clock = useRemoteClock(props.serverStatus);
  const { status } = props;
  const attention = warning !== null || stormTabs.length > 0;

  return (
    <header id="shell-bar">
      <div class="shell-views" role="group" aria-label="视图">
        {VIEWS.map((view) => {
          const current = props.viewMode === view.mode;
          const other = VIEWS.find((item) => item.mode !== view.mode)!;
          const otherBlocked = other.mode === "px" && !props.pixelAvailable;
          return (
            <button
              key={view.mode}
              type="button"
              data-view-mode={view.mode}
              data-switch-blocked={current && otherBlocked ? "true" : undefined}
              title={current ? `${view.title}（手机上点按切换到${other.label}）` : view.title}
              aria-pressed={current}
              disabled={view.mode === "px" && !current && !props.pixelAvailable}
              onClick={() => {
                if (!current) props.onViewMode(view.mode);
                else if (!otherBlocked && window.matchMedia?.(COMPACT_VIEWS).matches)
                  props.onViewMode(other.mode);
              }}
            >
              {view.label}
            </button>
          );
        })}
      </div>

      <div class="shell-bar-tabs">{props.children}</div>

      <div class="shell-bar-end">
        {clock && (
          <span id="shell-clock" title={clock.title} aria-label={`出口当地时间 ${clock.title}`}>
            {clock.label}
          </span>
        )}
        <button
          ref={statusRef}
          type="button"
          id="shell-status"
          data-tone={status.tone}
          data-warn={attention ? "true" : undefined}
          title={`${status.text}：${status.reason}`}
          aria-label={`连接：${status.text}${attention ? "（有提醒）" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={open === "connection"}
          aria-controls={open === "connection" ? "shell-connection" : undefined}
          onClick={() => toggle("connection")}
        >
          <span class="shell-status-dot" aria-hidden="true" />
          <span class="shell-status-text" aria-live="polite">
            {status.text}
          </span>
        </button>
        <button
          ref={toggleRef}
          type="button"
          class="shell-icon"
          id="shell-menu-toggle"
          aria-label="菜单"
          aria-haspopup="true"
          aria-expanded={open === "menu"}
          onClick={() => toggle("menu")}
        >
          <MenuIcon />
        </button>
      </div>

      {open === "connection" && (
        <div
          id="shell-connection"
          ref={connectionRef}
          role="dialog"
          aria-label="连接"
          tabIndex={-1}
          data-tone={status.tone}
        >
          <ConnectionDetails
            status={status}
            warning={warning}
            clock={clock}
            rttMs={props.rttMs}
            speedBps={props.speedBps}
            frameRate={props.frameRate}
            profileName={props.profileName}
            onResyncInput={props.onResyncInput}
            onReconnect={props.onReconnect}
            diagnostics={props.diagnostics}
          />
        </div>
      )}

      {open === "menu" && (
        <div id="shell-menu" ref={menuRef} role="dialog" aria-label="菜单">
          {props.workspace && <WorkspaceNav {...props.workspace} onDone={() => setOpen(null)} />}
          <div class="shell-menu-section" role="group" aria-label="画面清晰度">
            <span>画面模式：越清晰，服务器负担越重</span>
            <div class="shell-menu-choices">
              {(
                [
                  ["smooth", "流畅"],
                  ["balanced", "均衡"],
                  ["sharp", "清晰"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  data-px-quality={value}
                  aria-pressed={props.pxQuality === value}
                  onClick={() => props.onPxQuality(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
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
          <div class="shell-menu-section" role="group" aria-label="页面里的外部链接">
            <span>页面里的外部链接</span>
            <div class="shell-menu-choices">
              {(
                [
                  ["inside", "内部标签"],
                  ["device", "本机浏览器"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={props.linkTarget === value}
                  onClick={() => props.onLinkTarget(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {props.workspace && <WorkspaceAccount {...props.workspace} />}
        </div>
      )}
    </header>
  );
}

export interface ConnectionDetailsProps {
  status: ConnectionStatus;
  warning: string | null;
  clock: RemoteClockText | null;
  rttMs: number | null;
  speedBps: number | null;
  frameRate: number | null;
  profileName?: string;
  onResyncInput?: () => void;
  onReconnect?: () => void;
  diagnostics?: DiagnosticsProps | null;
}

/** The 「连接」 popover's contents: state and why, what to do, the numbers, and the exit. */
export function ConnectionDetails({
  status,
  warning,
  clock,
  rttMs,
  speedBps,
  frameRate,
  profileName,
  onResyncInput,
  onReconnect,
  diagnostics,
}: ConnectionDetailsProps) {
  const live =
    status.kind === "connected" || status.kind === "syncing" || status.kind === "input-unsynced";
  const showResync = status.kind === "input-unsynced" && onResyncInput !== undefined;
  const showReconnect =
    (status.kind === "connecting" || status.kind === "reconnecting") && onReconnect !== undefined;
  const stormTabs = diagnostics ? resyncStormTabs(diagnostics.resyncByTab) : [];
  return (
    <>
      <section class="status-state" role="status">
        <h2>
          <span class="shell-status-dot" aria-hidden="true" />
          {status.text}
        </h2>
        <p>{status.reason}</p>
      </section>
      {(showResync || showReconnect) && (
        <div class="status-actions">
          {showResync && (
            <button type="button" class="status-primary" onClick={onResyncInput}>
              重新同步
            </button>
          )}
          {showReconnect && (
            <button type="button" class="status-primary" onClick={onReconnect}>
              重新连接
            </button>
          )}
        </div>
      )}
      {live && (
        <dl class="status-metrics">
          <div>
            <dt>延迟</dt>
            <dd>{rttMs === null ? "—" : `${Math.round(rttMs)} ms`}</dd>
          </div>
          <div>
            <dt>速度</dt>
            <dd>{formatSpeed(speedBps)}</dd>
          </div>
          {frameRate !== null && (
            <div>
              <dt>帧率</dt>
              <dd>{frameRate} fps</dd>
            </div>
          )}
        </dl>
      )}
      {warning && <p class="status-warning">{warning}</p>}
      {stormTabs.length > 0 && (
        <p class="status-warning">
          近期有 {stormTabs.length} 个页面频繁重新同步，画面可能短暂停顿。
        </p>
      )}
      {clock && (
        <section class="status-exit" aria-label="出口">
          <h3>
            出口
            {profileName && <span class="status-profile">{profileName}</span>}
          </h3>
          <dl>
            <div>
              <dt>位置</dt>
              <dd>{clock.place}</dd>
            </div>
            <div>
              <dt>当地时间</dt>
              <dd>{clock.dateTime}</dd>
            </div>
            <div>
              <dt>时区</dt>
              <dd>{clock.zone}</dd>
            </div>
          </dl>
        </section>
      )}
      {diagnostics && <Diagnostics {...diagnostics} />}
    </>
  );
}

/** Only matters to someone opening a session, so it waits in the 「连接」 popover instead of taking up the page. */
export function resourceWarning(received: ReceivedServerStatus | null): string | null {
  const sample = received?.value;
  if (!sample) return null;
  const free =
    sample.memoryTotalBytes !== null && sample.memoryUsedBytes !== null
      ? sample.memoryTotalBytes - sample.memoryUsedBytes
      : null;
  const budget = sample.browserMemoryLimitBytes;
  const headroom = budget === null ? null : Math.max(300 * 1024 ** 2, budget * 0.1);
  if (
    (budget !== null &&
      headroom !== null &&
      sample.browserMemoryBytes !== null &&
      sample.browserMemoryBytes > budget - headroom) ||
    (free !== null && free < 256 * 1024 ** 2)
  )
    return "服务器内存紧张，新建会话可能失败；已打开的会话不受影响。";
  return null;
}

/**
 * The remote browser's time. Each render reads the clock, so one after a throttled background
 * timer is right anyway; the timer only redraws on each new minute.
 */
function useRemoteClock(sample: ReceivedServerStatus | null) {
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!sample?.value.timeZone) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      redraw((count) => count + 1);
      timer = setTimeout(tick, msToNextMinute(remoteClockNow(sample)) + 50);
    };
    timer = setTimeout(tick, msToNextMinute(remoteClockNow(sample)) + 50);
    return () => clearTimeout(timer);
  }, [sample]);
  return formatStatusClock(sample);
}
