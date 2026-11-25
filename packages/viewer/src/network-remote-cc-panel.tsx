import { useEffect, useRef, useState } from "preact/hooks";
import { RemoteCcGuide } from "./remote-cc-guide";
import { useAsyncAction } from "./async-action";
import { useConfirm } from "./panel";
import { createSharedPoll, useSharedPoll } from "./polling";
import {
  remoteCcApi,
  type RemoteCcDeviceRequest,
  type RemoteCcLogin,
  type RemoteCcToken,
} from "./network-api";
import type { FrontendUser } from "./users";

const KIND_LABEL = { client: "电脑上的 remote-cc", host: "出口主机" } as const;
const LINK_PARAM = "remote-cc";

/**
 * Pending Claude Code sign-ins, polled once for the banner over the browser and the remote-cc tab
 * alike, while either is shown.
 */
export const remoteCcLogins = createSharedPoll(
  async () => (await remoteCcApi.logins()).logins,
  3000,
);

export const normalizeRemoteCcCode = (value: string) => value.trim().toUpperCase();

/**
 * The code of an approval link (/?remote-cc=CODE) and the same URL without it. The page drops the
 * parameter once it is read, so a reload or a later visit to the tab does not bring it back.
 */
export function takeRemoteCcLink(href: string): { code: string; url: string } | null {
  const url = new URL(href);
  if (!url.searchParams.has(LINK_PARAM)) return null;
  const code = normalizeRemoteCcCode(url.searchParams.get(LINK_PARAM) ?? "");
  url.searchParams.delete(LINK_PARAM);
  return { code, url: `${url.pathname}${url.search}${url.hash}` };
}

/** The product and platform part of a user agent; the rest is noise on an approval card. */
export function shortUserAgent(userAgent: string | null): string | null {
  const value = userAgent?.trim().replace(/\s+/g, " ");
  if (!value) return null;
  const close = value.indexOf(")");
  const head = close > 0 ? value.slice(0, close + 1) : value;
  return head.length > 60 ? `${head.slice(0, 59)}…` : head;
}

export function formatAge(since: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
}

/**
 * What 查看 does with a code. Each code is looked up at most once: the request on screen needs no
 * second lookup, and an approved or denied code is never looked up again.
 */
export function lookupAction(
  code: string,
  shown: string | null,
  decided: ReadonlySet<string>,
): "lookup" | "shown" | "decided" {
  if (decided.has(code)) return "decided";
  if (shown === code) return "shown";
  return "lookup";
}

export function RemoteCcPanel({
  open,
  user,
  initialCode,
  browserSessionId,
}: {
  open: boolean;
  user: FrontendUser;
  /** The browser session the panel is shown over, if any: sign-ins can open there. */
  browserSessionId?: string;
  /** A connection code from an approval link (?remote-cc=CODE); prefilled, never looked up. */
  initialCode?: string | null;
}) {
  const [tokens, setTokens] = useState<RemoteCcToken[]>([]);
  const polled = useSharedPoll(remoteCcLogins, open);
  const [code, setCode] = useState(() => normalizeRemoteCcCode(initialCode ?? ""));
  const [fromLink, setFromLink] = useState(() => Boolean(initialCode?.trim()));
  // The code as typed alongside the request it found, since the gateway may format it differently.
  const [shown, setShown] = useState<{ code: string; request: RemoteCcDeviceRequest } | null>(null);
  const request = shown?.request ?? null;
  const decided = useRef(new Set<string>());
  const cancelled = useRef(new Set<string>());
  const [now, setNow] = useState(Date.now);
  const { busy, error, notice, setError, setNotice, run } = useAsyncAction();
  const { confirm, dialog } = useConfirm();
  // A poll that started before a cancel must not bring the cancelled sign-in back.
  const logins = (polled.data ?? []).filter((login) => !cancelled.current.has(login.id));
  const tokenLoads = useRef(0);
  const loadTokens = async () => {
    const load = ++tokenLoads.current;
    const { tokens } = await remoteCcApi.tokens();
    if (load === tokenLoads.current) setTokens(tokens);
  };
  const reload = async () => {
    await Promise.all([loadTokens(), remoteCcLogins.refresh()]);
  };
  const lookup = (value: string) => {
    const wanted = normalizeRemoteCcCode(value);
    const action = lookupAction(wanted, shown?.code ?? null, decided.current);
    if (action === "shown") return;
    if (action === "decided") {
      setError(null);
      setNotice("这个连接码已经处理过。要再次连接，请在电脑上重新运行登录命令。");
      return;
    }
    void run(async () => {
      setShown(null);
      const found = (await remoteCcApi.device(wanted)).request;
      setNow(Date.now());
      setShown({ code: wanted, request: found });
      setFromLink(false);
    });
  };
  useEffect(() => {
    // The prop only seeds the field: the user compares it with their terminal and presses 查看.
    const prefill = normalizeRemoteCcCode(initialCode ?? "");
    if (!prefill) return;
    setCode(prefill);
    setFromLink(true);
  }, [initialCode]);
  // Pending sign-ins change as the browser opens them and the user clicks: remoteCcLogins polls
  // them while the tab is open. The tokens load each time it opens.
  useEffect(() => {
    if (!open) return;
    void run(loadTokens);
    return () => {
      tokenLoads.current++;
    };
  }, [open]);
  useEffect(() => {
    if (!open || !request) return;
    // Keeps the request's age current while the user decides.
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, [open, request]);
  const decide = (approve: boolean) =>
    run(async () => {
      if (!shown) return;
      const { request } = shown;
      await (approve ? remoteCcApi.approve(request.userCode) : remoteCcApi.deny(request.userCode));
      decided.current.add(shown.code);
      decided.current.add(normalizeRemoteCcCode(request.userCode));
      setNotice(
        approve
          ? `已批准「${request.name}」，回到它的终端即可继续。`
          : `已拒绝「${request.name}」。`,
      );
      setShown(null);
      setCode("");
      await reload();
    });
  const cancelLogin = (login: RemoteCcLogin) =>
    run(async () => {
      await remoteCcApi.cancelLogin(login.id);
      cancelled.current.add(login.id);
      setNotice(`已取消「${login.profileName ?? login.profileId}」的 Claude Code 登录。`);
      await reload();
    });
  const agent = request ? shortUserAgent(request.userAgent) : null;
  return (
    <div class="network-section" aria-busy={busy}>
      <p class="network-muted">
        remote-cc 在服务器上运行 Claude Code，命令和文件留在你的电脑上。用 <code>--rcb 配置</code>{" "}
        启动时，它使用这个浏览器配置的 Claude
        账号，全部网络流量经该配置的节点出去，和网页版同一个出口。第一次用，看下方「使用说明」。
      </p>
      {error && (
        <p class="network-message network-error" role="alert">
          {error}
        </p>
      )}
      {polled.error && polled.error !== error && (
        <p class="network-message network-error" role="alert">
          {polled.error}
        </p>
      )}
      {notice && (
        <p class="network-message" role="status">
          {notice}
        </p>
      )}
      <section class="network-card network-form" aria-labelledby="remote-cc-connect-title">
        <h3 id="remote-cc-connect-title">批准连接</h3>
        <p class="network-muted">
          在电脑上运行 <code>remote-cc rcb login {window.location.origin}</code>
          ，终端会显示一个连接码和链接。打开链接，或在这里输入连接码。
        </p>
        <form
          class="network-key-form"
          onSubmit={(event) => {
            event.preventDefault();
            lookup(code);
          }}
        >
          <label>
            连接码
            <input
              id="remote-cc-code"
              value={code}
              required
              maxLength={12}
              placeholder="ABCD-EFGH"
              autocomplete="off"
              disabled={busy}
              onInput={(event) => {
                setCode(event.currentTarget.value.toUpperCase());
                setFromLink(false);
              }}
            />
          </label>
          <button type="submit" disabled={busy || !code.trim()}>
            查看
          </button>
        </form>
        {fromLink && code && !request && (
          <p class="network-muted">
            连接码已从链接填入。先确认它与你终端里显示的连接码一致，再点「查看」。
          </p>
        )}
        {request && (
          <div class="network-issued-key" role="status">
            <p>
              <strong>{KIND_LABEL[request.kind]}</strong>「{request.name}」请求连接到你的账户。
            </p>
            <p class="network-message network-error">
              只有在你刚刚亲自运行了登录命令、并且终端里的连接码与 <code>{request.userCode}</code>{" "}
              完全一致时才批准。别人发来的链接或连接码，请拒绝。
            </p>
            <p class="network-muted">
              来源 IP：<code>{request.ip ?? "未知"}</code>
            </p>
            <p class="network-muted">
              客户端：
              <code title={request.userAgent ?? undefined}>{agent ?? "未知"}</code>
            </p>
            <p class="network-muted">
              发起时间：{formatAge(request.createdAt, now)}（
              {new Date(request.createdAt).toLocaleTimeString()}）
            </p>
            <p class="network-muted">
              {request.kind === "client"
                ? "批准后，这台电脑可以读取你的浏览器配置（Claude 邮箱、节点、出口），并以它们的身份启动 Claude Code。"
                : user.role === "admin"
                  ? "批准后，这台出口主机可以为会话取得节点配置，包括节点凭据。只批准你自己的服务器。"
                  : "出口主机只能由管理员批准。"}
            </p>
            <div class="network-actions">
              <button
                type="button"
                class="network-primary"
                disabled={busy || (request.kind === "host" && user.role !== "admin")}
                onClick={() => void decide(true)}
              >
                批准
              </button>
              <button
                type="button"
                class="network-danger"
                disabled={busy}
                onClick={() => void decide(false)}
              >
                拒绝
              </button>
            </div>
          </div>
        )}
      </section>
      {logins.length > 0 && (
        <section class="network-card" aria-labelledby="remote-cc-logins-title">
          <h3 id="remote-cc-logins-title">等待完成的 Claude Code 登录</h3>
          <ul class="network-list">
            {logins.map((login) => (
              <li key={login.id}>
                <div class="network-item-heading">
                  <strong>{login.profileName ?? login.profileId}</strong>
                </div>
                <p class="network-muted">发起的电脑：{login.tokenName ?? "未知"}</p>
                <p class="network-muted">
                  {login.status === "waiting"
                    ? "在这个配置的浏览器里点「打开授权页」，再在新标签页里点「授权」。"
                    : "授权页已打开，在那个标签页里点「授权」即可，授权码会自动回到终端。"}
                </p>
                <div class="network-actions">
                  {browserSessionId && (
                    <button
                      type="button"
                      class="network-primary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await remoteCcApi.openLogin(browserSessionId, login.id);
                          setNotice(
                            "授权页已在当前浏览器的新标签页打开，关闭这个面板后点「授权」。",
                          );
                        })
                      }
                    >
                      {login.status === "waiting" ? "在当前浏览器打开授权页" : "重新打开授权页"}
                    </button>
                  )}
                  <button
                    type="button"
                    class="network-danger"
                    disabled={busy}
                    aria-label={`取消「${login.profileName ?? login.profileId}」的登录`}
                    onClick={() => void cancelLogin(login)}
                  >
                    取消
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(["client", "host"] as const).map((kind) => {
        const own = tokens.filter((token) => token.kind === kind);
        if (own.length === 0) return null;
        return (
          <section class="network-card" aria-labelledby={`remote-cc-${kind}-title`} key={kind}>
            <h3 id={`remote-cc-${kind}-title`}>
              {kind === "client" ? "已连接的电脑" : "出口主机"}
            </h3>
            <ul class="network-list">
              {own.map((token) => (
                <li key={token.id}>
                  <div class="network-item-heading">
                    <strong>{token.name}</strong>
                    <code>{token.prefix}…</code>
                  </div>
                  <p class="network-muted">
                    {token.lastUsedAt
                      ? `最近使用：${new Date(token.lastUsedAt).toLocaleString()}`
                      : "尚未使用"}
                  </p>
                  <div class="network-actions">
                    <button
                      type="button"
                      class="network-danger"
                      disabled={busy}
                      aria-label={`断开「${token.name}」`}
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `断开「${token.name}」？`,
                            message: "它将立即失去访问。",
                            confirmLabel: "断开",
                            danger: true,
                          })
                        )
                          void run(async () => {
                            await remoteCcApi.removeToken(token.id);
                            await reload();
                          });
                      }}
                    >
                      断开
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <RemoteCcGuide origin={window.location.origin} />
      {dialog}
    </div>
  );
}

/**
 * A banner over the remote browser while one of its profile's Claude Code sign-ins waits:
 * the user opens the sign-in page in the browser they are looking at.
 */
export function RemoteCcLoginBanner({ sid, profileId }: { sid: string; profileId: string }) {
  // The same poll as the remote-cc tab; a failed poll keeps the last answer.
  const { data: logins = [] } = useSharedPoll(remoteCcLogins);
  const [opened, setOpened] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const login = logins.find((item) => item.profileId === profileId && item.status !== "done");
  if (!login) return null;
  return (
    <div class="shell-banner remote-cc-login-banner" role="status">
      <span>
        {error ??
          (opened === login.id
            ? "授权页已在新标签页打开：在那里点「授权」，授权码会自动回到终端。"
            : `remote-cc（${login.tokenName ?? "你的电脑"}）请求以这个配置登录 Claude Code。`)}
      </span>
      <button
        type="button"
        onClick={() => {
          setError(null);
          void remoteCcApi.openLogin(sid, login.id).then(
            () => {
              if (mounted.current) setOpened(login.id);
            },
            (failure: Error) => {
              if (mounted.current) setError(failure.message);
            },
          );
        }}
      >
        {opened === login.id ? "重新打开授权页" : "打开授权页"}
      </button>
    </div>
  );
}
