import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { FrontendUser } from "./users";
import { onOutsidePress } from "./outside-press";
import "./workspace-menu.css";

export type WorkspaceDestination =
  "profiles" | "network" | "proxies" | "cpa" | "admin" | "account" | "mailboxes";
export interface WorkspaceMenuProps {
  user: FrontendUser;
  onNavigate(destination: WorkspaceDestination): void;
  onLogout(): void;
  logoutPending: boolean;
  error: string | null;
}

function destinations(user: FrontendUser): [WorkspaceDestination, string][] {
  return [
    ["profiles", "浏览器配置"],
    ["network", "网络与接入"],
    ["mailboxes", "收件箱"],
    ...(user.role === "admin" ? [["admin", "管理后台"] as [WorkspaceDestination, string]] : []),
    ["account", "我的账号"],
  ];
}

/** The pages of the workbench: the top of the ⋯ menu, in a session and on the picker alike. */
export function WorkspaceNav(props: WorkspaceMenuProps & { onDone?(): void }) {
  return (
    <nav class="workspace-nav" aria-label="导航">
      {destinations(props.user).map(([value, label]) => (
        <button
          type="button"
          key={value}
          onClick={() => {
            props.onDone?.();
            props.onNavigate(value);
          }}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

/** Who is signed in, and 退出登录: the bottom of the ⋯ menu. */
export function WorkspaceAccount(props: WorkspaceMenuProps) {
  return (
    <div class="workspace-account">
      <span>
        {props.user.username}
        <small>{props.user.role === "admin" ? "管理员" : "普通用户"}</small>
      </span>
      <button type="button" disabled={props.logoutPending} onClick={props.onLogout}>
        {props.logoutPending ? "退出中…" : "退出登录"}
      </button>
      {props.error && <p role="alert">{props.error}</p>}
    </div>
  );
}

export function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </svg>
  );
}

/**
 * The ⋯ menu where there is no session bar (the configuration picker): the pages, then
 * `children` (its settings), then the account.
 */
export function WorkspaceMenu(props: WorkspaceMenuProps & { children?: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current!.focus();
  };
  useEffect(() => {
    if (!open) return;
    const stopOutside = onOutsidePress(
      (target) => target instanceof Node && !!root.current?.contains(target),
      () => setOpen(false),
    );
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      stopOutside();
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div class="workspace-menu" ref={root}>
      <button
        class="workspace-menu-trigger"
        type="button"
        ref={trigger}
        aria-label="菜单"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MenuIcon />
      </button>
      {open && (
        <div class="workspace-menu-panel" role="dialog" aria-label="菜单">
          <WorkspaceNav {...props} onDone={close} />
          {props.children && <div class="workspace-settings">{props.children}</div>}
          <WorkspaceAccount {...props} />
        </div>
      )}
    </div>
  );
}
