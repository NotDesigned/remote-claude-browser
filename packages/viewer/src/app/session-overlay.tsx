/** The card over the page while there is no running session: starting, ending, ended, failed. */
import { clientReturnUrl } from "../client-session";
import type { SessionState } from "./session-state";

export interface ClientSessionOverlayProps {
  session: SessionState;
  /** Retry what failed: starting the session, or ending it. */
  onRetry(): void;
}

function title({ phase, endFailure }: SessionState): string {
  if (phase === "replaced") return "此会话已在另一页面打开";
  if (phase === "closed") return "当前会话已结束";
  if (phase === "ending") return "正在结束会话…";
  if (phase === "error") return endFailure ? "未能结束会话" : "暂时无法打开会话";
  return "正在打开独立会话…";
}

function detail({ phase, error }: SessionState): string | undefined {
  if (phase === "replaced") return "当前页面已停止连接和输入，可在另一页面继续，或另开独立会话。";
  if (phase === "closed") return "当前页面已停止连接。点击重新开启后，才会再次申请会话。";
  if (phase === "ending") return "已停止本页面的输入和连接，正在释放会话资源。";
  if (phase === "error") return error?.message;
  return "正在连接当前用户的独立浏览器。首次打开可能需要一些时间。";
}

export function ClientSessionOverlay({ session: state, onRetry }: ClientSessionOverlayProps) {
  const { phase, error, endFailure, picked, session } = state;
  return (
    <section
      id="client-session-overlay"
      class="client-session-overlay"
      data-phase={phase}
      role={phase === "error" || phase === "replaced" ? "alert" : "status"}
    >
      <div class="client-session-card">
        <span class="session-eyebrow">独立浏览器</span>
        <h1>{title(state)}</h1>
        <p>{detail(state)}</p>
        <p class="session-policy">
          不同用户的浏览器数据互相隔离。同一浏览器配置下的会话共享网站登录。离线约 60
          秒后释放远程窗口；返回时重新打开启动页，未发送草稿不保留。正在生成时暂缓释放。
        </p>
        {phase === "error" && error !== null && error.ownedSessions.length > 0 && (
          <div class="owned-client-sessions">
            <p>返回本设备已有的会话：</p>
            {error.ownedSessions.map((owned) => (
              <a key={owned.sid} href={clientReturnUrl(owned.sid)}>
                {owned.label}
              </a>
            ))}
          </div>
        )}
        <div class="client-session-actions">
          {phase === "replaced" && (
            <a class="session-primary-action" href="/?new=1" target="_blank" rel="noopener">
              另开独立会话
            </a>
          )}
          {phase === "closed" && (
            <button
              id="client-session-reopen"
              type="button"
              class="session-primary-action"
              onClick={() => window.location.assign("/?new=1")}
            >
              重新开启会话
            </button>
          )}
          {phase === "error" && (
            <button
              id="client-session-retry"
              type="button"
              class="session-primary-action"
              onClick={onRetry}
            >
              {endFailure ? "重试结束" : "重试"}
            </button>
          )}
          {phase === "error" && error?.status === 401 && <a href="/gate">重新登录</a>}
          {phase === "error" &&
            !endFailure &&
            (picked !== null || error?.code === "EXIT_REQUIRED") && (
              <a href="/?new=1">重新选择配置并设置出口</a>
            )}
          {phase === "error" && endFailure && session !== null && (
            <a href={clientReturnUrl(session.sid)}>返回当前会话</a>
          )}
        </div>
      </div>
    </section>
  );
}
