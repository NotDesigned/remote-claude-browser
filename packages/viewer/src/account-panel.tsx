import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  changeMyPassword,
  endMyBrowserSession,
  myBrowserSessions,
  type FrontendUser,
  type MyBrowserSession,
} from "./users";
import "./user-panel.css";
import "./account-panel.css";

export function AccountPanel({
  user,
  currentSid,
  onClose,
  onSessionEnded,
}: {
  user: FrontendUser;
  currentSid?: string;
  onClose(): void;
  onSessionEnded(sid: string): void;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [sessions, setSessions] = useState<MyBrowserSession[] | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    close.current!.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
      if (event.key !== "Tab") return;
      const controls = [
        ...panel.current!.querySelectorAll<HTMLElement>(
          "button:not([disabled]),input:not([disabled])",
        ),
      ];
      const first = controls[0]!,
        last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
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
    void myBrowserSessions()
      .then((result) => {
        if (active) setSessions(result);
      })
      .catch((failure) => {
        if (active) setError((failure as Error).message);
      });
    return () => {
      active = false;
    };
  }, []);
  const endSession = async (session: MyBrowserSession) => {
    if (
      !window.confirm(
        `结束「${session.label}」？此会话中的网页会关闭，浏览器配置的网站登录和数据会保留。`,
      )
    )
      return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await endMyBrowserSession(session.sid);
      setSessions((items) => items!.filter((item) => item.sid !== session.sid));
      setNotice("会话已结束，浏览器配置已保留。");
      onSessionEnded(session.sid);
    } catch (failure) {
      setError((failure as Error).message);
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
        class="user-panel account-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-panel-title"
        ref={panel}
      >
        <header class="user-panel-heading">
          <div>
            <h2 id="account-panel-title">我的账号</h2>
            <p>
              {user.username} · {user.role === "admin" ? "管理员" : "普通用户"}
            </p>
          </div>
          <button
            type="button"
            class="user-panel-close"
            aria-label="关闭我的账号"
            ref={close}
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
        <section class="account-sessions" aria-labelledby="account-sessions-title">
          <div class="account-section-heading">
            <h3 id="account-sessions-title">我的浏览器会话</h3>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setError(null);
                void myBrowserSessions()
                  .then(setSessions)
                  .catch((failure) => setError((failure as Error).message));
              }}
            >
              刷新
            </button>
          </div>
          <p class="user-panel-muted">
            包括你在其他设备打开的会话。同一配置共享网站登录；结束会话不会退出网站账号。
          </p>
          {sessions === null ? (
            <p class="user-panel-muted">正在加载会话…</p>
          ) : sessions.length === 0 ? (
            <p class="user-panel-muted">暂无浏览器会话。</p>
          ) : (
            <ul class="account-session-list">
              {sessions.map((session) => (
                <li key={session.sid}>
                  <div>
                    <strong>{session.label}</strong>
                    <p class="user-panel-muted">
                      {session.profileName} ·{" "}
                      {session.sid === currentSid
                        ? "当前页面"
                        : session.currentDevice
                          ? "本设备"
                          : "其他设备"}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={pending}
                    aria-label={`结束会话「${session.label}」`}
                    onClick={() => void endSession(session)}
                  >
                    结束
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <form
          class="user-panel-form account-password"
          onSubmit={async (event) => {
            event.preventDefault();
            setPending(true);
            setError(null);
            setNotice(null);
            try {
              await changeMyPassword(currentPassword, password);
              window.location.assign("/gate");
            } catch (failure) {
              setError((failure as Error).message);
            } finally {
              setPending(false);
            }
          }}
        >
          <h3>修改密码</h3>
          <p class="user-panel-muted">修改后所有设备需要重新登录工作台，浏览器内的网站登录不变。</p>
          <label>
            当前密码
            <input
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              disabled={pending}
              onInput={(event) => setCurrentPassword(event.currentTarget.value)}
            />
          </label>
          <label>
            新密码
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              value={password}
              disabled={pending}
              onInput={(event) => setPassword(event.currentTarget.value)}
            />
          </label>
          <div class="user-panel-actions">
            <button type="submit" class="user-panel-save" disabled={pending}>
              修改密码并重新登录
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
