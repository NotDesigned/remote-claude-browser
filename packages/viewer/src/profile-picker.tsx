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
  setAccountPlatform,
  checkAccountExit,
  type ProxyChoice,
  type AccountInfo,
  type BrowserPlatform,
} from "./accounts";
import { ExitHealthDetails } from "./exit-health";
import { proxyApi, type ExitHealth } from "./network-api";
import "./profile-picker.css";

const LAST_ACCOUNT_KEY = "mirror.last-account";
const PLATFORM_LABELS: Record<BrowserPlatform, string> = {
  windows: "Windows",
  macos: "Mac",
  linux: "Linux（不推荐）",
};

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

const KYC_LABELS = new Map([
  ["not_required", "当前未要求 KYC"],
  ["created", "KYC 流程已创建"],
  ["approved", "KYC 已通过"],
  ["pending", "KYC 待处理"],
  ["denied", "KYC 未通过"],
]);

function ProfileKyc({ account }: { account: AccountInfo }) {
  const { kyc } = account;
  const checked = kyc ? new Date(kyc.checkedAt) : null;
  return (
    <span class="profile-kyc">
      <span>
        <span class="profile-kyc-status" data-status={kyc?.status}>
          {kyc ? (KYC_LABELS.get(kyc.status) ?? "KYC 状态未知") : "KYC 暂未获取"}
        </span>
        {" · 当前组织"}
      </span>
      <span>
        {checked ? (
          <>
            检测于 <time dateTime={checked.toISOString()}>{checked.toLocaleString()}</time>
          </>
        ) : account.running ? (
          "运行中自动更新"
        ) : (
          "打开浏览器后获取"
        )}
      </span>
    </span>
  );
}

function ProfileCard(props: {
  account: AccountInfo;
  last: boolean;
  current: boolean;
  isDefault: boolean;
  disabled: boolean;
  onPick(): void;
  onDetails(): void;
  onRename(): void;
  onDefault(): void;
  onDelete(): void;
  onProxy(): void;
  onPlatform(): void;
}) {
  const { account } = props;
  const exitRequired = !account.proxyId || account.proxyName === null;
  const signedIn = account.signedIn === true;
  const [menuOpen, setMenuOpen] = useState(false);
  const [remoteCcOpen, setRemoteCcOpen] = useState(false);
  const [remoteCcCopied, setRemoteCcCopied] = useState(false);
  const [exitCheck, setExitCheck] = useState<{
    scope: "browser" | "node";
    health: ExitHealth;
  } | null>(null);
  useEffect(() => setExitCheck(null), [account.proxyId, account.running, account.checkedAt]);
  const checkExit = async () => {
    setExitCheck({ scope: account.running ? "browser" : "node", health: { status: "checking" } });
    try {
      setExitCheck(await checkAccountExit(account.id));
    } catch (error) {
      setExitCheck({
        scope: account.running ? "browser" : "node",
        health: { status: "error", checkedAt: Date.now(), error: (error as Error).message },
      });
    }
  };
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
        data-exit-required={exitRequired}
        disabled={props.disabled || exitRequired}
        onClick={props.onPick}
      >
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
        </span>
        <span class="profile-meta">
          <span class="profile-platform">{PLATFORM_LABELS[account.platform]}</span>
          {exitRequired && (
            <span class="profile-pending">{account.proxyId ? "出口已移除" : "待绑定"}</span>
          )}
          {props.isDefault && <span class="profile-badge profile-default-badge">默认</span>}
          {props.current ? (
            <span class="profile-badge profile-current-badge">当前使用</span>
          ) : (
            props.last && <span class="profile-badge">上次使用</span>
          )}
        </span>
      </button>
      {exitCheck && (
        <div class="profile-exit-health">
          <p>{exitCheck.scope === "browser" ? "当前浏览器出口" : "节点检查（配置尚未运行）"}</p>
          <ExitHealthDetails health={exitCheck.health} />
        </div>
      )}
      {remoteCcOpen && (
        <div class="profile-exit-health profile-remote-cc">
          <p>
            在 remote-cc 中使用（项目目录里运行一次，之后只需 <code>remote-cc</code>）
          </p>
          <code class="profile-remote-cc-command">remote-cc rcb use {account.id}</code>
          <p class="profile-remote-cc-note">
            首次需要 <code>remote-cc account login --rcb {account.id}</code>
            ，登录页会在这个配置的浏览器里打开。
          </p>
          <div class="profile-remote-cc-actions">
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard
                  .writeText(`remote-cc rcb use ${account.id}`)
                  .then(() => setRemoteCcCopied(true))
                  .catch(() => {})
              }
            >
              {remoteCcCopied ? "已复制" : "复制命令"}
            </button>
            <button type="button" onClick={() => setRemoteCcOpen(false)}>
              收起
            </button>
          </div>
        </div>
      )}
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
          <button type="button" disabled={props.disabled} onClick={() => action(props.onPlatform)}>
            设置系统
          </button>
          <button
            type="button"
            disabled={props.disabled || exitRequired || exitCheck?.health.status === "checking"}
            onClick={() => action(() => void checkExit())}
          >
            检查出口
          </button>
          <button type="button" disabled={props.disabled} onClick={() => action(props.onDetails)}>
            查看详情
          </button>
          <button
            type="button"
            disabled={props.disabled || exitRequired}
            onClick={() =>
              action(() => {
                setRemoteCcCopied(false);
                setRemoteCcOpen(true);
              })
            }
          >
            在 remote-cc 中使用
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
  onPick(id: string, startApple?: boolean): Promise<void>;
  current?: string | null;
  onBack?(): void;
  onChanged?(): void;
  onDeleted?(): void;
  workspace?: WorkspaceMenuProps;
  proxyManagerOpen?: boolean;
  requiredProxyId?: string;
  dark: boolean;
  onTheme(): void;

  logoutError: string | null;
}) {
  const [accounts, setAccounts] = useState<AccountInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ profile?: string; exit?: string }>({});
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [creationProxies, setCreationProxies] = useState<ProxyChoice[] | null>(null);
  const [creationProxyId, setCreationProxyId] = useState("");
  const [platforms, setPlatforms] = useState<BrowserPlatform[]>([]);
  const [defaultPlatform, setDefaultPlatform] = useState<BrowserPlatform>("windows");
  const [creationPlatform, setCreationPlatform] = useState<BrowserPlatform>("windows");
  const [proxyRefresh, setProxyRefresh] = useState(0);
  const [creationProgress, setCreationProgress] = useState("");
  const [proxyEditor, setProxyEditor] = useState<{
    account: AccountInfo;
    choices: ProxyChoice[];
    value: string;
  } | null>(null);
  const [platformEditor, setPlatformEditor] = useState<{
    account: AccountInfo;
    value: BrowserPlatform;
  } | null>(null);
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const proxySelect = useRef<HTMLSelectElement>(null);
  const platformSelect = useRef<HTMLSelectElement>(null);
  const last = rememberedAccount();

  useEffect(() => {
    if (!creating || props.proxyManagerOpen) return;
    let active = true;
    setCreationProxies(null);
    void listProxyChoices()
      .then((available) => {
        if (!active) return;
        const choices = available.filter(
          (node) => !props.requiredProxyId || node.id === props.requiredProxyId,
        );
        setCreationProxies(choices);
        setCreationProxyId((previous) =>
          choices.some((node) => node.id === previous) ? previous : (props.requiredProxyId ?? ""),
        );
      })
      .catch((reason: Error) => {
        if (active) setError(reason.message);
      });
    return () => {
      active = false;
    };
  }, [creating, props.proxyManagerOpen, proxyRefresh, props.requiredProxyId]);

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
          setPlatforms(list.platforms);
          setDefaultPlatform(list.defaultPlatform);
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
  useEffect(() => {
    if (platformEditor) {
      platformSelect.current!.focus();
      platformSelect.current!.scrollIntoView({ block: "nearest" });
    }
  }, [platformEditor?.account.id]);

  useEffect(() => {
    if (proxyEditor) {
      proxySelect.current!.focus();
      proxySelect.current!.scrollIntoView({ block: "nearest" });
    }
  }, [proxyEditor?.account.id]);

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
      setPlatformEditor(null);
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

  const savePlatform = async (event: Event) => {
    event.preventDefault();
    const { account, value } = platformEditor!;
    if (account.platform === value) {
      setPlatformEditor(null);
      return;
    }
    if (
      !window.confirm(
        [
          `将「${account.name}」的系统身份从「${PLATFORM_LABELS[account.platform]}」切换为「${PLATFORM_LABELS[value]}」。`,
          "这会改变网站看到的系统和设备特征，并关闭该配置在所有设备上打开的页面。重新连接时会按新身份启动。",
          "频繁切换可能触发平台风控或要求重新验证。请确认你了解影响并希望继续。",
        ].join("\n\n"),
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await setAccountPlatform(account.id, value);
      setPlatformEditor(null);
      changed();
      if (props.current === account.id) window.location.reload();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const open = async (id: string, startApple?: boolean) => {
    await props.onPick(id, startApple);
    remember(id);
  };

  const pick = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await open(id);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const creationProxy = creationProxies?.find((node) => node.id === creationProxyId);
  const canCreate = !busy && name.trim() !== "" && !!creationProxy;
  const create = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!canCreate) return;
    const startApple = (event.submitter as HTMLButtonElement | null)?.value === "apple";
    setError(null);
    setBusy(true);
    setCreationProgress("正在检查出口…");
    let created = false;
    try {
      const { health } = await proxyApi.check(creationProxyId);
      if (health.status !== "healthy")
        throw new Error(health.error ?? "出口检查未通过，请重试或选择其他节点");
      setCreationProgress("正在创建并打开…");
      const made = await createAccount(name.trim(), creationProxyId, undefined, creationPlatform);
      made.proxyName = creationProxy.name;
      created = true;
      setAccounts((previous) => [...previous!, made]);
      changed();
      setCreating(false);
      setName("");
      await open(made.id, startApple);
    } catch (reason) {
      setError((created ? "配置已创建，打开失败，可从列表重试：" : "") + (reason as Error).message);
    } finally {
      setBusy(false);
      setCreationProgress("");
    }
  };

  const groups = new Map<string | null, [AccountInfo, ...AccountInfo[]]>();
  const visible = (accounts ?? []).filter(
    (account) => !props.requiredProxyId || account.proxyId === props.requiredProxyId,
  );
  visible.sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId));
  for (const account of visible) {
    const exit = account.proxyId ?? null;
    const group = groups.get(exit);
    if (group) group.push(account);
    else groups.set(exit, [account]);
  }
  const selectNode = (next: typeof selection) => {
    setSelection(next);
    setEditing(null);
    setCreating(false);
    setProxyEditor(null);
    setPlatformEditor(null);
    setError(null);
  };
  const selected = visible.find((account) => account.id === selection.profile);
  const selectedGroup = selection.exit ? groups.get(selection.exit) : undefined;
  const editingAccount = visible.find((account) => account.id === editing);
  return (
    <main class="profile-picker">
      <div class="profile-topbar">
        <div class="profile-tools">
          {props.workspace && <WorkspaceMenu {...props.workspace} />}
          {props.onBack && (
            <button type="button" disabled={busy} onClick={props.onBack}>
              {props.requiredProxyId ? "返回 API" : "返回会话"}
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
            <h1 id="profile-picker-title">
              {props.requiredProxyId ? "选择授权浏览器" : "选择浏览器配置"}
            </h1>
            <p>
              {props.requiredProxyId
                ? "选择与授权使用相同出口的配置，打开后继续授权；也可以新建。"
                : "点浏览器直接打开。通过「⋯」设置出口，或点出口查看共用它的配置。"}
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
          {error !== null && !creating && (
            <p class="profile-error" role="alert">
              {error}
            </p>
          )}
          {proxyEditor && (
            <form class="profile-proxy-editor" onSubmit={saveProxy}>
              <label for="profile-proxy">「{proxyEditor.account.name}」的网络出口</label>
              <select
                id="profile-proxy"
                ref={proxySelect}
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
          {platformEditor && (
            <form class="profile-proxy-editor profile-platform-editor" onSubmit={savePlatform}>
              <label for="profile-platform">「{platformEditor.account.name}」的系统身份</label>
              <select
                id="profile-platform"
                ref={platformSelect}
                disabled={busy}
                value={platformEditor.value}
                onChange={(event) =>
                  setPlatformEditor({
                    ...platformEditor,
                    value: event.currentTarget.value as BrowserPlatform,
                  })
                }
              >
                {platforms.map((platform) => (
                  <option key={platform} value={platform}>
                    {PLATFORM_LABELS[platform]}
                  </option>
                ))}
              </select>
              <p>决定网站看到的操作系统。同一配置的所有会话使用相同身份。</p>
              <div>
                <button type="submit" disabled={busy}>
                  {busy ? "保存中…" : "保存系统"}
                </button>
                <button type="button" disabled={busy} onClick={() => setPlatformEditor(null)}>
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
              {editingAccount && (
                <form class="profile-card profile-create profile-rename-form" onSubmit={rename}>
                  <label class="profile-editor-label" for="profile-rename-name">
                    重命名「{editingAccount.name}」
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
              )}
              {accounts !== null && (
                <div class="profile-map" aria-label="浏览器与网络出口">
                  <div class="map-head">
                    <span>浏览器配置</span>
                    <span>网络出口</span>
                  </div>
                  {Array.from(groups, ([exit, members]) => (
                    <div
                      class="map-group"
                      role="group"
                      aria-label={exit ? (members[0].proxyName ?? "节点已移除") : "待绑定出口"}
                      key={exit ?? "unbound"}
                      data-bound={Boolean(exit)}
                      data-highlight={Boolean(exit && selection.exit === exit)}
                    >
                      <div class="map-members">
                        {members.map((account) => (
                          <div
                            class="map-member"
                            key={account.id}
                            data-highlight={selected?.id === account.id}
                          >
                            <ProfileCard
                              account={account}
                              last={account.id === last}
                              current={account.id === props.current}
                              isDefault={account.id === defaultId}
                              disabled={busy}
                              onPick={() => void pick(account.id)}
                              onDetails={() => selectNode({ profile: account.id })}
                              onRename={() => {
                                setError(null);
                                setCreating(false);
                                setProxyEditor(null);
                                setPlatformEditor(null);
                                setName(account.name);
                                setEditing(account.id);
                              }}
                              onDefault={() => void makeDefault(account.id)}
                              onDelete={() => void remove(account)}
                              onProxy={() => void editProxy(account)}
                              onPlatform={() => {
                                setError(null);
                                setCreating(false);
                                setEditing(null);
                                setProxyEditor(null);
                                setPlatformEditor({ account, value: account.platform });
                              }}
                            />
                          </div>
                        ))}
                      </div>
                      {exit && (
                        <button
                          type="button"
                          class="map-exit"
                          aria-pressed={selection.exit === exit}
                          data-linked={selected?.proxyId === exit}
                          disabled={busy}
                          onClick={() => selectNode({ exit })}
                        >
                          <strong>{members[0].proxyName ?? "节点已移除"}</strong>
                          <span>
                            {members[0].proxyVisibility === "shared"
                              ? "共享 · "
                              : members[0].proxyVisibility === "private"
                                ? "私有 · "
                                : ""}
                            {members.length} 个配置
                          </span>
                        </button>
                      )}
                    </div>
                  ))}
                  {props.requiredProxyId && !visible.length && (
                    <p class="profile-footnote">暂时没有绑定此出口的浏览器配置。</p>
                  )}
                </div>
              )}
              {selected && !editing && !creating && !proxyEditor && !platformEditor && (
                <section class="map-detail" aria-label="配置详情">
                  <div class="map-summary">
                    <strong>{selected.name}</strong>
                    <span>
                      {PLATFORM_LABELS[selected.platform]} ·{" "}
                      {selected.proxyName ?? (selected.proxyId ? "节点已移除" : "未绑定出口")}
                    </span>
                    {selected.signedIn && selected.email && <span>{selected.email}</span>}
                    {selected.signedIn && <ProfileKyc account={selected} />}
                    {selected.timeZone && <span>时区：{selected.timeZone}</span>}
                    {selected.exitIp && <span>启动时 IP：{selected.exitIp}</span>}
                    {selected.sessions > 0 && (
                      <span>
                        {selected.onlineSessions} 在线 ·{" "}
                        {selected.sessions - selected.onlineSessions} 休眠
                      </span>
                    )}
                    {selected.running && <span>运行中</span>}
                  </div>
                  <button type="button" onClick={() => setSelection({})}>
                    关闭详情
                  </button>
                </section>
              )}
              {selectedGroup && !editing && !creating && !proxyEditor && !platformEditor && (
                <section class="map-detail" aria-label="出口详情">
                  <div class="map-summary">
                    <strong>{selectedGroup[0].proxyName ?? "节点已移除"}</strong>
                    <span>{selectedGroup.map((account) => account.name).join("、")}</span>
                  </div>
                </section>
              )}
              {creating ? (
                <form class="profile-card profile-create profile-new-form" onSubmit={create}>
                  <label for="profile-create-name">配置名称</label>
                  <input
                    id="profile-create-name"
                    ref={input}
                    value={name}
                    maxLength={40}
                    placeholder="新配置的名字，比如“工作”"
                    aria-label="浏览器配置名称"
                    disabled={busy}
                    onInput={(event) => setName((event.target as HTMLInputElement).value)}
                    onKeyDown={(event) => event.key === "Escape" && setCreating(false)}
                  />
                  <label for="profile-create-platform">系统身份</label>
                  <select
                    id="profile-create-platform"
                    value={creationPlatform}
                    disabled={busy}
                    onChange={(event) =>
                      setCreationPlatform(event.currentTarget.value as BrowserPlatform)
                    }
                  >
                    {platforms.map((platform) => (
                      <option key={platform} value={platform}>
                        {PLATFORM_LABELS[platform]}
                        {platform === defaultPlatform ? "（默认）" : ""}
                      </option>
                    ))}
                  </select>
                  <label for="profile-create-proxy">网络出口</label>
                  <select
                    id="profile-create-proxy"
                    required
                    value={creationProxyId}
                    disabled={busy || creationProxies === null || creationProxies.length === 0}
                    onChange={(event) => {
                      setCreationProxyId(event.currentTarget.value);
                      setError(null);
                    }}
                  >
                    <option value="" disabled>
                      {creationProxies === null ? "正在加载节点…" : "请选择出口节点"}
                    </option>
                    {creationProxies?.map((node) => (
                      <option key={node.id} value={node.id}>
                        {node.name} · {node.visibility === "shared" ? "共享" : "私有"}
                      </option>
                    ))}
                  </select>
                  {creationProxies?.length === 0 ? (
                    <div class="profile-create-help">
                      <p>还没有可用节点，先导入节点或订阅，再回来选择出口。</p>
                      {props.workspace && (
                        <button
                          type="button"
                          class="profile-cancel"
                          disabled={busy}
                          onClick={() => props.workspace!.onNavigate("proxies")}
                        >
                          导入节点或订阅
                        </button>
                      )}
                    </div>
                  ) : (
                    <p class="profile-create-help">将先检查所选出口，通过后创建并打开浏览器。</p>
                  )}
                  {error && (
                    <p class="profile-error" role="alert">
                      {error}
                    </p>
                  )}
                  <div class="profile-create-actions">
                    <button type="submit" disabled={!canCreate}>
                      {busy ? creationProgress : "检查并打开"}
                    </button>
                    {!props.requiredProxyId && (
                      <button
                        type="submit"
                        value="apple"
                        class="profile-cancel"
                        disabled={!canCreate}
                      >
                        检查并注册 Apple 账户
                      </button>
                    )}
                    <button
                      type="button"
                      class="profile-cancel"
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        setProxyRefresh((value) => value + 1);
                      }}
                    >
                      刷新节点
                    </button>
                    <button
                      type="button"
                      class="profile-cancel"
                      disabled={busy}
                      onClick={() => {
                        setCreating(false);
                        setError(null);
                      }}
                    >
                      取消
                    </button>
                  </div>
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
                      setProxyEditor(null);
                      setPlatformEditor(null);
                      setName("");
                      setCreationProxyId(props.requiredProxyId ?? "");
                      setCreationPlatform(defaultPlatform);
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
