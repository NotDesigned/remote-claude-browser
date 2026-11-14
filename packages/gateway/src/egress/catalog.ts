import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FrontendUser } from "../auth/users";
import type { MihomoProxy } from "./mihomo";
import { parseSubscription } from "./subscription";

export class ProxyCatalogError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export type ProxyVisibility = "shared" | "private";
export interface ProxySourceInfo {
  id: string;
  name: string;
  visibility: ProxyVisibility;
  ownerId: string;
  ownerName: string | null;
  nodeCount: number;
  subscription: boolean;
  canManage: boolean;
  updatedAt: number;
}
export interface ProxyNodeInfo {
  id: string;
  sourceId: string;
  name: string;
  type: MihomoProxy["type"];
  visibility: ProxyVisibility;
  ownerId: string;
}
interface ProxyNode {
  id: string;
  config: MihomoProxy;
}
interface ProxySource {
  id: string;
  name: string;
  visibility: ProxyVisibility;
  ownerId: string;
  url?: string;
  nodes: ProxyNode[];
  updatedAt: number;
}
export interface ProxySourceInput {
  name: string;
  visibility: ProxyVisibility;
  content?: string;
  url?: string;
}
export interface ProxySourceUpdate {
  name?: string;
  visibility?: ProxyVisibility;
  content?: string;
}
export interface ResolvedProxy {
  id: string;
  name: string;
  url: string;
}
export interface ProxySourceUsage {
  profiles: number;
  credentials: number;
}
export interface ProxyCatalogOptions {
  file: string;
  usernameFor(id: string): string | undefined;
  usageForNodes(ids: string[]): ProxySourceUsage;
  endpointForNode(id: string, node: MihomoProxy, user: FrontendUser): Promise<string>;
  onRemovedNodes?(ids: string[]): Promise<void>;
  onChangedNodes?(ids: string[]): Promise<void>;
  fetcher?: typeof fetch;
}

export type ProxyCatalog = Awaited<ReturnType<typeof createProxyCatalog>>;

export async function createProxyCatalog(options: ProxyCatalogOptions) {
  let sources: ProxySource[];
  try {
    sources = JSON.parse(await readFile(options.file, "utf8")).sources;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    sources = [];
  }
  let tail = Promise.resolve();
  const enabled = (user: FrontendUser) => {
    if (!user.enabled) throw new ProxyCatalogError(403, "USER_DISABLED", "这个用户已停用");
  };
  const visible = (user: FrontendUser, source: ProxySource) =>
    source.visibility === "shared" || source.ownerId === user.id || user.role === "admin";
  const managed = (user: FrontendUser, source: ProxySource) =>
    user.role === "admin" || (source.visibility === "private" && source.ownerId === user.id);
  const sourceFor = (user: FrontendUser, id: string, write = false) => {
    enabled(user);
    const source = sources.find((item) => item.id === id);
    if (!source || !visible(user, source))
      throw new ProxyCatalogError(404, "PROXY_SOURCE_UNKNOWN", "没有这个代理源");
    if (write && !managed(user, source))
      throw new ProxyCatalogError(403, "PROXY_SOURCE_FORBIDDEN", "无权管理这个代理源");
    return source;
  };
  const info = (user: FrontendUser, source: ProxySource): ProxySourceInfo => ({
    id: source.id,
    name: source.name,
    visibility: source.visibility,
    ownerId: source.ownerId,
    ownerName: options.usernameFor(source.ownerId) ?? null,
    nodeCount: source.nodes.length,
    subscription: !!source.url,
    canManage: managed(user, source),
    updatedAt: source.updatedAt,
  });
  const save = <T>(operation: () => Promise<{ next: ProxySource[]; result: T }>): Promise<T> => {
    const result = tail.then(async () => {
      const { next, result } = await operation();
      await mkdir(dirname(options.file), { recursive: true, mode: 0o700 });
      await writeFile(options.file + ".next", JSON.stringify({ version: 1, sources: next }), {
        mode: 0o600,
      });
      await rename(options.file + ".next", options.file);
      const replacements = new Map(
        next.flatMap((source) => source.nodes).map((node) => [node.id, node]),
      );
      const removed = sources
        .flatMap((source) => source.nodes)
        .filter((node) => !replacements.has(node.id))
        .map((node) => node.id);
      const changedVisibility = new Set(
        sources
          .filter((source) => {
            const replacement = next.find((item) => item.id === source.id);
            return replacement && replacement.visibility !== source.visibility;
          })
          .flatMap((source) => source.nodes.map((node) => node.id)),
      );
      const changed = sources
        .flatMap((source) => source.nodes)
        .filter((node) => {
          const replacement = replacements.get(node.id);
          const { name: _oldName, ...oldConfig } = node.config;
          const { name: _newName, ...newConfig } = replacement?.config ?? {};
          return (
            replacement &&
            (changedVisibility.has(node.id) || canonical(newConfig) !== canonical(oldConfig))
          );
        })
        .map((node) => node.id);
      sources = next;
      if (removed.length) await options.onRemovedNodes?.(removed);
      if (changed.length) await options.onChangedNodes?.(changed);
      return result;
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const loadSubscription = async (value: string) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ProxyCatalogError(400, "PROXY_SOURCE_URL", "订阅地址需要 HTTP 或 HTTPS");
    }
    if (!["http:", "https:"].includes(url.protocol))
      throw new ProxyCatalogError(400, "PROXY_SOURCE_URL", "订阅地址需要 HTTP 或 HTTPS");
    let response: Response;
    try {
      response = await (options.fetcher ?? fetch)(url.href, {
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
      });
    } catch {
      throw new ProxyCatalogError(502, "PROXY_SUBSCRIPTION_NETWORK", "无法读取订阅地址");
    }
    if (!response.ok)
      throw new ProxyCatalogError(
        502,
        "PROXY_SUBSCRIPTION_HTTP",
        `订阅读取失败（${response.status}）`,
      );
    return parseSubscription(await response.text());
  };
  const nodeFor = (user: FrontendUser, id: string) => {
    enabled(user);
    for (const source of sources) {
      const node = source.nodes.find((item) => item.id === id);
      if (node && visible(user, source)) return node;
    }
    throw new ProxyCatalogError(404, "PROXY_UNKNOWN", "代理节点已移除或不属于当前用户");
  };
  return {
    sourceUsage(user: FrontendUser, id: string): ProxySourceUsage {
      const source = sourceFor(user, id, true);
      return options.usageForNodes(source.nodes.map((node) => node.id));
    },
    listSources(user: FrontendUser): ProxySourceInfo[] {
      enabled(user);
      return sources.filter((source) => visible(user, source)).map((source) => info(user, source));
    },
    listNodes(user: FrontendUser): ProxyNodeInfo[] {
      enabled(user);
      return sources
        .filter((source) => visible(user, source))
        .flatMap((source) =>
          source.nodes.map((node) => ({
            id: node.id,
            sourceId: source.id,
            name: node.config.name,
            type: node.config.type,
            visibility: source.visibility,
            ownerId: source.ownerId,
          })),
        );
    },
    async importSource(user: FrontendUser, input: ProxySourceInput): Promise<ProxySourceInfo> {
      enabled(user);
      checkSourceInput(user, input);
      if ((input.content === undefined) === (input.url === undefined))
        throw new ProxyCatalogError(
          400,
          "PROXY_SOURCE_CONTENT",
          "请提供订阅地址或节点内容其中一项",
        );
      const proxies =
        input.url === undefined
          ? parseSubscription(input.content!)
          : await loadSubscription(input.url);
      return save(async () => {
        const id = `source-${randomUUID()}`;
        const source: ProxySource = {
          id,
          name: input.name.trim(),
          visibility: input.visibility,
          ownerId: user.id,
          ...(input.url === undefined ? {} : { url: input.url }),
          nodes: matchNodes(id, [], proxies),
          updatedAt: Date.now(),
        };
        return { next: [...sources, source], result: info(user, source) };
      });
    },
    updateSource(
      user: FrontendUser,
      id: string,
      input: ProxySourceUpdate,
    ): Promise<ProxySourceInfo> {
      return save(async () => {
        const current = sourceFor(user, id, true);
        const source = {
          ...current,
          name: input.name ?? current.name,
          visibility: input.visibility ?? current.visibility,
        };
        checkSourceInput(user, source);
        source.name = source.name.trim();
        if (input.content !== undefined)
          source.nodes = matchNodes(id, current.nodes, parseSubscription(input.content));
        source.updatedAt = Date.now();
        return {
          next: sources.map((item) => (item.id === id ? source : item)),
          result: info(user, source),
        };
      });
    },
    async refreshSource(user: FrontendUser, id: string): Promise<ProxySourceInfo> {
      const current = sourceFor(user, id, true);
      if (!current.url)
        throw new ProxyCatalogError(400, "PROXY_SOURCE_LOCAL", "手动导入的代理源没有订阅地址");
      const proxies = await loadSubscription(current.url);
      return save(async () => {
        const latest = sourceFor(user, id, true);
        const source = {
          ...latest,
          nodes: matchNodes(id, latest.nodes, proxies),
          updatedAt: Date.now(),
        };
        return {
          next: sources.map((item) => (item.id === id ? source : item)),
          result: info(user, source),
        };
      });
    },
    removeSource(user: FrontendUser, id: string): Promise<void> {
      return save(async () => {
        sourceFor(user, id, true);
        return { next: sources.filter((source) => source.id !== id), result: undefined };
      });
    },
    getNodeConfig(user: FrontendUser, id: string): MihomoProxy {
      return structuredClone(nodeFor(user, id).config);
    },
    async resolveProxyForUser(user: FrontendUser, id: string): Promise<ResolvedProxy> {
      const node = nodeFor(user, id);
      return {
        id,
        name: node.config.name,
        url: await options.endpointForNode(id, structuredClone(node.config), user),
      };
    },
  };
}

function checkSourceInput(
  user: FrontendUser,
  input: { name: string; visibility: ProxyVisibility },
) {
  if (typeof input.name !== "string" || !input.name.trim() || [...input.name.trim()].length > 80)
    throw new ProxyCatalogError(400, "PROXY_SOURCE_NAME", "代理源名称需要 1 到 80 个字");
  if (!["shared", "private"].includes(input.visibility))
    throw new ProxyCatalogError(400, "PROXY_SOURCE_VISIBILITY", "代理源需要选择共享或私有");
  if (input.visibility === "shared" && user.role !== "admin")
    throw new ProxyCatalogError(403, "PROXY_SOURCE_SHARED", "只有管理员可以管理共享代理源");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function endpoint(node: MihomoProxy) {
  return `${node.type}\0${node.server}\0${node.port}`;
}
function matchNodes(sourceId: string, before: ProxyNode[], proxies: MihomoProxy[]): ProxyNode[] {
  const used = new Set<string>();
  return proxies.map((config) => {
    const candidates = before.filter(
      (node) => !used.has(node.id) && endpoint(node.config) === endpoint(config),
    );
    const old =
      candidates.find((node) => node.config.name === config.name) ??
      (candidates.length === 1 &&
      proxies.filter((node) => endpoint(node) === endpoint(config)).length === 1
        ? candidates[0]
        : undefined);
    const id =
      old?.id ??
      `proxy-${createHash("sha256")
        .update(`${sourceId}\0${endpoint(config)}\0${config.name}`)
        .digest("hex")
        .slice(0, 24)}`;
    if (used.has(id))
      throw new ProxyCatalogError(
        400,
        "PROXY_NODE_DUPLICATE",
        "同一代理源不能包含同名且服务器相同的重复节点",
      );
    used.add(id);
    return { id, config };
  });
}
