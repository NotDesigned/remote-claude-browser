import { useDialog } from "./dialog";
import { useEffect, useState } from "preact/hooks";
import {
  changeMyPassword,
  endMyBrowserSession,
  myBrowserSessions,
  type FrontendUser,
  type MyBrowserSession,
  myAccount,
  type MyAccount,
} from "./users";
import "./user-panel.css";
import "./account-panel.css";

export function AccountPanel({
  user,
  currentSid,
  onClose,
  onSessionEnded,
  initialNotice,
}: {
  user: FrontendUser;
  currentSid?: string;
  onClose(): void;
  onSessionEnded(sid: string): void;
  /** Shown when the panel opens, e.g. after linking single sign-on. */
  initialNotice?: string;
}) {
  const panel = useDialog(true, onClose);
  const [sessions, setSessions] = useState<MyBrowserSession[] | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice ?? null);
  const [account, setAccount] = useState<MyAccount | null>(null);
  useEffect(() => {
    let active = true;
    void myAccount().then(
      (result) => {
        if (active) setAccount(result);
      },
      () => {},
    );
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
                      {session.profileName} · {session.online ? "在线" : "休眠"} ·{" "}
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
        {account?.sso && (
          <section class="account-sso" aria-labelledby="account-sso-title">
            <h3 id="account-sso-title">单点登录</h3>
            {account.sso.linked.length > 0 ? (
              <p class="user-panel-muted">
                已绑定{account.sso.linked[0]!.email ? `：${account.sso.linked[0]!.email}` : ""}
                。可以在登录页点「
                {account.sso.label}」登录。
              </p>
            ) : (
              <>
                <p class="user-panel-muted">
                  绑定后可以在登录页点「{account.sso.label}」登录，原来的用户名和密码继续可用。
                </p>
                <div class="user-panel-actions">
                  <a class="user-panel-save" href="/gate/oidc/link">
                    绑定单点登录账号
                  </a>
                </div>
              </>
            )}
          </section>
        )}
        {account && !account.hasPassword ? (
          <section class="account-no-password" aria-labelledby="account-password-title">
            <h3 id="account-password-title">密码</h3>
            <p class="user-panel-muted">
              这个账户通过单点登录创建，没有本地密码。需要用户名和密码登录时，请管理员为你设置密码。
            </p>
          </section>
        ) : (
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
            <p class="user-panel-muted">
              修改后所有设备需要重新登录工作台，浏览器内的网站登录不变。
            </p>
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
        )}
      </section>
    </div>
  );
}
