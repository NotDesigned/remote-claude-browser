import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  createUser,
  deleteUser,
  listUsers,
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
}

const emptyUser = (): UserFields => ({
  id: null,
  username: "",
  password: "",
  role: "user",
  enabled: true,
});

export function UserPanel({
  current,
  onClose,
  onChanged,
}: {
  current: FrontendUser;
  onClose(): void;
  onChanged(): void;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const baseline = useRef<ManagedUser | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [fields, setFields] = useState<UserFields>(emptyUser);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const previous = document.activeElement;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...(panel.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]',
        ) ?? []),
      ].filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (
        event.shiftKey &&
        (document.activeElement === first || !panel.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !panel.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void listUsers()
      .then((loaded) => {
        if (active) setUsers(loaded);
      })
      .catch((failure) => {
        if (active) setError(String(failure instanceof Error ? failure.message : failure));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const choose = (user?: ManagedUser) => {
    baseline.current = user ?? null;
    setFields(user ? { ...user, password: "" } : emptyUser());
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
  };
  const hasChanges = fields.id === null || Object.keys(changes).length > 0;
  const reload = async () => setUsers(await listUsers());
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
            })
          : await updateUser(fields.id, changes);
      baseline.current = saved;
      setFields({ ...saved, password: "" });
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
      !window.confirm(`删除用户「${fields.username}」？该用户将无法再登录。`)
    )
      return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await deleteUser(fields.id);
      baseline.current = null;
      setFields(emptyUser());
      setNotice("用户已删除。");
      onChanged();
      await reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "删除失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      class="user-panel-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        class="user-panel"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-panel-title"
        aria-describedby="user-panel-description"
      >
        <header class="user-panel-heading">
          <div>
            <h2 id="user-panel-title">用户管理</h2>
            <p id="user-panel-description">每个用户的浏览器数据独立，可自行登录其中的网站。</p>
          </div>
          <button
            class="user-panel-close"
            type="button"
            ref={close}
            aria-label="关闭用户管理"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        {error && (
          <p class="user-panel-message user-panel-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p class="user-panel-message" role="status">
            {notice}
          </p>
        )}
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
                  {!user.enabled && " · 已停用"}
                </span>
              </button>
            ))}
          </nav>
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
                允许登录
              </label>
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
                  删除用户
                </button>
              )}
            </footer>
          </form>
        </div>
      </section>
    </div>
  );
}
