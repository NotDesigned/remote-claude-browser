/** CPA tenancy is an instance boundary: each owner has different config and OAuth storage. */
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FrontendUser } from "../auth/users";

export class CpaError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface CpaInstance {
  id: string;
  ownerId: string | null;
  scope: "user" | "shared";
  desiredState: "running" | "stopped";
  createdAt: number;
  apiKey: string;
  managementKey: string;
}
export interface CpaKey {
  id: string;
  instanceId: string;
  userId: string;
  name: string;
  prefix: string;
  createdAt: number;
}
interface InstanceRow {
  id: string;
  owner_id: string | null;
  desired_state: "running" | "stopped";
  created_at: number;
  api_key: string;
  management_key: string;
}
const instance = (row: InstanceRow): CpaInstance => ({
  id: row.id,
  ownerId: row.owner_id,
  scope: row.owner_id === null ? "shared" : "user",
  desiredState: row.desired_state,
  createdAt: row.created_at,
  apiKey: row.api_key,
  managementKey: row.management_key,
});
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const keyInfo = (row: Record<string, unknown>): CpaKey => ({
  id: String(row.id),
  instanceId: String(row.instance_id),
  userId: String(row.user_id),
  name: String(row.name),
  prefix: String(row.prefix),
  createdAt: Number(row.created_at),
});
export function canManageCpa(user: FrontendUser, value: CpaInstance): boolean {
  return (
    user.enabled &&
    (value.ownerId === user.id || (value.scope === "shared" && user.role === "admin"))
  );
}
export const publicCpaInstance = (value: CpaInstance, user: FrontendUser) => ({
  id: value.id,
  ownerId: value.ownerId,
  scope: value.scope,
  desiredState: value.desiredState,
  createdAt: value.createdAt,
  canManage: canManageCpa(user, value),
});

export async function createCpaStore(options: {
  file: string;
  now?: () => number;
  legacySharedKeyOwnerId?: string;
}) {
  if (options.file !== ":memory:") {
    await mkdir(dirname(options.file), { recursive: true, mode: 0o700 });
    await (await open(options.file, "a", 0o600)).close();
    await chmod(options.file, 0o600);
  }
  const db = new DatabaseSync(options.file);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS cpa_instances (
      id TEXT PRIMARY KEY, owner_id TEXT UNIQUE, scope_key TEXT UNIQUE NOT NULL,
      desired_state TEXT NOT NULL CHECK (desired_state IN ('running','stopped')),
      created_at INTEGER NOT NULL, api_key TEXT NOT NULL, management_key TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cpa_api_keys (
      id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES cpa_instances(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
      prefix TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cpa_credential_proxies (
      instance_id TEXT NOT NULL REFERENCES cpa_instances(id) ON DELETE CASCADE,
      name TEXT NOT NULL, proxy_id TEXT NOT NULL, PRIMARY KEY(instance_id,name)
    );
    CREATE TABLE IF NOT EXISTS cpa_oauth_sessions (
      state TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES cpa_instances(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, proxy_id TEXT, created_at INTEGER NOT NULL
    );`);
  const keyColumns = db.prepare("PRAGMA table_info(cpa_api_keys)").all();
  if (!keyColumns.some((column) => column.name === "user_id")) {
    db.exec("BEGIN");
    try {
      db.exec(`ALTER TABLE cpa_api_keys RENAME TO cpa_api_keys_legacy;
        CREATE TABLE cpa_api_keys (
          id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES cpa_instances(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
          prefix TEXT NOT NULL, created_at INTEGER NOT NULL
        );`);
      db.prepare(
        `INSERT INTO cpa_api_keys
        SELECT k.id,k.instance_id,COALESCE(i.owner_id,?),k.name,k.token_hash,k.prefix,k.created_at
        FROM cpa_api_keys_legacy k JOIN cpa_instances i ON i.id=k.instance_id`,
      ).run(options.legacySharedKeyOwnerId ?? null);
      db.exec("DROP TABLE cpa_api_keys_legacy; COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }
  const oauthColumns = db.prepare("PRAGMA table_info(cpa_oauth_sessions)").all();
  if (!oauthColumns.some((column) => column.name === "url"))
    db.exec("ALTER TABLE cpa_oauth_sessions ADD COLUMN url TEXT");
  if (!oauthColumns.some((column) => column.name === "completed"))
    db.exec("ALTER TABLE cpa_oauth_sessions ADD COLUMN completed INTEGER NOT NULL DEFAULT 0");
  if (options.file !== ":memory:") {
    await chmod(options.file + "-wal", 0o600);
    await chmod(options.file + "-shm", 0o600);
  }
  const now = options.now ?? Date.now;
  const get = (id: string): CpaInstance | undefined => {
    const row = db.prepare("SELECT * FROM cpa_instances WHERE id=?").get(id) as unknown as
      InstanceRow | undefined;
    return row && instance(row);
  };
  const saveKey = (instanceId: string, name: string, token: string, userId: string): CpaKey => {
    const clean = name.trim();
    if (!clean || [...clean].length > 80)
      throw new CpaError(400, "CPA_KEY_NAME", "调用密钥名称需要 1 到 80 个字");
    const result = {
      id: `key-${randomBytes(10).toString("hex")}`,
      instanceId,
      userId,
      name: clean,
      prefix: token.slice(0, 12),
      createdAt: now(),
    };
    db.prepare("INSERT INTO cpa_api_keys VALUES(?,?,?,?,?,?,?)").run(
      result.id,
      instanceId,
      userId,
      clean,
      digest(token),
      result.prefix,
      result.createdAt,
    );
    return result;
  };
  return {
    get,
    ownedBy(userId: string): CpaInstance | undefined {
      const row = db
        .prepare("SELECT * FROM cpa_instances WHERE owner_id=?")
        .get(userId) as unknown as InstanceRow | undefined;
      return row && instance(row);
    },
    runningInstances(): CpaInstance[] {
      return (
        db
          .prepare(
            "SELECT * FROM cpa_instances WHERE desired_state='running' ORDER BY created_at,id",
          )
          .all() as unknown as InstanceRow[]
      ).map(instance);
    },
    credentialBindings(instanceId: string): { name: string; proxyId: string }[] {
      return db
        .prepare(
          "SELECT name,proxy_id FROM cpa_credential_proxies WHERE instance_id=? ORDER BY name",
        )
        .all(instanceId)
        .map((row) => ({ name: String(row.name), proxyId: String(row.proxy_id) }));
    },
    countCredentialBindings(proxyIds: string[]): number {
      const ids = new Set(proxyIds);
      return db
        .prepare("SELECT proxy_id FROM cpa_credential_proxies")
        .all()
        .filter((row) => ids.has(String(row.proxy_id))).length;
    },
    listFor(user: FrontendUser): CpaInstance[] {
      return (
        db
          .prepare(
            "SELECT * FROM cpa_instances WHERE owner_id=? OR owner_id IS NULL ORDER BY created_at,id",
          )
          .all(user.id) as unknown as InstanceRow[]
      ).map(instance);
    },
    create(user: FrontendUser, scope: "user" | "shared" = "user"): CpaInstance {
      if (!user.enabled || (scope === "shared" && user.role !== "admin"))
        throw new CpaError(403, "CPA_FORBIDDEN", "没有管理共享 CPA 的权限");
      const scopeKey = scope === "shared" ? "shared" : `user:${user.id}`;
      const existing = db
        .prepare("SELECT * FROM cpa_instances WHERE scope_key=?")
        .get(scopeKey) as unknown as InstanceRow | undefined;
      if (existing) return instance(existing);
      const value: CpaInstance = {
        id: `cpa-${randomBytes(10).toString("hex")}`,
        ownerId: scope === "shared" ? null : user.id,
        scope,
        desiredState: "stopped",
        createdAt: now(),
        apiKey: randomBytes(32).toString("base64url"),
        managementKey: randomBytes(32).toString("base64url"),
      };
      db.prepare("INSERT INTO cpa_instances VALUES(?,?,?,?,?,?,?)").run(
        value.id,
        value.ownerId,
        scopeKey,
        value.desiredState,
        value.createdAt,
        value.apiKey,
        value.managementKey,
      );
      return value;
    },
    requireManaged(user: FrontendUser, id: string): CpaInstance {
      const value = get(id);
      if (!value || !canManageCpa(user, value))
        throw new CpaError(403, "CPA_FORBIDDEN", "这个 CPA 实例不属于当前用户");
      return value;
    },
    requireUsable(user: FrontendUser, id: string): CpaInstance {
      const value = get(id);
      if (!value || !user.enabled || (value.scope !== "shared" && value.ownerId !== user.id))
        throw new CpaError(403, "CPA_FORBIDDEN", "无权使用这个 CPA 实例");
      return value;
    },
    setDesiredState(id: string, state: "running" | "stopped") {
      db.prepare("UPDATE cpa_instances SET desired_state=? WHERE id=?").run(state, id);
    },
    listKeys(instanceId: string): CpaKey[] {
      return db
        .prepare("SELECT * FROM cpa_api_keys WHERE instance_id=? ORDER BY created_at,id")
        .all(instanceId)
        .map(keyInfo);
    },
    issueKey(instanceId: string, name: string, userId: string): CpaKey & { token: string } {
      const token = `rcpa_${randomBytes(32).toString("base64url")}`;
      return { ...saveKey(instanceId, name, token, userId), token };
    },
    /** Registers a legacy caller key without retaining or returning the original token. */
    importKey(instanceId: string, name: string, token: string, userId?: string): CpaKey {
      const existing = db
        .prepare("SELECT * FROM cpa_api_keys WHERE token_hash=?")
        .get(digest(token));
      if (existing) {
        if (existing.instance_id !== instanceId)
          throw new CpaError(409, "CPA_KEY_CONFLICT", "调用密钥已属于其他 CPA 实例");
        return keyInfo(existing);
      }
      const owner = userId ?? get(instanceId)?.ownerId;
      if (!owner) throw new CpaError(400, "CPA_KEY_OWNER", "导入共享调用密钥时需要指定用户");
      return saveKey(instanceId, name, token, owner);
    },
    resolveKey(token: string): { instance: CpaInstance; userId: string } | undefined {
      const row = db
        .prepare(
          "SELECT i.*,k.user_id FROM cpa_instances i JOIN cpa_api_keys k ON k.instance_id=i.id WHERE k.token_hash=?",
        )
        .get(digest(token)) as unknown as (InstanceRow & { user_id: string }) | undefined;
      return row && { instance: instance(row), userId: row.user_id };
    },
    revokeKey(instanceId: string, keyId: string) {
      db.prepare("DELETE FROM cpa_api_keys WHERE instance_id=? AND id=?").run(instanceId, keyId);
    },
    revokeUserKeys(userId: string) {
      db.prepare("DELETE FROM cpa_api_keys WHERE user_id=?").run(userId);
    },
    setCredentialProxy(instanceId: string, name: string, proxyId: string) {
      db.prepare(
        "INSERT INTO cpa_credential_proxies VALUES(?,?,?) ON CONFLICT(instance_id,name) DO UPDATE SET proxy_id=excluded.proxy_id",
      ).run(instanceId, name, proxyId);
    },
    credentialProxy(instanceId: string, name: string): string | null {
      const row = db
        .prepare("SELECT proxy_id FROM cpa_credential_proxies WHERE instance_id=? AND name=?")
        .get(instanceId, name);
      return row ? String(row.proxy_id) : null;
    },
    removeCredential(instanceId: string, name: string) {
      db.prepare("DELETE FROM cpa_credential_proxies WHERE instance_id=? AND name=?").run(
        instanceId,
        name,
      );
    },
    recordOAuth(
      instanceId: string,
      state: string,
      provider: string,
      proxyId: string | null,
      url?: string,
    ) {
      db.prepare("DELETE FROM cpa_oauth_sessions WHERE created_at<?").run(
        now() - 24 * 60 * 60 * 1000,
      );
      db.prepare(
        "INSERT INTO cpa_oauth_sessions(state,instance_id,provider,proxy_id,created_at,url) VALUES(?,?,?,?,?,?)",
      ).run(state, instanceId, provider, proxyId, now(), url ?? null);
    },
    pendingOAuth(instanceId: string) {
      return db
        .prepare(
          "SELECT state,proxy_id FROM cpa_oauth_sessions WHERE instance_id=? AND completed=0 AND created_at>=?",
        )
        .all(instanceId, now() - 24 * 60 * 60 * 1000)
        .map((row) => ({
          state: String(row.state),
          proxyId: row.proxy_id === null ? null : String(row.proxy_id),
        }));
    },
    completeOAuth(instanceId: string, state: string) {
      db.prepare("UPDATE cpa_oauth_sessions SET completed=1 WHERE instance_id=? AND state=?").run(
        instanceId,
        state,
      );
    },
    oauthUrl(instanceId: string, state: string): string | undefined {
      const row = db
        .prepare(
          "SELECT url FROM cpa_oauth_sessions WHERE instance_id=? AND state=? AND completed=0 AND created_at>=?",
        )
        .get(instanceId, state, now() - 24 * 60 * 60 * 1000);
      return typeof row?.url === "string" ? row.url : undefined;
    },
    oauth(
      instanceId: string,
      state: string,
    ): { provider: string; proxyId: string | null } | undefined {
      const row = db
        .prepare("SELECT provider,proxy_id FROM cpa_oauth_sessions WHERE instance_id=? AND state=?")
        .get(instanceId, state);
      return row
        ? {
            provider: String(row.provider),
            proxyId: row.proxy_id === null ? null : String(row.proxy_id),
          }
        : undefined;
    },
    close() {
      db.close();
    },
  };
}
export type CpaStore = Awaited<ReturnType<typeof createCpaStore>>;
