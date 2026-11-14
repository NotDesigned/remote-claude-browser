import { useEffect, useState } from "preact/hooks";
import type { FrontendUser } from "./users";
import {
  cpaApi,
  proxyApi,
  type CpaCredential,
  type CpaInstance,
  type CpaKey,
  type CpaOAuth,
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
}: {
  user: FrontendUser;
  browserProxyId?: string | null;
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
  const [oauth, setOAuth] = useState<CpaOAuth | null>(null);
  const [oauthProxy, setOAuthProxy] = useState<string | null>(null);
  const [callback, setCallback] = useState("");
  const [keyName, setKeyName] = useState("");
  const [issuedKey, setIssuedKey] = useState<(CpaKey & { token: string }) | null>(null);
  const instance = instances.find((item) => item.id === selected);
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
    const [savedKeys, savedCredentials] = await Promise.all([
      cpaApi.keys(item.id),
      item.status === "running"
        ? cpaApi.credentials(item.id)
        : Promise.resolve({ credentials: [] }),
    ]);
    setKeys(savedKeys.keys);
    setCredentials(savedCredentials.credentials);
  };
  useEffect(() => {
    void Promise.all([
      reloadInstances(),
      proxyApi.proxies().then((result) => setProxies(result.proxies)),
    ])
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    setCredentials([]);
    setKeys([]);
    setOAuth(null);
    setCallback("");
    setIssuedKey(null);
    setError(null);
    setNotice(null);
    if (instance?.canManage)
      void reloadDetails(instance).catch((reason: Error) => setError(reason.message));
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
  const credentialsChanged = async () => reloadDetails(instance!);

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
              if (item?.canManage) await reloadDetails(item);
            })
          }
        >
          刷新实例
        </button>
      </div>
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
      {!loading && instances.length === 0 && (
        <p class="network-muted">还没有 CPA 实例，可以先创建自己的实例。</p>
      )}
      {instance && (
        <>
          <section class="network-card">
            <div class="network-card-heading">
              <h3>{instance.scope === "shared" ? "共享 CPA" : "专用 CPA"}</h3>
              {instance.canManage && (
                <button type="button" disabled={busy} onClick={startStop}>
                  {instance.status === "running" ? "停止实例" : "启动实例"}
                </button>
              )}
            </div>
            <p class="network-muted">
              {instance.status === "running"
                ? "实例正在运行，可管理授权凭据。"
                : "实例未运行；启动后可授权账号或更新凭据。"}
            </p>
            {!instance.canManage && <p class="network-muted">此实例由管理员管理。</p>}
          </section>
          {instance.canManage && (
            <>
              <section class="network-card" aria-labelledby="cpa-credentials-title">
                <h3 id="cpa-credentials-title">授权凭据 · {credentials.length}</h3>
                <ul class="network-list">
                  {credentials.map((credential) => (
                    <li key={credential.name}>
                      <div class="network-item-heading">
                        <strong>{credential.email || credential.label || credential.name}</strong>
                        <span class="network-badge">{credential.provider}</span>
                      </div>
                      <p class="network-muted">
                        {credential.disabled
                          ? "已停用"
                          : credential.unavailable
                            ? "凭据不可用"
                            : credential.status || "已启用"}
                      </p>
                      <div class="network-form">
                        <ProxySelect
                          proxies={proxies}
                          value={credential.proxyId ?? ""}
                          disabled={busy || instance.status !== "running"}
                          label={`凭据「${credential.name}」的代理`}
                          placeholder={
                            credential.proxyId
                              ? "当前节点不可用，请重新选择"
                              : "未绑定节点（沿用当前出口）"
                          }
                          onChange={(proxyId) =>
                            void run(async () => {
                              await cpaApi.credentialProxy(instance.id, credential.name, proxyId);
                              await credentialsChanged();
                              setNotice("凭据代理已更新。");
                            })
                          }
                        />
                        {!credential.proxyId && (
                          <p class="network-muted">现有凭据沿用部署出口；选择节点后才会更换。</p>
                        )}
                      </div>
                      <div class="network-actions">
                        <button
                          type="button"
                          disabled={busy || instance.status !== "running"}
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
                  onChange={setOAuthProxy}
                />
                <p class="network-muted">
                  {proxies.some((proxy) => proxy.id === browserProxyId)
                    ? "默认使用当前浏览器配置的出口，可单独更改。"
                    : "请先选择授权使用的代理节点。"}
                </p>
                <div class="network-actions">
                  <button
                    type="button"
                    disabled={busy || instance.status !== "running" || !selectedOAuthProxy}
                    onClick={() =>
                      void run(async () => {
                        setOAuth(await cpaApi.oauth(instance.id, selectedOAuthProxy));
                        setCallback("");
                      })
                    }
                  >
                    生成 Claude 授权链接
                  </button>
                </div>
                {oauth && (
                  <>
                    <a
                      class="network-link"
                      href={oauth.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      打开 Claude 授权页 ↗
                    </a>
                    <p class="network-muted">
                      在授权页完成操作后，可提交浏览器跳转的完整回调 URL 或授权码。
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
              <section class="network-card network-form" aria-labelledby="cpa-keys-title">
                <h3 id="cpa-keys-title">外部 API Key</h3>
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
            </>
          )}
        </>
      )}
    </div>
  );
}
