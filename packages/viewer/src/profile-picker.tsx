import { WorkspaceMenu, type WorkspaceMenuProps } from "./workspace-menu";
/**
 * The first thing a new tab shows after signing in: which browser configuration to open. Each is a
 * Chrome of its own, so the card says who it is signed in to Claude as.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import {
  createAccount,
  deleteAccount,
  listAccounts,
  renameAccount,
  setDefaultAccount,
  listProxyChoices,
  setAccountProxy,
  type ProxyChoice,
  type AccountInfo,
} from "./accounts";
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
  isDefault: boolean;
  disabled: boolean;
  onPick(): void;
  onRename(): void;
  onDefault(): void;
  onDelete(): void;
  onProxy(): void;
}) {
  const { account } = props;
  const signedIn = account.signedIn === true;
  const [menuOpen, setMenuOpen] = useState(false);
  const entry = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => {
      if (!entry.current!.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        toggle.current!.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);
  const action = (run: () => void) => {
    setMenuOpen(false);
    run();
  };
  return (
    <div class="profile-entry" ref={entry} data-menu-open={menuOpen}>
      <button
        type="button"
        class="profile-card"
        data-last={props.last}
        data-current={props.current}
        data-exit-required={!account.proxyId}
        disabled={props.disabled || !account.proxyId}
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
              {account.unavailable
                ? "账号不可用"
                : signedIn
                  ? (account.email ?? "已登录")
                  : "未登录"}
            </span>
          </span>
          <span class="profile-exit">
            出口：{account.proxyName ?? (account.proxyId ? "节点已移除" : "未选择（禁止打开）")}
          </span>
          <span class="profile-exit" title={account.timeZone}>
            时区：{account.timeZone ?? "按出口自动确定"}
          </span>
          {!account.proxyId && <span class="profile-exit">请通过 ⋯ 设置出口并绑定节点后打开</span>}
        </span>
        <span class="profile-meta">
          {props.isDefault && <span class="profile-badge profile-default-badge">默认</span>}
          {props.current ? (
            <span class="profile-badge profile-current-badge">当前使用</span>
          ) : (
            props.last && <span class="profile-badge">上次使用</span>
          )}
          {account.sessions > 0 && <span class="profile-badge">{account.sessions} 个会话</span>}
        </span>
      </button>
      <button
        type="button"
        class="profile-menu-toggle"
        ref={toggle}
        aria-label={`管理「${account.name}」`}
        aria-expanded={menuOpen}
        disabled={props.disabled}
        onClick={() => setMenuOpen(!menuOpen)}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      {menuOpen && (
        <div class="profile-actions" role="group" aria-label="配置操作">
          <button type="button" disabled={props.disabled} onClick={() => action(props.onProxy)}>
            设置出口
          </button>
          <button
            type="button"
            aria-label={`重命名「${account.name}」`}
            disabled={props.disabled}
            onClick={() => action(props.onRename)}
          >
            重命名
          </button>
          {!props.isDefault && (
            <>
              <button
                type="button"
                aria-label={`设「${account.name}」为默认`}
                disabled={props.disabled}
                onClick={() => action(props.onDefault)}
              >
                设为默认
              </button>
              <button
                type="button"
                class="profile-delete"
                aria-label={`删除「${account.name}」`}
                disabled={props.disabled}
                onClick={() => action(props.onDelete)}
              >
                删除
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ProfilePicker(props: {
  onPick(id: string, name: string): Promise<void | false>;
  current?: string | null;
  onBack?(): void;
  onChanged?(): void;
  onDeleted?(): void;
  workspace?: WorkspaceMenuProps;
  dark: boolean;
  onTheme(): void;

  logoutError: string | null;
}) {
  const [accounts, setAccounts] = useState<AccountInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [proxyEditor, setProxyEditor] = useState<{
    account: AccountInfo;
    choices: ProxyChoice[];
    value: string;
  } | null>(null);
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
          setDefaultId(list.default);
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
    if (accounts !== null && (creating || editing !== null)) {
      input.current!.focus();
      input.current!.scrollIntoView({ block: "nearest" });
    }
  }, [creating, editing, accounts === null]);

  const changed = () => {
    setRefreshAttempt((value) => value + 1);
    props.onChanged?.();
  };
  const rename = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await renameAccount(editing!, name.trim());
      setAccounts((previous) =>
        previous!.map((account) =>
          account.id === editing ? { ...account, name: saved.name } : account,
        ),
      );
      setEditing(null);
      setName("");
      changed();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const makeDefault = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await setDefaultAccount(id);
      setDefaultId(id);
      changed();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (account: AccountInfo) => {
    if (
      !window.confirm(
        `删除「${account.name}」？它的网站登录和浏览数据会被清除，正在使用它的本设备会话会切回默认配置。此操作不能恢复。`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(account.id);
      setAccounts((previous) => previous!.filter((entry) => entry.id !== account.id));
      changed();
      if (props.current === account.id) props.onDeleted!();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const editProxy = async (account: AccountInfo) => {
    setBusy(true);
    setError(null);
    try {
      setProxyEditor({ account, choices: await listProxyChoices(), value: account.proxyId ?? "" });
      setEditing(null);
      setCreating(false);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const saveProxy = async (event: Event) => {
    event.preventDefault();
    const { account, value, choices } = proxyEditor!;
    if ((account.proxyId ?? "") === value) {
      setProxyEditor(null);
      return;
    }
    if (account.proxyId || account.running) {
      const previous = account.proxyName ?? "未选择出口";
      const next = choices.find((node) => node.id === value)?.name ?? "未选择出口（禁止打开）";
      const warning = [`将「${account.name}」的网络出口从「${previous}」更换为「${next}」。`];
      if (account.running) warning.push("这会关闭该配置在所有设备上打开的页面。");
      warning.push(
        account.proxyId
          ? "频繁更换账号的出口 IP 可能触发平台风控，要求重新验证或限制账号。请确认你了解影响并希望继续。"
          : "请确认你希望继续。",
      );
      if (!window.confirm(warning.join("\n\n"))) return;
    }
    setBusy(true);
    setError(null);
    try {
      await setAccountProxy(account.id, value || null);
      setProxyEditor(null);
      changed();
      if (props.current === account.id) window.location.reload();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
      setAccounts((previous) => [...previous!, made]);
      changed();
      setCreating(false);
      setName("");
      await editProxy(made);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
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
          {props.workspace && <WorkspaceMenu {...props.workspace} />}
          {props.onBack && (
            <button type="button" disabled={busy} onClick={props.onBack}>
              返回会话
            </button>
          )}
          <button type="button" onClick={props.onTheme} aria-label="切换外观">
            {props.dark ? "浅色" : "深色"}
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
          {proxyEditor && (
            <form class="profile-proxy-editor" onSubmit={saveProxy}>
              <label for="profile-proxy">「{proxyEditor.account.name}」的网络出口</label>
              <select
                id="profile-proxy"
                disabled={busy}
                value={proxyEditor.value}
                onChange={(event) =>
                  setProxyEditor({ ...proxyEditor, value: event.currentTarget.value })
                }
              >
                <option value="">未选择出口（禁止打开）</option>
                {proxyEditor.choices.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name} · {node.visibility === "shared" ? "共享" : "私有"}
                  </option>
                ))}
              </select>
              <p>
                绑定节点后才能打开配置。同一配置的所有会话使用这个出口，网页资源、DNS 和 WebRTC
                一起切换。
              </p>
              <div>
                <button type="submit" disabled={busy}>
                  {busy ? "保存中…" : "保存出口"}
                </button>
                <button type="button" disabled={busy} onClick={() => setProxyEditor(null)}>
                  取消
                </button>
              </div>
            </form>
          )}
          {accounts === null && loadError === null ? (
            <div class="profile-list" aria-busy="true">
              <div class="profile-card profile-skeleton" />
              <div class="profile-card profile-skeleton" />
            </div>
          ) : (
            <div class="profile-list">
              {[...(accounts ?? [])]
                .sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId))
                .map((account) =>
                  editing === account.id ? (
                    <form
                      key={account.id}
                      class="profile-card profile-create profile-rename-form"
                      onSubmit={rename}
                    >
                      <label class="profile-editor-label" for="profile-rename-name">
                        重命名「{account.name}」
                      </label>
                      <input
                        id="profile-rename-name"
                        ref={input}
                        aria-label="配置新名称"
                        value={name}
                        maxLength={40}
                        disabled={busy}
                        onInput={(event) => setName(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            setEditing(null);
                            setError(null);
                          }
                        }}
                      />
                      <button type="submit" disabled={busy || name.trim() === ""}>
                        {busy ? "保存中…" : "保存"}
                      </button>
                      <button
                        type="button"
                        class="profile-cancel"
                        disabled={busy}
                        onClick={() => {
                          setEditing(null);
                          setError(null);
                        }}
                      >
                        取消
                      </button>
                    </form>
                  ) : (
                    <ProfileCard
                      key={account.id}
                      account={account}
                      last={account.id === last}
                      current={account.id === props.current}
                      isDefault={account.id === defaultId}
                      disabled={busy}
                      onPick={() => void pick(account.id, account.name)}
                      onRename={() => {
                        setError(null);
                        setCreating(false);
                        setName(account.name);
                        setEditing(account.id);
                      }}
                      onDefault={() => void makeDefault(account.id)}
                      onDelete={() => void remove(account)}
                      onProxy={() => void editProxy(account)}
                    />
                  ),
                )}
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
                    {busy ? "创建中…" : "创建并设置出口"}
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
                    onClick={() => {
                      setError(null);
                      setEditing(null);
                      setName("");
                      setCreating(true);
                    }}
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
          <p class="profile-footnote">
            同一配置的多个会话共享网站登录；可在「我的账号」管理各设备会话。
          </p>
        </section>
      </div>
    </main>
  );
}
