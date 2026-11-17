import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ExitHealthDetails } from "./exit-health";
import type { FrontendUser } from "./users";
import {
  cpaApi,
  proxyApi,
  type CpaCredential,
  type CpaInstance,
  type CpaKey,
  type CpaPendingOAuth,
  type CpaBrowserAuthorization,
  type ProxyInfo,
} from "./network-api";

function ProxySelect({
  proxies,
  value,
  disabled,
  label,
  placeholder,
  onChange,
}: {
  proxies: ProxyInfo[];
  value: string;
  disabled: boolean;
  label: string;
  placeholder: string;
  onChange(value: string): void;
}) {
  return (
    <label>
      {label}
      <select
        value={proxies.some((proxy) => proxy.id === value) ? value : ""}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {proxies.map((proxy) => (
          <option key={proxy.id} value={proxy.id}>
            {proxy.name} · {proxy.visibility === "shared" ? "共享" : "私有"}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CpaPanel({
  user,
  browserProxyId,
  open,
  browserSessionId,
  onOpenBrowser,
  onChooseBrowser,
}: {
  user: FrontendUser;
  browserProxyId?: string | null;
  open: boolean;
  browserSessionId?: string;
  onOpenBrowser(): void;
  onChooseBrowser(authorization: CpaBrowserAuthorization): void;
}) {
  const [instances, setInstances] = useState<CpaInstance[]>([]);
  const [selected, setSelected] = useState("");
  const [proxies, setProxies] = useState<ProxyInfo[]>([]);
  const [credentials, setCredentials] = useState<CpaCredential[]>([]);
  const [keys, setKeys] = useState<CpaKey[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [oauth, setOAuth] = useState<CpaPendingOAuth | null>(null);
  const oauthRef = useRef(oauth);
  oauthRef.current = oauth;
  const [oauthProxy, setOAuthProxy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [keyName, setKeyName] = useState("");
  const [issuedKey, setIssuedKey] = useState<(CpaKey & { token: string }) | null>(null);
  useLayoutEffect(() => {
    if (!open) setIssuedKey(null);
  }, [open, issuedKey]);
  const instance = instances.find((item) => item.id === selected);
  const draftKey = `mirror-cpa-callback:${user.id}:${selected}:${oauth?.state ?? ""}`;
  const callback = drafts[draftKey] ?? sessionStorage.getItem(draftKey) ?? "";
  const setCallback = (value: string) => {
    setDrafts((previous) => ({ ...previous, [draftKey]: value }));
    if (value) sessionStorage.setItem(draftKey, value);
    else sessionStorage.removeItem(draftKey);
  };
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const detailRequest = useRef(0);
  const preferredOAuthProxy = oauthProxy ?? browserProxyId ?? "";
  const selectedOAuthProxy = proxies.some((proxy) => proxy.id === preferredOAuthProxy)
    ? preferredOAuthProxy
    : "";
  const reloadInstances = async () => {
    const result = await cpaApi.instances();
    setInstances(result.instances);
    setSelected(
      (previous) =>
        previous ||
        result.instances.find((item) => item.ownerId === user.id && item.scope === "user")?.id ||
        result.instances[0]?.id ||
        "",
    );
    return result.instances;
  };
  const reloadDetails = async (item: CpaInstance) => {
    const request = ++detailRequest.current;
    const [savedKeys, savedCredentials, pending] = await Promise.all([
      cpaApi.keys(item.id),
      item.canManage && item.status === "running"
        ? cpaApi.credentials(item.id)
        : Promise.resolve({ credentials: [] }),
      item.canManage ? cpaApi.pendingOAuth(item.id) : Promise.resolve({ sessions: [] }),
    ]);
    if (selectedRef.current === item.id && detailRequest.current === request) {
      setKeys(savedKeys.keys);
      setCredentials(savedCredentials.credentials);
      const saved = pending.sessions.at(-1) ?? null;
      if (!saved && oauthRef.current) setCallback("");
      setOAuth(saved);
      if (saved) setOAuthProxy(saved.proxyId);
    }
  };
  useEffect(() => {
    if (!open) return;
    void Promise.all([
      reloadInstances(),
      proxyApi.proxies().then((result) => setProxies(result.proxies)),
    ])
      .then(([items]) => {
        const current = items.find((item) => item.id === selectedRef.current);
        if (current) return reloadDetails(current);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [open]);
  useLayoutEffect(() => {
    setCredentials([]);
    setKeys([]);
    setOAuth(null);
    setIssuedKey(null);
    setError(null);
    setNotice(null);
    if (instance)
      void reloadDetails(instance).catch((reason: Error) => {
        if (selectedRef.current === instance.id) setError(reason.message);
      });
    return () => {
      detailRequest.current++;
    };
  }, [selected, instance?.status]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const create = (scope: CpaInstance["scope"]) =>
    void run(async () => {
      const result = await cpaApi.create(scope);
      await reloadInstances();
      setSelected(result.instance.id);
      setNotice("实例已创建，启动后可添加授权。");
    });
  const startStop = () =>
    void run(async () => {
      if (instance!.status === "running") await cpaApi.stop(instance!.id);
      else await cpaApi.start(instance!.id);
      await reloadInstances();
    });
  const credentialsChanged = async () => {
    await reloadInstances();
    await reloadDetails(instance!);
  };

  return (
    <div class="network-section" aria-busy={busy || loading}>
      <p class="network-muted">
        CPA 授权独立于浏览器网站登录。每个专用实例保存自己的凭据和 API Key。
      </p>
      {error && (
        <p class="network-message network-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p class="network-message" role="status">
          {notice}
        </p>
      )}
      <div class="network-cpa-toolbar">
        <nav class="network-instances" aria-label="CPA 实例">
          {instances.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-pressed={selected === item.id}
              disabled={busy}
              onClick={() => setSelected(item.id)}
            >
              <strong>
                {item.scope === "shared"
                  ? "共享实例"
                  : item.ownerId === user.id
                    ? "我的实例"
                    : "专用实例"}
              </strong>
              <span>
                {item.status === "running"
                  ? "运行中"
                  : item.status === "missing"
                    ? "未就绪"
                    : "已停止"}
              </span>
            </button>
          ))}
        </nav>
        <div class="network-actions">
          {!instances.some((item) => item.scope === "user" && item.ownerId === user.id) && (
            <button type="button" disabled={busy || loading} onClick={() => create("user")}>
              创建我的 CPA 实例
            </button>
          )}
          {user.role === "admin" && !instances.some((item) => item.scope === "shared") && (
            <button type="button" disabled={busy || loading} onClick={() => create("shared")}>
              创建共享 CPA 实例
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const items = await reloadInstances();
                const item = items.find((entry) => entry.id === selected);
                if (item) await reloadDetails(item);
              })
            }
          >
            刷新实例
          </button>
        </div>
      </div>
      {!loading && instances.length === 0 && (
        <p class="network-muted">还没有 CPA 实例，可以先创建自己的实例。</p>
      )}
      {instance && (
        <div class="network-cpa-grid">
          <section class="network-card network-card-wide">
            <div class="network-card-heading">
              <h3>{instance.scope === "shared" ? "共享 CPA" : "专用 CPA"}</h3>
              {instance.canManage && (
                <button type="button" disabled={busy} onClick={startStop}>
                  {instance.status === "running" ? "停止实例" : "启动实例"}
                </button>
              )}
            </div>
            <p class="network-muted">
              进程：{instance.status === "running" ? "运行中" : "未运行"} · 授权：
              {
                {
                  ready: "已就绪",
                  empty: "尚未添加",
                  "needs-binding": "需要绑定出口",
                  unavailable: "不可用或已停用",
                  unknown: "未检查",
                }[instance.authorization ?? "unknown"]
              }
              {" · 出口："}
              {
                { healthy: "可用", error: "检查失败", checking: "检查中", unchecked: "未检查" }[
                  instance.egress ?? "unchecked"
                ]
              }
            </p>
            {instance.authorizing && (
              <p class="network-muted">正在添加授权，已有授权可继续调用。</p>
            )}
            {instance.canManage && instance.status === "running" && (
              <div class="network-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await cpaApi.check(instance.id);
                      await credentialsChanged();
                      setNotice(
                        "出口检查已完成，不会发起模型生成。授权额度与上游账号状态仍以实际调用为准。",
                      );
                    })
                  }
                >
                  检查出口
                </button>
                {instance.authorizing && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await cpaApi.cancelOAuth(instance.id);
                        setOAuth(null);
                        setCallback("");
                        await credentialsChanged();
                        setNotice("待完成授权已取消。");
                      })
                    }
                  >
                    取消待完成授权
                  </button>
                )}
              </div>
            )}
            <p class="network-muted">
              {instance.scope === "shared"
                ? "共享账号池由管理员维护。每个用户管理自己的调用 Key；管理员可查看归属并撤销。"
                : "此实例属于你，授权凭据仅由你管理。浏览器网页登录与 CPA 授权互相独立。"}
            </p>
          </section>
          {instance.canManage && (
            <>
              <section
                class="network-card network-card-wide"
                aria-labelledby="cpa-credentials-title"
              >
                <h3 id="cpa-credentials-title">授权凭据 · {credentials.length}</h3>
                {credentials.length === 0 && (
                  <p class="network-empty">
                    尚未添加授权。完成 Claude 授权后，账号和出口会显示在这里。
                  </p>
                )}
                <ul class="network-list">
                  {credentials.map((credential) => (
                    <li key={credential.name}>
                      <div class="network-item-heading">
                        <strong>{credential.email || credential.label || credential.name}</strong>
                        <span class="network-badge">{credential.provider}</span>
                      </div>
                      <p class="network-muted">
                        {credential.needsBinding
                          ? "需要绑定出口，暂不可调用"
                          : credential.disabled
                            ? "已停用"
                            : credential.unavailable
                              ? "凭据不可用"
                              : credential.status || "已启用"}
                      </p>
                      <ExitHealthDetails health={credential.exitHealth} />
                      {credential.timeZone && (
                        <p class="network-muted">
                          授权时区：{credential.timeZone} · 当地时间：
                          {new Date().toLocaleString("zh-CN", { timeZone: credential.timeZone })}
                        </p>
                      )}
                      <div class="network-form">
                        <ProxySelect
                          proxies={proxies}
                          value={credential.proxyId ?? ""}
                          disabled={busy || instance.status !== "running"}
                          label={`凭据「${credential.name}」的代理`}
                          placeholder={
                            credential.proxyId ? "当前节点不可用，请重新选择" : "请选择出口节点"
                          }
                          onChange={(proxyId) => {
                            if (
                              credential.proxyId &&
                              credential.proxyId !== proxyId &&
                              !window.confirm(
                                "频繁更换账号出口可能触发平台风控。确认理解影响并切换？",
                              )
                            )
                              return;
                            void run(async () => {
                              await cpaApi.credentialProxy(instance.id, credential.name, proxyId);
                              await credentialsChanged();
                              setNotice("凭据出口和时区已更新。");
                            });
                          }}
                        />
                        {!credential.proxyId && (
                          <p class="network-muted">
                            此凭据不会使用部署默认出口。选择节点后，再启用凭据。
                          </p>
                        )}
                      </div>
                      <div class="network-actions">
                        <button
                          type="button"
                          disabled={
                            busy ||
                            instance.status !== "running" ||
                            (credential.disabled && credential.needsBinding)
                          }
                          onClick={() =>
                            void run(async () => {
                              await cpaApi.credentialStatus(
                                instance.id,
                                credential.name,
                                !credential.disabled,
                              );
                              await credentialsChanged();
                            })
                          }
                        >
                          {credential.disabled ? "启用凭据" : "停用凭据"}
                        </button>
                        <button
                          type="button"
                          class="network-danger"
                          disabled={busy || instance.status !== "running"}
                          onClick={() => {
                            if (
                              window.confirm(`删除凭据「${credential.email || credential.name}」？`)
                            )
                              void run(async () => {
                                await cpaApi.removeCredential(instance.id, credential.name);
                                await credentialsChanged();
                              });
                          }}
                        >
                          删除凭据
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
              <section class="network-card network-form" aria-labelledby="cpa-oauth-title">
                <h3 id="cpa-oauth-title">添加 Claude 授权</h3>
                <ProxySelect
                  proxies={proxies}
                  value={selectedOAuthProxy}
                  disabled={busy || instance.status !== "running"}
                  label="授权使用的代理"
                  placeholder="请选择代理节点"
                  onChange={(proxyId) => {
                    setOAuthProxy(proxyId);
                    setOAuth(null);
                  }}
                />
                <p class="network-muted">
                  {proxies.some((proxy) => proxy.id === browserProxyId)
                    ? "默认使用当前浏览器配置的出口，可单独更改。"
                    : "请先选择授权使用的代理节点。"}
                </p>
                <div class="network-actions">
                  <button
                    type="button"
                    class="network-primary"
                    disabled={
                      busy || instance.status !== "running" || !selectedOAuthProxy || !!oauth
                    }
                    onClick={() =>
                      void run(async () => {
                        setOAuth({
                          ...(await cpaApi.oauth(instance.id, selectedOAuthProxy)),
                          proxyId: selectedOAuthProxy,
                        });
                        setCallback("");
                        await reloadInstances();
                      })
                    }
                  >
                    生成 Claude 授权链接
                  </button>
                </div>
                {oauth && oauth.proxyId === selectedOAuthProxy && (
                  <>
                    <button
                      type="button"
                      class="network-primary"
                      disabled={busy || !browserSessionId || browserProxyId !== oauth.proxyId}
                      onClick={() =>
                        void run(async () => {
                          await cpaApi.openOAuth(browserSessionId!, instance.id, oauth.state);
                          onOpenBrowser();
                        })
                      }
                    >
                      在远程浏览器中打开授权页
                    </button>
                    {(!browserSessionId || browserProxyId !== oauth.proxyId) && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          onChooseBrowser({
                            userId: user.id,
                            instanceId: instance.id,
                            state: oauth.state,
                            proxyId: oauth.proxyId,
                          })
                        }
                      >
                        选择同出口浏览器
                      </button>
                    )}
                    <p class="network-muted">
                      远程浏览器会自动提交匹配的授权回调。也可在这里粘贴完整回调 URL 或授权码。
                    </p>
                    <label>
                      授权回调 URL 或授权码
                      <textarea
                        rows={3}
                        value={callback}
                        spellcheck={false}
                        onInput={(event) => setCallback(event.currentTarget.value)}
                        disabled={busy}
                      />
                    </label>
                    <div class="network-actions">
                      <button
                        type="button"
                        disabled={busy || !callback.trim()}
                        onClick={() =>
                          void run(async () => {
                            const value = callback.trim();
                            await cpaApi.oauthCallback(instance.id, {
                              state: oauth.state,
                              ...(/^https?:\/\//i.test(value)
                                ? { redirectUrl: value }
                                : { code: value }),
                            });
                            setCallback("");
                            setNotice("回调已提交，可检查授权状态。");
                          })
                        }
                      >
                        提交授权回调
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const status = await cpaApi.oauthStatus(instance.id, oauth.state);
                            if (status.status === "error")
                              throw new Error(status.error || "授权未完成。");
                            if (status.status === "ok") {
                              setCallback("");
                              await credentialsChanged();
                              setOAuth(null);
                              setNotice("Claude 授权已完成。");
                            } else setNotice("等待完成授权。");
                          })
                        }
                      >
                        检查授权状态
                      </button>
                    </div>
                  </>
                )}
              </section>
            </>
          )}
          <section class="network-card network-form" aria-labelledby="cpa-keys-title">
            <h3 id="cpa-keys-title">
              {instance.scope === "shared" && instance.canManage ? "共享调用 Key" : "我的 API Key"}
            </h3>
            <p class="network-muted">
              新 Key 归当前用户所有。停用或删除该用户后，其 Key 无法继续调用。
            </p>
            <label>
              API Base URL
              <input readOnly value={`${window.location.origin}/v1`} />
            </label>
            <form
              class="network-key-form"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const result = await cpaApi.createKey(instance.id, keyName.trim());
                  setIssuedKey(result.key);
                  setKeyName("");
                  await credentialsChanged();
                });
              }}
            >
              <label>
                新 Key 名称
                <input
                  value={keyName}
                  required
                  maxLength={80}
                  disabled={busy}
                  onInput={(event) => setKeyName(event.currentTarget.value)}
                />
              </label>
              <button class="network-primary" type="submit" disabled={busy || !keyName.trim()}>
                生成 API Key
              </button>
            </form>
            {issuedKey && (
              <div class="network-issued-key" role="status">
                <label>
                  新 API Key（仅此一次）
                  <textarea readOnly rows={3} value={issuedKey.token} />
                </label>
                <div class="network-actions">
                  <button
                    type="button"
                    onClick={() =>
                      void run(async () => {
                        await navigator.clipboard.writeText(issuedKey.token);
                        setNotice("API Key 已复制。");
                      })
                    }
                  >
                    复制 Key
                  </button>
                  <button type="button" onClick={() => setIssuedKey(null)}>
                    已保存，隐藏
                  </button>
                </div>
                <p class="network-muted">关闭面板后不再显示完整 Key，请先保存。</p>
              </div>
            )}
            <ul class="network-list">
              {keys.map((key) => (
                <li key={key.id}>
                  <div class="network-item-heading">
                    <strong>{key.name}</strong>
                    <code>{key.prefix}…</code>
                  </div>
                  <p class="network-muted">
                    所有者：{key.userId === user.id ? "我" : (key.username ?? "已删除用户")}
                    {key.userId !== user.id && !key.username && `（${key.userId}）`}
                  </p>
                  <div class="network-actions">
                    <button
                      type="button"
                      class="network-danger"
                      disabled={busy}
                      aria-label={`撤销 API Key「${key.name}」`}
                      onClick={() => {
                        if (
                          window.confirm(
                            `撤销 API Key「${key.name}」？使用它的客户端将无法继续调用。`,
                          )
                        )
                          void run(async () => {
                            await cpaApi.removeKey(instance.id, key.id);
                            if (issuedKey?.id === key.id) setIssuedKey(null);
                            await credentialsChanged();
                          });
                      }}
                    >
                      撤销 Key
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
