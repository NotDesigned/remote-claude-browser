import type { FrontendUser } from "../auth/users";
import { createLifecycleLock } from "../session/lifecycle-lock";
import { responseJson, type CpaDriver } from "./broker-client";
import { CpaError, publicCpaInstance, type CpaInstance, type CpaStore } from "./store";

export interface CpaProxy {
  id: string;
  name: string;
  url: string;
}
export interface CpaRuntimeOptions {
  store: CpaStore;
  driver: CpaDriver;
  resolveProxyForUser(user: FrontendUser, proxyId?: string): Promise<CpaProxy>;
  userEnabled(id: string): boolean;
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
  const managed = (user: FrontendUser, id: string) => store.requireManaged(user, id);
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
  const publicInstance = async (value: CpaInstance, user: FrontendUser) => ({
    ...publicCpaInstance(value, user),
    status: await driver.status(value),
  });
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
        if (ids && !ids.includes(proxyId)) continue;
        try {
          let proxy = resolved.get(proxyId);
          if (!proxy) {
            proxy = await options.resolveProxyForUser(
              user,
              proxyId === "deployment-default" ? undefined : proxyId,
            );
            resolved.set(proxyId, proxy);
          }
          await management(value, "PATCH", "/credentials/fields", { name, proxy_url: proxy.url });
        } catch (error) {
          failures.push({
            instanceId: value.id,
            proxyId,
            code: error instanceof CpaError ? error.code : "CPA_PROXY_RESTORE",
          });
        }
      }
    }
    return failures;
  };
  return {
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
            const proxy = await options.resolveProxyForUser(user);
            await driver.ensure(value, proxy.url);
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
            const proxy = await options.resolveProxyForUser(user);
            await driver.ensure(value, proxy.url);
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
        const proxy = await options.resolveProxyForUser(user);
        await driver.ensure(value, proxy.url);
        store.setDesiredState(id, "running");
        const proxyFailures = await restoreBindings(undefined, () => user, [store.get(id)!]);
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
      return (await credentials(managed(user, id))).map((entry) => ({
        name: entry.name,
        provider: entry.provider,
        email: entry.email,
        label: entry.label,
        status: entry.status,
        disabled: entry.disabled === true,
        unavailable: entry.unavailable === true,
        createdAt: entry.created_at,
        updatedAt: entry.updated_at,
        proxyId:
          store.credentialProxy(id, String(entry.name)) === "deployment-default"
            ? null
            : store.credentialProxy(id, String(entry.name)),
      }));
    },
    async credentialStatus(user: FrontendUser, id: string, name: string, disabled: boolean) {
      await management(managed(user, id), "PATCH", "/credentials/status", { name, disabled });
    },
    async credentialProxy(user: FrontendUser, id: string, name: string, proxyId: string) {
      const value = managed(user, id);
      const proxy = await options.resolveProxyForUser(user, proxyNode(proxyId));
      await management(value, "PATCH", "/credentials/fields", { name, proxy_url: proxy.url });
      store.setCredentialProxy(id, name, proxy.id);
    },
    async deleteCredential(user: FrontendUser, id: string, name: string) {
      await management(
        managed(user, id),
        "DELETE",
        `/credentials?name=${encodeURIComponent(name)}`,
      );
      store.removeCredential(id, name);
    },
    async startOAuth(user: FrontendUser, id: string, proxyId: string) {
      const value = managed(user, id);
      const proxy = await options.resolveProxyForUser(user, proxyNode(proxyId));
      const result = await management(value, "POST", "/oauth/auth-url", {
        provider: "claude",
        proxy_url: proxy.url,
      });
      if (typeof result.state !== "string" || typeof result.url !== "string")
        throw new CpaError(502, "CPA_OAUTH", "CPA 没有返回登录链接");
      store.recordOAuth(id, result.state, "claude", proxy.id);
      return { status: "ok", url: result.url, state: result.state };
    },
    async oauthStatus(user: FrontendUser, id: string, state: string) {
      const value = managed(user, id);
      const session = store.oauth(id, state);
      if (!session) throw new CpaError(404, "CPA_OAUTH_UNKNOWN", "没有这个登录会话");
      const result = await management(
        value,
        "GET",
        `/oauth/status?state=${encodeURIComponent(state)}`,
      );
      if (result.status === "ok" && typeof result.auth_id === "string" && session.proxyId) {
        const entry = (await credentials(value)).find(
          (entry) => entry.id === result.auth_id || entry.name === result.auth_id,
        );
        if (entry) store.setCredentialProxy(id, String(entry.name), session.proxyId);
      }
      return {
        status: result.status,
        ...(result.status === "error" ? { error: "登录失败或已过期，请重新登录" } : {}),
      };
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
      managed(user, id);
      return store.listKeys(id);
    },
    issueKey(user: FrontendUser, id: string, name: string) {
      managed(user, id);
      return store.issueKey(id, name);
    },
    revokeKey(user: FrontendUser, id: string, keyId: string) {
      managed(user, id);
      store.revokeKey(id, keyId);
    },
    inference(token: string) {
      const value = store.resolveKey(token);
      if (!value || (value.ownerId !== null && !options.userEnabled(value.ownerId)))
        throw new CpaError(401, "CPA_API_KEY", "调用密钥无效");
      if (value.desiredState !== "running")
        throw new CpaError(503, "CPA_STOPPED", "CPA 实例已停止");
      return value;
    },
    driver,
  };
}
export type CpaRuntime = ReturnType<typeof createCpaRuntime>;
