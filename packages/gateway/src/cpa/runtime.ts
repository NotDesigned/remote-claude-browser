import type { ExitHealth as CpaExitHealth } from "../egress/timezone";
import type { FrontendUser } from "../auth/users";
import { createLifecycleLock } from "../session/lifecycle-lock";
import { responseJson, type CpaDriver } from "./broker-client";
import {
  CpaError,
  canManageCpa,
  publicCpaInstance,
  type CpaInstance,
  type CpaStore,
} from "./store";

const UNBOUND_PROXY = "http://cpa-unbound:x@runtime-egress:8781";

export interface CpaProxy {
  id: string;
  name: string;
  url: string;
  timeZone: string;
  health: CpaExitHealth;
}
export interface CpaRuntimeOptions {
  store: CpaStore;
  driver: CpaDriver;
  resolveProxyForUser(
    user: FrontendUser,
    proxyId: string | undefined,
    instance: CpaInstance,
  ): Promise<CpaProxy>;
  checkProxyForUser(user: FrontendUser, proxyId: string, instance: CpaInstance): Promise<CpaProxy>;
  proxyStatusForInstance(instance: CpaInstance, proxyId: string): Promise<CpaExitHealth>;
  userEnabled(id: string): boolean;
  userName(id: string): string | undefined;
}
type RestoreUser = (instance: CpaInstance) => FrontendUser | undefined;
interface RestoreFailure {
  instanceId: string;
  proxyId?: string;
  code: string;
}
const proxyNode = (proxyId: string): string => {
  if (typeof proxyId !== "string" || !/^(?!deployment-default$)\S+$/.test(proxyId))
    throw new CpaError(400, "CPA_PROXY_REQUIRED", "请先选择出口节点");
  return proxyId;
};

export function createCpaRuntime(options: CpaRuntimeOptions) {
  const { store, driver } = options;
  const lifecycle = createLifecycleLock();
  const proxyStates = new Map<string, { health: CpaExitHealth }>();
  const credentialTimeZones = new Map<string, string>();
  const browserCallbacks = new Map<string, Promise<boolean>>();
  const browserOAuth = (
    user: FrontendUser,
    proxyId: string | null | undefined,
    address: string,
  ) => {
    let page: URL;
    try {
      page = new URL(address);
    } catch {
      return;
    }
    const state = page.searchParams.get("state");
    if (!state || !proxyId || !options.userEnabled(user.id)) return;
    for (const value of store.listFor(user)) {
      if (!canManageCpa(user, value) || value.desiredState !== "running") continue;
      const session = store
        .pendingOAuth(value.id)
        .find((session) => session.state === state && session.proxyId === proxyId);
      const saved = session && store.oauthUrl(value.id, state);
      if (!saved) continue;
      const authorization = new URL(saved);
      const redirect = authorization.searchParams.get("redirect_uri");
      const callback = redirect && new URL(redirect);
      if (callback && page.origin === callback.origin && page.pathname === callback.pathname)
        return { value, state, callback: true };
      if (page.origin === authorization.origin && page.pathname === authorization.pathname)
        return { value, state, callback: false };
    }
  };
  const binding = (id: string, name: string) => {
    const proxyId = store.credentialProxy(id, name);
    return proxyId && proxyId !== "deployment-default" ? proxyId : null;
  };
  const managed = (user: FrontendUser, id: string) => {
    if (!options.userEnabled(user.id)) throw new CpaError(403, "USER_DISABLED", "这个用户已停用");
    return store.requireManaged(user, id);
  };
  const usable = (user: FrontendUser, id: string) => {
    if (!options.userEnabled(user.id)) throw new CpaError(403, "USER_DISABLED", "这个用户已停用");
    return store.requireUsable(user, id);
  };
  const visibleKeys = (user: FrontendUser, id: string) => {
    const value = usable(user, id);
    return store
      .listKeys(id)
      .filter(
        (key) => key.userId === user.id || (value.scope === "shared" && user.role === "admin"),
      );
  };
  const running = (value: CpaInstance) => {
    if (value.desiredState !== "running")
      throw new CpaError(409, "CPA_STOPPED", "请先启动 CPA 实例");
    return value;
  };
  const management = async (value: CpaInstance, method: string, path: string, body?: unknown) =>
    responseJson(
      await driver.request(running(value), {
        method,
        path: `/v8/management${path}`,
        headers: {
          authorization: `Bearer ${value.managementKey}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const credentials = async (value: CpaInstance) => {
    const result = await management(value, "GET", "/credentials");
    return result.files as Record<string, unknown>[];
  };
  const prepare = async (value: CpaInstance) => {
    await driver.ensure(value, UNBOUND_PROXY);
    // Update this one persisted setting; preserve keys, routing and every explicit credential exit.
    await management(
      { ...value, desiredState: "running" },
      "PUT",
      "/config/requests/proxy-url",
      UNBOUND_PROXY,
    );
  };
  const applyProxy = async (value: CpaInstance, name: string, proxy: CpaProxy) => {
    await management(value, "PATCH", "/credentials/fields", {
      name,
      proxy_url: proxy.url,
      timezone: proxy.timeZone,
    });
    proxyStates.set(`${value.id}:${proxy.id}`, proxy);
    credentialTimeZones.set(`${value.id}:${name}`, proxy.timeZone);
  };
  const disableUnbound = async (value: CpaInstance) => {
    for (const entry of await credentials(value))
      if (!binding(value.id, String(entry.name)) && entry.disabled !== true)
        await management(value, "PATCH", "/credentials/status", {
          name: entry.name,
          disabled: true,
        });
  };
  const refreshHealth = async (value: CpaInstance) => {
    for (const proxyId of new Set(
      store.credentialBindings(value.id).map((entry) => entry.proxyId),
    )) {
      if (proxyId === "deployment-default") continue;
      const key = `${value.id}:${proxyId}`;
      let health: CpaExitHealth;
      try {
        health = await options.proxyStatusForInstance(value, proxyId);
      } catch {
        health = { status: "error", error: "出口状态暂不可用，请稍后检查" };
      }
      proxyStates.set(key, { ...proxyStates.get(key), health });
    }
  };
  const publicInstance = async (value: CpaInstance, user: FrontendUser) => {
    const status = await driver.status(value);
    let authorization: "unknown" | "empty" | "needs-binding" | "unavailable" | "ready" = "unknown";
    let egress: CpaExitHealth["status"] = "unchecked";
    if (status === "running" && value.desiredState === "running") {
      try {
        const entries = await credentials(value);
        await refreshHealth(value);
        const enabled = entries.filter(
          (entry) =>
            entry.disabled !== true &&
            entry.unavailable !== true &&
            binding(value.id, String(entry.name)),
        );
        authorization = enabled.length
          ? "ready"
          : !entries.length
            ? "empty"
            : entries.some((entry) => !binding(value.id, String(entry.name)))
              ? "needs-binding"
              : "unavailable";
        const exits = entries
          .filter((entry) => binding(value.id, String(entry.name)))
          .map(
            (entry) =>
              proxyStates.get(`${value.id}:${binding(value.id, String(entry.name))}`)?.health
                .status ?? "unchecked",
          );
        egress = exits.includes("error")
          ? "error"
          : exits.includes("checking")
            ? "checking"
            : exits.length && exits.every((status) => status === "healthy")
              ? "healthy"
              : "unchecked";
      } catch {
        /* A running container can still have an unavailable management API. */
      }
    }
    return {
      ...publicCpaInstance(value, user),
      status,
      authorization,
      egress,
      authorizing: store.pendingOAuth(value.id).length > 0,
    };
  };
  const syncOAuth = async (value: CpaInstance, state: string, user: FrontendUser) => {
    const session = store.oauth(value.id, state);
    if (!session) throw new CpaError(404, "CPA_OAUTH_UNKNOWN", "没有这个登录会话");
    const result = await management(
      value,
      "GET",
      `/oauth/status?state=${encodeURIComponent(state)}`,
    );
    if (
      result.status === "ok" &&
      typeof result.auth_id === "string" &&
      session.proxyId &&
      store.pendingOAuth(value.id).some((item) => item.state === state)
    ) {
      const entry = (await credentials(value)).find(
        (entry) => entry.id === result.auth_id || entry.name === result.auth_id,
      );
      if (entry) {
        const proxy = await options.resolveProxyForUser(user, session.proxyId, value);
        await applyProxy(value, String(entry.name), proxy);
        store.setCredentialProxy(value.id, String(entry.name), session.proxyId);
        store.completeOAuth(value.id, state);
      }
    } else if (result.status === "error") {
      const failures = await restorePendingOAuth(value, user);
      if (!failures.length) store.completeOAuth(value.id, state);
    }
    if (!store.oauthUrl(value.id, state)) browserCallbacks.delete(state);
    return {
      status:
        result.status === "ok" && store.pendingOAuth(value.id).some((item) => item.state === state)
          ? "wait"
          : result.status,
      ...(result.status === "error" ? { error: "登录失败或已过期，请重新登录" } : {}),
    };
  };
  const restorePendingOAuth = async (value: CpaInstance, user: FrontendUser) => {
    const proxyIds = new Map<string, CpaProxy>();
    const failures: RestoreFailure[] = [];
    for (const { proxyId } of store.pendingOAuth(value.id))
      if (proxyId) {
        try {
          const proxy = await options.resolveProxyForUser(user, proxyId, value);
          proxyIds.set(proxy.url, proxy);
        } catch {
          failures.push({ instanceId: value.id, proxyId, code: "CPA_OAUTH_PROXY_RESTORE" });
        }
      }
    if (!proxyIds.size) return failures;
    // CPA's OAuth status is in memory. Its saved credential is the durable source after a restart.
    for (const entry of await credentials(value)) {
      const name = String(entry.name);
      const file = await management(
        value,
        "GET",
        `/credentials/download?name=${encodeURIComponent(name)}`,
      );
      const proxy = typeof file.proxy_url === "string" ? proxyIds.get(file.proxy_url) : undefined;
      if (proxy) {
        await applyProxy(value, name, proxy);
        store.setCredentialProxy(value.id, name, proxy.id);
      }
    }
    return failures;
  };
  const restoreBindings = async (
    ids: readonly string[] | undefined,
    resolveUser: RestoreUser,
    instances = store.runningInstances(),
  ) => {
    const failures: RestoreFailure[] = [];
    for (const value of instances) {
      const user = resolveUser(value);
      if (!user?.enabled) {
        failures.push({ instanceId: value.id, code: "CPA_OWNER_UNAVAILABLE" });
        continue;
      }
      const resolved = new Map<string, CpaProxy>();
      for (const { name, proxyId } of store.credentialBindings(value.id)) {
        if (proxyId === "deployment-default" || (ids && !ids.includes(proxyId))) continue;
        try {
          let proxy = resolved.get(proxyId);
          if (!proxy) {
            proxy = await options.resolveProxyForUser(user, proxyId, value);
            resolved.set(proxyId, proxy);
          }
          await applyProxy(value, name, proxy);
        } catch (error) {
          proxyStates.set(`${value.id}:${proxyId}`, {
            ...proxyStates.get(`${value.id}:${proxyId}`),
            health: { status: "error", error: "出口恢复失败，请检查节点后重试" },
          });
          failures.push({
            instanceId: value.id,
            proxyId,
            code: error instanceof CpaError ? error.code : "CPA_PROXY_RESTORE",
          });
        }
      }
      await disableUnbound(value);
    }
    return failures;
  };
  return {
    managementInstance(user: FrontendUser, id: string) {
      return publicCpaInstance(running(managed(user, id)), user);
    },
    managementRequest(user: FrontendUser, id: string, input: import("./broker-client").CpaRequest) {
      const value = running(managed(user, id));
      return driver.request(value, {
        ...input,
        headers: { ...input.headers, authorization: `Bearer ${value.managementKey}` },
      });
    },
    pendingOAuth(user: FrontendUser, id: string) {
      managed(user, id);
      return store.pendingOAuth(id).flatMap((session) => {
        const url = store.oauthUrl(id, session.state);
        return url && session.proxyId ? [{ ...session, proxyId: session.proxyId, url }] : [];
      });
    },
    browserAuthorizing(user: FrontendUser, proxyId: string | null | undefined, address: string) {
      return browserOAuth(user, proxyId, address) !== undefined;
    },
    captureBrowserCallback(
      user: FrontendUser,
      proxyId: string | null | undefined,
      address: string,
    ) {
      const match = browserOAuth(user, proxyId, address);
      const params = match?.callback ? new URL(address).searchParams : undefined;
      if (!match?.callback || !(params?.get("code") || params?.get("error")))
        return Promise.resolve(false);
      const { value, state } = match;
      let pending = browserCallbacks.get(state);
      if (!pending) {
        pending = lifecycle.run(async () => {
          const current = managed(user, value.id);
          if (!store.oauthUrl(value.id, state)) return false;
          await management(current, "POST", "/oauth/callback", {
            provider: "claude",
            state,
            redirect_url: address,
          });
          return true;
        });
        browserCallbacks.set(state, pending);
        void pending.catch(() => browserCallbacks.delete(state));
      }
      return pending;
    },
    reconcileOAuth(resolveUser: RestoreUser) {
      return lifecycle.run(async () => {
        const failures: RestoreFailure[] = [];
        for (const value of store.runningInstances()) {
          const user = resolveUser(value);
          if (!user?.enabled) continue;
          for (const { state } of store.pendingOAuth(value.id)) {
            try {
              await syncOAuth(value, state, user);
            } catch {
              failures.push({ instanceId: value.id, code: "CPA_OAUTH_SYNC" });
            }
          }
          await refreshHealth(value);
          for (const { name, proxyId } of store.credentialBindings(value.id)) {
            const health = proxyStates.get(`${value.id}:${proxyId}`)?.health;
            const key = `${value.id}:${name}`;
            const timeZone = health?.timeZone;
            if (
              health?.status !== "healthy" ||
              !timeZone ||
              credentialTimeZones.get(key) === timeZone
            )
              continue;
            try {
              await management(value, "PATCH", "/credentials/fields", { name, timezone: timeZone });
              credentialTimeZones.set(key, timeZone);
            } catch {
              failures.push({ instanceId: value.id, proxyId, code: "CPA_TIMEZONE_SYNC" });
            }
          }
        }
        return { failures };
      });
    },
    suspendUser(userId: string) {
      return lifecycle.run(async () => {
        const value = store.ownedBy(userId);
        if (!value) return;
        store.setDesiredState(value.id, "stopped");
        await driver.stop(value);
      });
    },
    removeUser(userId: string) {
      return lifecycle.run(async () => {
        const value = store.ownedBy(userId);
        if (value) {
          await driver.remove(value);
          for (const cache of [proxyStates, credentialTimeZones])
            for (const key of cache.keys()) if (key.startsWith(`${value.id}:`)) cache.delete(key);
          for (const { state } of store.pendingOAuth(value.id)) browserCallbacks.delete(state);
        }
        store.removeUser(userId);
      });
    },
    drain() {
      return lifecycle.run(async () => {});
    },
    oauthPage(user: FrontendUser, id: string, state: string) {
      managed(user, id);
      const session = store.oauth(id, state);
      const url = store.oauthUrl(id, state);
      if (!session || !url) throw new CpaError(409, "CPA_OAUTH_EXPIRED", "请重新生成授权链接");
      return { url, proxyId: session.proxyId };
    },
    restore(resolveUser: RestoreUser) {
      return lifecycle.run(async () => {
        const failures: RestoreFailure[] = [];
        const restored: string[] = [];
        for (const value of store.runningInstances()) {
          const user = resolveUser(value);
          if (!user?.enabled) {
            failures.push({ instanceId: value.id, code: "CPA_OWNER_UNAVAILABLE" });
            continue;
          }
          try {
            await prepare(value);
            failures.push(...(await restorePendingOAuth(value, user)));
            failures.push(...(await restoreBindings(undefined, resolveUser, [value])));
            restored.push(value.id);
          } catch (error) {
            failures.push({
              instanceId: value.id,
              code: error instanceof CpaError ? error.code : "CPA_INSTANCE_RESTORE",
            });
          }
        }
        return { restored, failures };
      });
    },
    restoreBindings(ids: readonly string[], resolveUser: RestoreUser) {
      return lifecycle.run(async () => {
        const failures: RestoreFailure[] = [];
        for (const value of store.runningInstances()) {
          if (!store.credentialBindings(value.id).some((binding) => ids.includes(binding.proxyId)))
            continue;
          const user = resolveUser(value);
          if (!user?.enabled) {
            failures.push({ instanceId: value.id, code: "CPA_OWNER_UNAVAILABLE" });
            continue;
          }
          try {
            await prepare(value);
            failures.push(...(await restoreBindings(ids, resolveUser, [value])));
          } catch (error) {
            failures.push({
              instanceId: value.id,
              code: error instanceof CpaError ? error.code : "CPA_INSTANCE_RESTORE",
            });
          }
        }
        return { failures };
      });
    },
    async list(user: FrontendUser) {
      return Promise.all(store.listFor(user).map((value) => publicInstance(value, user)));
    },
    async create(user: FrontendUser, scope: "user" | "shared") {
      return publicInstance(store.create(user, scope), user);
    },
    start(user: FrontendUser, id: string) {
      return lifecycle.run(async () => {
        const value = managed(user, id);
        await prepare(value);
        store.setDesiredState(id, "running");
        const proxyFailures = await restorePendingOAuth(store.get(id)!, user);
        proxyFailures.push(...(await restoreBindings(undefined, () => user, [store.get(id)!])));
        return { ...(await publicInstance(store.get(id)!, user)), proxyFailures };
      });
    },
    stop(user: FrontendUser, id: string) {
      return lifecycle.run(async () => {
        const value = managed(user, id);
        await driver.stop(value);
        store.setDesiredState(id, "stopped");
        return publicInstance(store.get(id)!, user);
      });
    },
    async credentials(user: FrontendUser, id: string) {
      const value = managed(user, id);
      await refreshHealth(value);
      return (await credentials(value)).map((entry) => ({
        name: entry.name,
        provider: entry.provider,
        email: entry.email,
        label: entry.label,
        status: entry.status,
        disabled: entry.disabled === true,
        unavailable: entry.unavailable === true,
        createdAt: entry.created_at,
        updatedAt: entry.updated_at,
        proxyId: binding(id, String(entry.name)),
        needsBinding: !binding(id, String(entry.name)),
        timeZone: credentialTimeZones.get(`${id}:${String(entry.name)}`),
        exitHealth: proxyStates.get(`${id}:${binding(id, String(entry.name))}`)?.health ?? {
          status: "unchecked" as const,
        },
      }));
    },
    async credentialStatus(user: FrontendUser, id: string, name: string, disabled: boolean) {
      const value = managed(user, id);
      if (!disabled) {
        const proxyId = binding(id, name);
        if (!proxyId) throw new CpaError(409, "CPA_PROXY_REQUIRED", "先绑定出口节点，再启用凭据");
        await applyProxy(value, name, await options.resolveProxyForUser(user, proxyId, value));
      }
      await management(value, "PATCH", "/credentials/status", { name, disabled });
    },
    credentialProxy(user: FrontendUser, id: string, name: string, proxyId: string) {
      return lifecycle.run(async () => {
        const value = managed(user, id);
        const proxy = await options.resolveProxyForUser(user, proxyNode(proxyId), value);
        await applyProxy(value, name, proxy);
        store.setCredentialProxy(id, name, proxy.id);
      });
    },
    check(user: FrontendUser, id: string) {
      return lifecycle.run(async () => {
        const value = running(managed(user, id));
        const bindings = store
          .credentialBindings(id)
          .filter((entry) => entry.proxyId !== "deployment-default");
        for (const proxyId of new Set(bindings.map((entry) => entry.proxyId))) {
          try {
            const proxy = await options.checkProxyForUser(user, proxyId, value);
            for (const entry of bindings.filter((entry) => entry.proxyId === proxyId))
              await applyProxy(value, entry.name, proxy);
          } catch {
            proxyStates.set(`${id}:${proxyId}`, {
              health: {
                status: "error",
                checkedAt: Date.now(),
                error: "出口检查失败，请检查节点或订阅后重试",
              },
            });
          }
        }
        return publicInstance(value, user);
      });
    },
    deleteCredential(user: FrontendUser, id: string, name: string) {
      return lifecycle.run(async () => {
        await management(
          managed(user, id),
          "DELETE",
          `/credentials?name=${encodeURIComponent(name)}`,
        );
        store.removeCredential(id, name);
        credentialTimeZones.delete(`${id}:${name}`);
      });
    },
    startOAuth(user: FrontendUser, id: string, proxyId: string) {
      return lifecycle.run(async () => {
        const value = managed(user, id);
        const proxy = await options.resolveProxyForUser(user, proxyNode(proxyId), value);
        const result = await management(value, "POST", "/oauth/auth-url", {
          provider: "claude",
          proxy_url: proxy.url,
        });
        if (typeof result.state !== "string" || typeof result.url !== "string")
          throw new CpaError(502, "CPA_OAUTH", "CPA 没有返回登录链接");
        store.recordOAuth(id, result.state, "claude", proxy.id, result.url);
        return { status: "ok", url: result.url, state: result.state };
      });
    },
    cancelOAuth(user: FrontendUser, id: string) {
      return lifecycle.run(async () => {
        const value = managed(user, id);
        for (const { state } of store.pendingOAuth(id)) {
          const result = await management(
            value,
            "DELETE",
            `/oauth/session?state=${encodeURIComponent(state)}`,
          );
          if (result.cancelled === true) store.completeOAuth(id, state);
          else {
            await syncOAuth(value, state, user);
            if (store.pendingOAuth(id).some((entry) => entry.state === state))
              throw new CpaError(409, "CPA_AUTHORIZING", "授权仍在保存，请稍后再检查或取消");
          }
        }
        await disableUnbound(value);
        return publicInstance(value, user);
      });
    },
    async oauthStatus(user: FrontendUser, id: string, state: string) {
      return lifecycle.run(() => syncOAuth(managed(user, id), state, user));
    },
    async oauthCallback(
      user: FrontendUser,
      id: string,
      input: { state: string; code?: string; redirectUrl?: string; error?: string },
    ) {
      const value = managed(user, id);
      const session = store.oauth(id, input.state);
      if (!session) throw new CpaError(404, "CPA_OAUTH_UNKNOWN", "没有这个登录会话");
      await management(value, "POST", "/oauth/callback", {
        provider: session.provider,
        state: input.state,
        code: input.code,
        redirect_url: input.redirectUrl,
        error: input.error,
      });
    },
    listKeys(user: FrontendUser, id: string) {
      return visibleKeys(user, id).map((key) => ({
        ...key,
        username: options.userName(key.userId) ?? null,
      }));
    },
    issueKey(user: FrontendUser, id: string, name: string) {
      usable(user, id);
      return { ...store.issueKey(id, name, user.id), username: user.username };
    },
    revokeKey(user: FrontendUser, id: string, keyId: string) {
      if (!visibleKeys(user, id).some((key) => key.id === keyId))
        throw new CpaError(403, "CPA_KEY_FORBIDDEN", "无权撤销这个调用密钥");
      store.revokeKey(id, keyId);
    },
    inference(token: string) {
      const resolved = store.resolveKey(token);
      if (!resolved || !options.userEnabled(resolved.userId))
        throw new CpaError(401, "CPA_API_KEY", "调用密钥无效");
      const value = resolved.instance;
      if (value.ownerId !== null && !options.userEnabled(value.ownerId))
        throw new CpaError(401, "CPA_API_KEY", "调用密钥无效");
      if (value.desiredState !== "running")
        throw new CpaError(503, "CPA_STOPPED", "CPA 实例已停止");
      return value;
    },
    driver,
  };
}
export type CpaRuntime = ReturnType<typeof createCpaRuntime>;
