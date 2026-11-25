import { useEffect, useRef, useState } from "preact/hooks";
import { Panel, useConfirm } from "./panel";
import { usePolling } from "./polling";
import { adminMailboxApi, mailboxLabel } from "./mailboxes";
import {
  createUser,
  deleteUser,
  adminOverview,
  endAdminSession,
  type AdminSession,
  updateUser,
  type FrontendUser,
  type ManagedUser,
  type UserChanges,
  type UserRole,
} from "./users";
import "./user-panel.css";

interface UserFields {
  id: string | null;
  username: string;
  password: string;
  role: UserRole;
  enabled: boolean;
  maxSessions: string;
}

const emptyUser = (): UserFields => ({
  id: null,
  username: "",
  password: "",
  role: "user",
  enabled: true,
  maxSessions: "",
});

function UserMailboxes({ userId, enabled }: { userId: string; enabled: boolean }) {
  const [mailboxes, setMailboxes] =
    useState<Awaited<ReturnType<typeof adminMailboxApi.addresses>>>();
  const [assigning, setAssigning] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void adminMailboxApi.addresses(userId).then(
      (result) => {
        if (active) setMailboxes(result);
      },
      (failure: Error) => {
        if (active) setError(failure.message);
      },
    );
    return () => {
      active = false;
    };
  }, [userId]);

  if (!mailboxes?.enabled && !error) return null;
  const assign = async (form: HTMLFormElement) => {
    const current = mailboxes!;
    const address = String(new FormData(form).get("address"));
    setAssigning(true);
    setError(undefined);
    try {
      const result = await adminMailboxApi.assign(userId, address);
      setMailboxes({ ...current, addresses: [...current.addresses, result.address] });
      form.reset();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setAssigning(false);
    }
  };
  return (
    <form
      class="user-panel-form admin-mailboxes"
      aria-busy={assigning}
      onSubmit={(event) => {
        event.preventDefault();
        void assign(event.currentTarget);
      }}
    >
      <h3>收件地址</h3>
      {mailboxes?.addresses.length ? (
        <ul>
          {mailboxes.addresses.map((address) => (
            <li key={address.id}>{mailboxLabel(address)}</li>
          ))}
        </ul>
      ) : (
        mailboxes && <p class="user-panel-muted">尚未分配地址</p>
      )}
      {mailboxes?.enabled && enabled && (
        <>
          <label>
            已有邮箱地址
            <input
              type="email"
              name="address"
              maxLength={254}
              placeholder={mailboxes.domain ? `name@${mailboxes.domain}` : undefined}
              autoComplete="off"
              autoCapitalize="none"
              spellcheck={false}
              disabled={assigning}
              required
            />
          </label>
          <div class="user-panel-actions">
            <button type="submit" class="user-panel-save" disabled={assigning}>
              {assigning ? "正在分配…" : "分配地址"}
            </button>
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

export function AdminPanel({
  current,
  onClose,
  onChanged,
}: {
  current: FrontendUser;
  onClose(): void;
  onChanged(): void;
}) {
  const { confirm, dialog } = useConfirm();
  const baseline = useRef<ManagedUser | null>(null);
  // Every 5 s: a failed poll shows until one succeeds, apart from the actions' own messages.
  const polled = usePolling(adminOverview, 5000);
  const overview = polled.data ?? null;
  const users = overview?.users ?? [];
  const [tab, setTab] = useState<"users" | "sessions" | "resources">("users");
  const [sessionUser, setSessionUser] = useState("");
  const [fields, setFields] = useState<UserFields>(emptyUser);
  const loading = polled.data === undefined && polled.error === null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const choose = (user?: ManagedUser) => {
    baseline.current = user ?? null;
    setFields(
      user
        ? {
            ...user,
            password: "",
            maxSessions: user.maxSessions === null ? "" : String(user.maxSessions),
          }
        : emptyUser(),
    );
    setError(null);
    setNotice(null);
  };
  const changes: UserChanges = {
    ...(fields.username.trim() !== baseline.current?.username
      ? { username: fields.username.trim() }
      : {}),
    ...(fields.role !== baseline.current?.role ? { role: fields.role } : {}),
    ...(fields.enabled !== baseline.current?.enabled ? { enabled: fields.enabled } : {}),
    ...(fields.password ? { password: fields.password } : {}),
    ...((fields.maxSessions === "" ? null : Number(fields.maxSessions)) !==
    baseline.current?.maxSessions
      ? { maxSessions: fields.maxSessions === "" ? null : Number(fields.maxSessions) }
      : {}),
  };
  const hasChanges = fields.id === null || Object.keys(changes).length > 0;
  const reload = async () => polled.setData(await adminOverview());
  const save = async () => {
    if (pending || !hasChanges) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const saved =
        fields.id === null
          ? await createUser({
              username: fields.username.trim(),
              password: fields.password,
              role: fields.role,
              maxSessions: fields.maxSessions === "" ? null : Number(fields.maxSessions),
            })
          : await updateUser(fields.id, changes);
      baseline.current = saved;
      setFields({
        ...saved,
        password: "",
        maxSessions: saved.maxSessions === null ? "" : String(saved.maxSessions),
      });
      setNotice(fields.id === null ? `已创建用户「${saved.username}」。` : "更改已保存。");
      onChanged();
      await reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "保存失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  };
  const remove = async () => {
    if (
      !fields.id ||
      pending ||
      !(await confirm({
        title: `删除用户「${fields.username}」及其数据？`,
        message: [
          "这会永久删除浏览器资料、私有代理来源、私有 CPA 授权和个人 API Key，无法恢复。",
          "需要保留资料时，请改用停用。",
        ],
        confirmLabel: "删除用户与数据",
        danger: true,
      }))
    )
      return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await deleteUser(fields.id);
      baseline.current = null;
      setFields(emptyUser());
      setNotice("用户及其数据已删除。");
      onChanged();
      await reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "删除失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  };

  const endSession = async (session: AdminSession) => {
    if (
      pending ||
      !(await confirm({
        title: `结束「${session.username}」的${session.label}？`,
        message: "远程页面会关闭，浏览器登录资料保留。",
        confirmLabel: "结束会话",
        danger: true,
      }))
    )
      return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await endAdminSession(session.sid);
      await reload();
      setNotice("会话已结束。");
      onChanged();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  };
  const memory = (value: number | null | undefined) =>
    value == null ? "—" : `${(value / 1024 ** 3).toFixed(1)} GB`;
  const visibleSessions =
    overview?.sessions.filter((session) => !sessionUser || session.userId === sessionUser) ?? [];

  return (
    <Panel
      variant="user"
      onClose={onClose}
      titleId="user-panel-title"
      title="管理后台"
      description="管理用户、会话与服务资源。浏览器资料按用户隔离。"
      descriptionId="user-panel-description"
      closeLabel="关闭管理后台"
    >
      {error && (
        <p class="user-panel-message user-panel-error" role="alert">
          {error}
        </p>
      )}
      {polled.error && polled.error !== error && (
        <p class="user-panel-message user-panel-error" role="alert">
          {polled.error}
        </p>
      )}
      {notice && (
        <p class="user-panel-message" role="status">
          {notice}
        </p>
      )}
      <nav class="admin-tabs" aria-label="管理栏目">
        {(
          [
            ["users", "用户"],
            ["sessions", "会话"],
            ["resources", "资源"],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          disabled={pending || loading}
          onClick={() => void reload().catch((failure: Error) => setError(failure.message))}
        >
          刷新
        </button>
      </nav>
      {overview && (
        <div class="admin-summary" aria-label="运行概况">
          <span>{users.length} 个用户</span>
          <span>{users.filter((user) => user.onlineSessions > 0).length} 人在线</span>
          <span>{overview.sessions.filter((session) => session.online).length} 个在线会话</span>
          <span>{overview.sessions.length} 个会话</span>
        </div>
      )}
      {tab === "users" && (
        <div class="user-panel-content" aria-busy={pending || loading}>
          <nav class="user-panel-list" aria-label="前端用户">
            <button
              type="button"
              class="user-panel-new"
              disabled={pending}
              aria-pressed={fields.id === null}
              onClick={() => choose()}
            >
              ＋ 新建用户
            </button>
            {loading && (
              <p class="user-panel-muted" role="status">
                正在加载用户…
              </p>
            )}
            {users.map((user) => (
              <button
                type="button"
                key={user.id}
                disabled={pending}
                class="user-panel-person"
                aria-pressed={fields.id === user.id}
                onClick={() => choose(user)}
              >
                <span>
                  {user.username}
                  {user.id === current.id && <small>当前用户</small>}
                </span>
                <span class="user-panel-muted">
                  {user.role === "admin" ? "管理员" : "普通用户"}
                  {!user.enabled ? " · 已停用" : user.onlineSessions > 0 ? " · 在线" : " · 离线"}
                  {typeof user.sso === "string" &&
                    ` · 单点登录${user.sso ? `（${user.sso}）` : ""}`}
                </span>
                <span class="user-panel-muted">
                  {user.profileCount} 个配置 · {user.onlineSessions} 在线 / {user.sessionCount}{" "}
                  个会话
                  {user.maxSessions !== null && ` · 上限 ${user.maxSessions}`}
                </span>
              </button>
            ))}
          </nav>
          <div>
            <form
              class="user-panel-form"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <h3>{fields.id === null ? "新建用户" : "编辑用户"}</h3>
              <label>
                用户名
                <input
                  name="username"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellcheck={false}
                  required
                  maxLength={64}
                  value={fields.username}
                  disabled={pending}
                  onInput={(event) => setFields({ ...fields, username: event.currentTarget.value })}
                />
              </label>
              <label>
                {fields.id === null ? "初始密码" : "新密码（留空则保持）"}
                <input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required={fields.id === null}
                  value={fields.password}
                  disabled={pending}
                  onInput={(event) => setFields({ ...fields, password: event.currentTarget.value })}
                />
              </label>
              {fields.id !== null && (
                <p class="user-panel-muted">设置新密码后，该用户需要重新登录。</p>
              )}
              <label>
                权限
                <select
                  name="role"
                  value={fields.role}
                  disabled={pending}
                  onChange={(event) =>
                    setFields({ ...fields, role: event.currentTarget.value as UserRole })
                  }
                >
                  <option value="user">普通用户</option>
                  <option value="admin">管理员</option>
                </select>
              </label>
              <label>
                会话上限（留空不限）
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={fields.maxSessions}
                  disabled={pending}
                  onInput={(event) =>
                    setFields({ ...fields, maxSessions: event.currentTarget.value })
                  }
                />
              </label>
              <p class="user-panel-muted">
                包含在线和休眠会话。0 禁止新建；调整上限不结束已有会话，重连不占新名额。
              </p>
              {fields.id !== null && (
                <button
                  type="button"
                  class="admin-view-sessions"
                  onClick={() => {
                    setSessionUser(fields.id!);
                    setTab("sessions");
                  }}
                >
                  查看此用户的会话
                </button>
              )}
              {fields.id !== null && (
                <label class="user-panel-check">
                  <input
                    type="checkbox"
                    checked={fields.enabled}
                    disabled={pending || fields.id === current.id}
                    onChange={(event) =>
                      setFields({ ...fields, enabled: event.currentTarget.checked })
                    }
                  />
                  启用账号
                </label>
              )}
              {fields.id !== null && (
                <p class="user-panel-muted">
                  停用会立即结束所有浏览器会话、停止私有 CPA，并使该用户的个人 API Key
                  无法调用；浏览器数据和授权凭据保留，重新启用后可继续使用。私有 CPA 需要手动启动。
                </p>
              )}
              <footer class="user-panel-actions">
                <button
                  class="user-panel-save"
                  type="submit"
                  disabled={pending || loading || !hasChanges}
                >
                  {pending ? "处理中…" : fields.id === null ? "创建用户" : "保存更改"}
                </button>
                {fields.id !== null && fields.id !== current.id && (
                  <button
                    class="user-panel-delete"
                    type="button"
                    disabled={pending}
                    onClick={() => void remove()}
                  >
                    删除用户与数据
                  </button>
                )}
              </footer>
            </form>
            {fields.id !== null && (
              <UserMailboxes
                key={fields.id}
                userId={fields.id}
                enabled={baseline.current!.enabled}
              />
            )}
          </div>
        </div>
      )}
      {tab === "sessions" && (
        <section class="admin-section" aria-label="会话管理">
          <label class="admin-filter">
            所属用户
            <select
              aria-label="所属用户"
              value={sessionUser}
              onChange={(event) => setSessionUser(event.currentTarget.value)}
            >
              <option value="">全部用户</option>
              {users.map((user) => (
                <option value={user.id}>{user.username}</option>
              ))}
            </select>
          </label>
          <p class="user-panel-muted">
            离线会话仍占名额；结束会话会释放名额并关闭页面，保留浏览器登录资料。
          </p>
          {visibleSessions.length === 0 && <p class="user-panel-muted">没有会话。</p>}
          <ul class="admin-session-list">
            {visibleSessions.map((session) => (
              <li key={session.sid}>
                <div>
                  <strong>
                    {session.username} · {session.label}
                  </strong>
                  <p>
                    {session.profileName}
                    {session.currentDevice && " · 当前设备"}
                  </p>
                  <p class="user-panel-muted">
                    {session.online ? "在线" : "离线"} · {session.running ? "页面运行中" : "已休眠"}{" "}
                    · 创建于 {new Date(session.createdAt).toLocaleString()}
                  </p>
                </div>
                <button
                  type="button"
                  class="user-panel-delete"
                  disabled={pending}
                  onClick={() => void endSession(session)}
                >
                  结束会话
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {tab === "resources" && overview && (
        <section class="admin-section" aria-label="服务资源">
          <dl class="admin-resources">
            <div>
              <dt>服务内存</dt>
              <dd>
                {memory(overview.resources.browserMemoryBytes)} /{" "}
                {memory(overview.resources.browserMemoryLimitBytes)}
              </dd>
            </div>
            <div>
              <dt>整机内存</dt>
              <dd>
                {memory(overview.resources.memoryUsedBytes)} /{" "}
                {memory(overview.resources.memoryTotalBytes)}
              </dd>
            </div>
            <div>
              <dt>整机 CPU</dt>
              <dd>
                {overview.resources.cpuPercent == null
                  ? "—"
                  : `${overview.resources.cpuPercent.toFixed(1)}%`}{" "}
                · {overview.resources.cpuCount} 核
              </dd>
            </div>
            <div>
              <dt>运行中的浏览器</dt>
              <dd>{overview.runningProfiles}</dd>
            </div>
            <div>
              <dt>运行中的会话</dt>
              <dd>{overview.sessions.filter((session) => session.running).length}</dd>
            </div>
            <div>
              <dt>全部会话</dt>
              <dd>{overview.resources.clientsAllocated}</dd>
            </div>
            <div>
              <dt>在线设备</dt>
              <dd>{overview.resources.clientsOnline}</dd>
            </div>
          </dl>
          <p class="user-panel-muted">
            资源每 5 秒更新；新建和恢复会话仍受可用内存限制。离线页面 15
            分钟后回收，无会话使用的浏览器空闲 15 分钟后退出。
          </p>
        </section>
      )}
      {dialog}
    </Panel>
  );
}
