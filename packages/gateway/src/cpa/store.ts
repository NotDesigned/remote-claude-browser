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

export async function createCpaStore(options: { file: string; now?: () => number }) {
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
      name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cpa_credential_proxies (
      instance_id TEXT NOT NULL REFERENCES cpa_instances(id) ON DELETE CASCADE,
      name TEXT NOT NULL, proxy_id TEXT NOT NULL, PRIMARY KEY(instance_id,name)
    );
    CREATE TABLE IF NOT EXISTS cpa_oauth_sessions (
      state TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES cpa_instances(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, proxy_id TEXT, created_at INTEGER NOT NULL
    );`);
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
  return {
    get,
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
    setDesiredState(id: string, state: "running" | "stopped") {
      db.prepare("UPDATE cpa_instances SET desired_state=? WHERE id=?").run(state, id);
    },
    listKeys(instanceId: string): CpaKey[] {
      return db
        .prepare("SELECT * FROM cpa_api_keys WHERE instance_id=? ORDER BY created_at,id")
        .all(instanceId)
        .map(keyInfo);
    },
    issueKey(instanceId: string, name: string): CpaKey & { token: string } {
      const clean = name.trim();
      if (!clean || [...clean].length > 80)
        throw new CpaError(400, "CPA_KEY_NAME", "调用密钥名称需要 1 到 80 个字");
      const token = `rcpa_${randomBytes(32).toString("base64url")}`;
      const result = {
        id: `key-${randomBytes(10).toString("hex")}`,
        instanceId,
        name: clean,
        prefix: token.slice(0, 12),
        createdAt: now(),
      };
      db.prepare("INSERT INTO cpa_api_keys VALUES(?,?,?,?,?,?)").run(
        result.id,
        instanceId,
        clean,
        digest(token),
        result.prefix,
        result.createdAt,
      );
      return { ...result, token };
    },
    resolveKey(token: string): CpaInstance | undefined {
      const row = db
        .prepare(
          "SELECT i.* FROM cpa_instances i JOIN cpa_api_keys k ON k.instance_id=i.id WHERE k.token_hash=?",
        )
        .get(digest(token)) as unknown as InstanceRow | undefined;
      return row && instance(row);
    },
    revokeKey(instanceId: string, keyId: string) {
      db.prepare("DELETE FROM cpa_api_keys WHERE instance_id=? AND id=?").run(instanceId, keyId);
    },
    revokeUserKeys(userId: string) {
      db.prepare(
        "DELETE FROM cpa_api_keys WHERE instance_id IN (SELECT id FROM cpa_instances WHERE owner_id=?)",
      ).run(userId);
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
    recordOAuth(instanceId: string, state: string, provider: string, proxyId: string | null) {
      db.prepare("DELETE FROM cpa_oauth_sessions WHERE created_at<?").run(
        now() - 24 * 60 * 60 * 1000,
      );
      db.prepare("INSERT INTO cpa_oauth_sessions VALUES(?,?,?,?,?)").run(
        state,
        instanceId,
        provider,
        proxyId,
        now(),
      );
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
