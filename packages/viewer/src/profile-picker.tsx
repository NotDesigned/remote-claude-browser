/**
 * The first thing a new tab shows after signing in: which browser configuration to open. Each is a
 * Chrome of its own, so the card says who it is signed in to Claude as.
 */
import { useEffect, useRef, useState } from "preact/hooks";

import { createAccount, listAccounts, type AccountInfo } from "./accounts";
import "./profile-picker.css";

const LAST_ACCOUNT_KEY = "mirror.last-account";

export function rememberedAccount(): string | null {
  try {
    return window.localStorage.getItem(LAST_ACCOUNT_KEY);
  } catch {
    return null;
  }
}

function remember(id: string) {
  try {
    window.localStorage.setItem(LAST_ACCOUNT_KEY, id);
  } catch {
    // Only a convenience: the next tab simply highlights nothing.
  }
}

/** A stable hue per configuration, so its avatar keeps its colour; the golden angle spreads them. */
function hue(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.codePointAt(0)!) >>> 0;
  return Math.round((value * 137.508) % 360);
}

function initial(account: AccountInfo): string {
  const source = account.email ?? account.name;
  return [...source.trim()][0]?.toUpperCase() ?? "?";
}

function ProfileCard(props: {
  account: AccountInfo;
  last: boolean;
  current: boolean;
  disabled: boolean;
  onPick(): void;
}) {
  const { account } = props;
  const signedIn = account.signedIn === true;
  return (
    <button
      type="button"
      class="profile-card"
      data-last={props.last}
      data-current={props.current}
      disabled={props.disabled}
      onClick={props.onPick}
      style={{ "--avatar-hue": hue(account.id) }}
    >
      <span class="profile-avatar" aria-hidden="true">
        {initial(account)}
      </span>
      <span class="profile-text">
        <span class="profile-name">{account.name}</span>
        <span
          class="profile-login"
          data-signed-in={signedIn}
          data-unavailable={account.unavailable}
        >
          <span class="profile-dot" aria-hidden="true" />
          <span
            class="profile-login-text"
            title={
              account.unavailable
                ? "Claude 已停用此账号，请登录其他账号"
                : (account.email ?? undefined)
            }
          >
            {account.unavailable ? "账号不可用" : signedIn ? (account.email ?? "已登录") : "未登录"}
          </span>
        </span>
      </span>
      <span class="profile-meta">
        {props.current ? (
          <span class="profile-badge profile-current-badge">当前使用</span>
        ) : (
          props.last && <span class="profile-badge">上次使用</span>
        )}
        {account.sessions > 0 && <span class="profile-badge">{account.sessions} 个会话</span>}
        <span class="profile-arrow" aria-hidden="true">
          →
        </span>
      </span>
    </button>
  );
}

export function ProfilePicker(props: {
  onPick(id: string, name: string): Promise<void | false>;
  current?: string | null;
  onBack?(): void;
  username?: string;
  dark: boolean;
  onTheme(): void;
  onLogout(): void;
  logoutPending: boolean;
  logoutError: string | null;
}) {
  const [accounts, setAccounts] = useState<AccountInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const last = rememberedAccount();

  useEffect(() => {
    let active = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const list = await listAccounts(null);
        if (active) {
          setAccounts(list.accounts);
          setLoadError(null);
        }
      } catch (reason) {
        if (active) setLoadError((reason as Error).message);
      } finally {
        pending = false;
      }
    };
    const visible = () => {
      if (!document.hidden) void load();
    };
    void load();
    const timer = setInterval(visible, 5000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refreshAttempt]);
  useEffect(() => {
    if (creating) {
      input.current!.focus();
      input.current!.scrollIntoView({ block: "nearest" });
    }
  }, [creating]);

  const pick = async (id: string, name: string) => {
    setBusy(true);
    setError(null);
    try {
      if ((await props.onPick(id, name)) !== false) remember(id);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const create = async (event: Event) => {
    event.preventDefault();
    if (busy || name.trim() === "") return;
    setError(null);
    setBusy(true);
    try {
      const made = await createAccount(name.trim());
      setRefreshAttempt((value) => value + 1);
      setCreating(false);
      setName("");
      await pick(made.id, made.name);
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  };

  return (
    <main class="profile-picker">
      <div class="profile-topbar">
        <span class="profile-brand">
          <span aria-hidden="true">◈</span> Remote Workspace
        </span>
        <div class="profile-tools">
          {props.onBack && (
            <button type="button" disabled={busy} onClick={props.onBack}>
              返回会话
            </button>
          )}
          {props.username && (
            <span class="profile-user" title={props.username}>
              {props.username}
            </span>
          )}
          <button type="button" onClick={props.onTheme} aria-label="切换外观">
            {props.dark ? "浅色" : "深色"}
          </button>
          <button type="button" onClick={props.onLogout} disabled={props.logoutPending || busy}>
            {props.logoutPending ? "退出中…" : "退出登录"}
          </button>
        </div>
      </div>
      <div class="profile-body">
        <section class="profile-panel" aria-labelledby="profile-picker-title">
          <header>
            <span class="profile-eyebrow">独立浏览器</span>
            <h1 id="profile-picker-title">选择浏览器配置</h1>
            <p>
              选择一个配置，继续上次的工作。
              <br />
              不同配置的网站登录互相独立。
            </p>
          </header>
          {props.logoutError && (
            <p class="profile-error" role="alert">
              {props.logoutError}
            </p>
          )}
          {loadError !== null && (
            <p class="profile-error" role="alert">
              {loadError}
              <button type="button" onClick={() => setRefreshAttempt((value) => value + 1)}>
                重试
              </button>
            </p>
          )}
          {error !== null && (
            <p class="profile-error" role="alert">
              {error}
            </p>
          )}
          {accounts === null && loadError === null ? (
            <div class="profile-list" aria-busy="true">
              <div class="profile-card profile-skeleton" />
              <div class="profile-card profile-skeleton" />
            </div>
          ) : (
            <div class="profile-list">
              {(accounts ?? []).map((account) => (
                <ProfileCard
                  key={account.id}
                  account={account}
                  last={account.id === last}
                  current={account.id === props.current}
                  disabled={busy}
                  onPick={() => void pick(account.id, account.name)}
                />
              ))}
              {creating ? (
                <form class="profile-card profile-create" onSubmit={create}>
                  <input
                    ref={input}
                    value={name}
                    maxLength={40}
                    placeholder="新配置的名字，比如“工作”"
                    aria-label="浏览器配置名称"
                    disabled={busy}
                    onInput={(event) => setName((event.target as HTMLInputElement).value)}
                    onKeyDown={(event) => event.key === "Escape" && setCreating(false)}
                  />
                  <button type="submit" disabled={busy || name.trim() === ""}>
                    {busy ? "创建中…" : props.onBack ? "创建并切换" : "创建并打开"}
                  </button>
                  <button
                    type="button"
                    class="profile-cancel"
                    disabled={busy}
                    onClick={() => setCreating(false)}
                  >
                    取消
                  </button>
                </form>
              ) : (
                accounts !== null && (
                  <button
                    type="button"
                    class="profile-card profile-new"
                    disabled={busy}
                    onClick={() => setCreating(true)}
                  >
                    <span class="profile-avatar" aria-hidden="true">
                      +
                    </span>
                    <span class="profile-name">新建浏览器配置</span>
                  </button>
                )
              )}
            </div>
          )}
          <p class="profile-footnote">同一配置可以同时打开多个会话，网站登录会保留。</p>
        </section>
      </div>
    </main>
  );
}
