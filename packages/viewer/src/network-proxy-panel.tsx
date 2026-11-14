import { useEffect, useState } from "preact/hooks";
import type { FrontendUser } from "./users";
import {
  proxyApi,
  type ProxyInfo,
  type ProxySourceInfo,
  type ProxySourceInput,
} from "./network-api";

export function ProxyPanel({ user }: { user: FrontendUser }) {
  const [sources, setSources] = useState<ProxySourceInfo[]>([]);
  const [proxies, setProxies] = useState<ProxyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProxySourceInfo | null>(null);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<ProxySourceInput["visibility"]>("private");
  const [mode, setMode] = useState<"content" | "url">("content");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");

  const reload = async () => {
    const [catalog, nodes] = await Promise.all([proxyApi.sources(), proxyApi.proxies()]);
    setSources(catalog.sources);
    setProxies(nodes.proxies);
  };
  useEffect(() => {
    void reload()
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, []);
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
  const reset = () => {
    setEditing(null);
    setName("");
    setContent("");
    setUrl("");
    setVisibility("private");
  };
  const ownerLabel = (source: ProxySourceInfo) =>
    source.ownerId === user.id ? "你" : (source.ownerName ?? "已删除用户");
  const confirmChange = async (
    source: ProxySourceInfo,
    action: "delete" | "update" | "refresh",
  ) => {
    const { usage } = await proxyApi.usage(source.id);
    const question =
      action === "delete"
        ? `删除来源「${source.name}」及其节点？`
        : action === "refresh"
          ? `刷新「${source.name}」的订阅节点？`
          : `更改「${source.name}」的节点或可见范围？`;
    const impact =
      usage.profiles || usage.credentials
        ? `当前绑定 ${usage.profiles} 个浏览器配置、${usage.credentials} 个 CPA 授权。${
            action === "delete"
              ? "删除后，相关浏览器会话会关闭，CPA 授权失去出口，需要重新选择节点。"
              : "节点或可见范围发生变化时，相关浏览器会话会断开重连；不可用的节点需要重新选择。"
          }`
        : "当前没有浏览器配置或 CPA 授权绑定这些节点。";
    return window.confirm(`${question}\n\n所有者：${ownerLabel(source)}。${impact}`);
  };
  const save = (event: Event) => {
    event.preventDefault();
    void run(async () => {
      if (editing) {
        if (
          (visibility !== editing.visibility || content.trim()) &&
          !(await confirmChange(editing, "update"))
        )
          return;
        await proxyApi.update(editing.id, {
          name: name.trim(),
          visibility,
          ...(content.trim() ? { content } : {}),
        });
      } else
        await proxyApi.create({
          name: name.trim(),
          visibility,
          ...(mode === "url" ? { url: url.trim() } : { content }),
        });
      reset();
      await reload();
      setNotice(editing ? "来源已更新。" : "代理来源已导入。");
    });
  };

  return (
    <div class="network-section" aria-busy={busy || loading}>
      <p class="network-muted">
        私有来源仅所有者和管理员可使用、管理；共享来源由管理员管理，所有用户可使用。浏览器配置和 CPA
        授权可分别选择节点。
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
      <div class="network-columns">
        <section class="network-card" aria-labelledby="proxy-sources-title">
          <div class="network-card-heading">
            <h3 id="proxy-sources-title">代理来源</h3>
            <button type="button" disabled={busy} onClick={() => void run(reload)}>
              刷新列表
            </button>
          </div>
          {loading && (
            <p class="network-muted" role="status">
              正在加载代理来源…
            </p>
          )}
          {!loading && sources.length === 0 && (
            <p class="network-muted">还没有代理来源，先导入节点或订阅。</p>
          )}
          <ul class="network-list">
            {sources.map((source) => (
              <li key={source.id}>
                <div class="network-item-heading">
                  <strong>{source.name}</strong>
                  <span class="network-badge">
                    {source.visibility === "shared" ? "共享" : "私有"}
                  </span>
                </div>
                <p class="network-muted">
                  所有者：{ownerLabel(source)} · {source.nodeCount} 个节点
                  {source.subscription ? " · 订阅" : " · 手动导入"}
                </p>
                {source.canManage && (
                  <div class="network-actions">
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`编辑来源「${source.name}」`}
                      onClick={() => {
                        setEditing(source);
                        setName(source.name);
                        setVisibility(source.visibility);
                        setContent("");
                        setUrl("");
                        setError(null);
                      }}
                    >
                      编辑
                    </button>
                    {source.subscription && (
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`刷新订阅「${source.name}」`}
                        onClick={() =>
                          void run(async () => {
                            if (!(await confirmChange(source, "refresh"))) return;
                            await proxyApi.refresh(source.id);
                            await reload();
                            setNotice("订阅已刷新。");
                          })
                        }
                      >
                        刷新订阅
                      </button>
                    )}
                    <button
                      type="button"
                      class="network-danger"
                      disabled={busy}
                      aria-label={`删除来源「${source.name}」`}
                      onClick={() =>
                        void run(async () => {
                          if (!(await confirmChange(source, "delete"))) return;
                          await proxyApi.remove(source.id);
                          if (editing?.id === source.id) reset();
                          await reload();
                          setNotice("来源已删除。");
                        })
                      }
                    >
                      删除
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
        <form class="network-card network-form" onSubmit={save}>
          <h3>{editing ? `编辑「${editing.name}」` : "导入代理来源"}</h3>
          <label>
            来源名称
            <input
              value={name}
              maxLength={80}
              required
              disabled={busy}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label>
            可见范围
            <select
              value={visibility}
              disabled={busy}
              onChange={(event) =>
                setVisibility(event.currentTarget.value as ProxySourceInput["visibility"])
              }
            >
              <option value="private">私有</option>
              {user.role === "admin" && <option value="shared">共享</option>}
            </select>
          </label>
          {!editing && (
            <label>
              导入方式
              <select
                value={mode}
                disabled={busy}
                onChange={(event) => setMode(event.currentTarget.value as "content" | "url")}
              >
                <option value="content">粘贴 YAML 或节点链接</option>
                <option value="url">订阅 URL</option>
              </select>
            </label>
          )}
          {!editing && mode === "url" ? (
            <label>
              订阅 URL
              <input
                type="url"
                value={url}
                required
                disabled={busy}
                placeholder="https://…"
                onInput={(event) => setUrl(event.currentTarget.value)}
              />
            </label>
          ) : (
            <label>
              {editing ? "替换节点内容（留空保留）" : "节点内容"}
              <textarea
                rows={7}
                value={content}
                required={!editing}
                disabled={busy}
                spellcheck={false}
                placeholder="Mihomo YAML 或每行一个节点链接"
                onInput={(event) => setContent(event.currentTarget.value)}
              />
            </label>
          )}
          <div class="network-actions">
            <button class="network-primary" type="submit" disabled={busy || name.trim() === ""}>
              {busy ? "处理中…" : editing ? "保存来源" : "导入来源"}
            </button>
            {editing && (
              <button type="button" disabled={busy} onClick={reset}>
                取消编辑
              </button>
            )}
          </div>
        </form>
      </div>
      <section class="network-card" aria-labelledby="proxy-nodes-title">
        <h3 id="proxy-nodes-title">可用节点 · {proxies.length}</h3>
        <ul class="network-node-list">
          {proxies.map((proxy) => {
            const source = sources.find((source) => source.id === proxy.sourceId);
            return (
              <li key={proxy.id}>
                <span>{proxy.name}</span>
                <span class="network-muted">
                  {proxy.type} · {source?.name}
                  {source && ` · ${ownerLabel(source)}`}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
