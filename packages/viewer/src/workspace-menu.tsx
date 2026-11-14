import { useEffect, useRef, useState } from "preact/hooks";
import type { FrontendUser } from "./users";
import "./workspace-menu.css";

export type WorkspaceDestination = "profiles" | "proxies" | "cpa" | "users" | "account";
export interface WorkspaceMenuProps {
  user: FrontendUser;
  onNavigate(destination: WorkspaceDestination): void;
  onLogout(): void;
  logoutPending: boolean;
  error: string | null;
}

export function WorkspaceMenu(props: WorkspaceMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current!.focus();
  };
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current!.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const destinations: [WorkspaceDestination, string][] = [
    ["profiles", "浏览器配置"],
    ["proxies", "代理"],
    ["cpa", "API"],
    ...(props.user.role === "admin"
      ? [["users", "用户管理"] as [WorkspaceDestination, string]]
      : []),
    ["account", "我的账号"],
  ];
  return (
    <div class="workspace-menu" ref={root}>
      <button
        class="workspace-menu-trigger"
        type="button"
        ref={trigger}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        工作台 <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <nav class="workspace-menu-panel" aria-label="工作台导航">
          <p>
            {props.user.username}
            <small>{props.user.role === "admin" ? "管理员" : "个人工作台"}</small>
          </p>
          {destinations.map(([value, label]) => (
            <button
              type="button"
              key={value}
              onClick={() => {
                close();
                props.onNavigate(value);
              }}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            class="workspace-logout"
            disabled={props.logoutPending}
            onClick={props.onLogout}
          >
            {props.logoutPending ? "退出中…" : "退出登录"}
          </button>
          {props.error && <p role="alert">{props.error}</p>}
        </nav>
      )}
    </div>
  );
}
