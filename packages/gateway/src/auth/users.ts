/**
 * Front-end identities and remembered logins. Site credentials stay in Chrome's own profiles;
 * this database stores only service users, password hashes, login-token hashes and profile owners.
 */
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type UserRole = "admin" | "user";

export interface FrontendUser {
  id: string;
  username: string;
  role: UserRole;
  enabled: boolean;
  createdAt: number;
}

export interface UserSession {
  user: FrontendUser;
  /** Only the caller receives this value. SQLite contains its SHA-256 digest. */
  token: string;
  expiresAt: number;
}

export interface CreateUserInput {
  username: unknown;
  password: unknown;
  role?: unknown;
}

export interface UpdateUserInput {
  username?: unknown;
  password?: unknown;
  role?: unknown;
  enabled?: unknown;
}

export interface UserStoreOptions {
  file: string;
  bootstrapUsername?: string;
  bootstrapPassword?: string;
  now?: () => number;
}

export class UserStoreError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UserStoreError";
  }
}

export const USER_SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const HASH_PATTERN = /^scrypt-v1\$([0-9a-f]{32})\$([0-9a-f]{128})$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

interface UserRow {
  id: string;
  username: string;
  username_key: string;
  password_hash: string;
  role: UserRole;
  enabled: number;
  created_at: number;
}

export interface UserStore {
  readonly bootstrapAdmin: FrontendUser;
  authenticate(username: unknown, password: unknown): Promise<FrontendUser | null>;
  issueSession(userId: string, ttlMs?: number): UserSession;
  session(token: unknown): FrontendUser | null;
  revokeSession(token: unknown): void;
  revokeUserSessions(userId: string): void;
  listUsers(): FrontendUser[];
  getUser(id: string): FrontendUser | undefined;
  createUser(input: CreateUserInput): Promise<FrontendUser>;
  updateUser(id: string, input: UpdateUserInput): Promise<FrontendUser>;
  deleteUser(id: string): void;
  profileOwner(profileId: string): string | undefined;
  listOwnedProfiles(userId: string): string[];
  assignProfile(profileId: string, userId: string): void;
  unassignProfile(profileId: string): void;
  /** Imports the complete legacy profile list once; subsequent calls cannot reclaim deleted users' data. */
  claimLegacyProfiles(profileIds: readonly string[], adminId: string): void;
  close(): void;
}

export async function createUserStore(options: UserStoreOptions): Promise<UserStore> {
  const now = options.now ?? Date.now;
  const persistent = options.file !== ":memory:";
  if (persistent) {
    await mkdir(dirname(options.file), { recursive: true, mode: 0o700 });
    const file = await open(options.file, "a", 0o600);
    await file.close();
    await chmod(options.file, 0o600);
  }
  const db = new DatabaseSync(options.file);
  let closed = false;
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA trusted_schema = OFF;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_key TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS profile_owners (
        profile_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS profile_owners_user ON profile_owners(user_id);
      CREATE TABLE IF NOT EXISTS user_store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Dummy verification follows the same scrypt path for an unknown username.
    const dummyHash = `scrypt-v1$${randomBytes(16).toString("hex")}$${randomBytes(64).toString("hex")}`;
    const transaction = <T>(operation: () => T): T => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };
    const rowById = (id: string): UserRow | undefined =>
      db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    const requireUser = (id: string): UserRow => {
      const user = rowById(id);
      if (!user) throw new UserStoreError(404, "USER_UNKNOWN", "没有这个用户");
      return user;
    };
    const activeAdminCount = (): number =>
      Number(
        db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin' AND enabled = 1").get()!.n,
      );
    const protectLastAdmin = (current: UserRow, role?: UserRole, enabled?: boolean) => {
      if (
        current.role === "admin" &&
        current.enabled === 1 &&
        (role !== "admin" || enabled !== true) &&
        activeAdminCount() <= 1
      )
        throw new UserStoreError(409, "USER_LAST_ADMIN", "需要保留至少一个可用的管理员");
    };
    const pruneSessions = () => {
      db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now());
    };

    const store: UserStore = {
      get bootstrapAdmin() {
        const initial = db
          .prepare("SELECT value FROM user_store_meta WHERE key = 'bootstrap_user_id'")
          .get();
        const original = typeof initial?.value === "string" ? rowById(initial.value) : undefined;
        const user =
          original?.role === "admin" && original.enabled === 1
            ? original
            : (db
                .prepare(
                  "SELECT * FROM users WHERE role = 'admin' AND enabled = 1 ORDER BY created_at, id LIMIT 1",
                )
                .get() as UserRow | undefined);
        if (!user) throw new UserStoreError(500, "USER_NO_ADMIN", "用户数据库没有可用的管理员");
        return publicUser(user);
      },
      async authenticate(username, password) {
        let normalized: ReturnType<typeof cleanUsername>;
        try {
          normalized = cleanUsername(username);
        } catch {
          return null;
        }
        if (!validPassword(password)) return null;
        const user = db
          .prepare("SELECT * FROM users WHERE username_key = ?")
          .get(normalized.key) as UserRow | undefined;
        const hash = user?.password_hash ?? dummyHash;
        const matched = await verifyPassword(password, hash);
        if (!matched || !user || user.enabled !== 1) return null;
        // Password verification yields to account updates. A reset, disable or deletion that
        // completed meanwhile must also invalidate this already-running login.
        const current = rowById(user.id);
        return current?.enabled === 1 &&
          current.password_hash === hash &&
          current.username_key === normalized.key
          ? publicUser(current)
          : null;
      },
      issueSession(userId, ttlMs = USER_SESSION_TTL_MS) {
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > USER_SESSION_TTL_MS)
          throw new UserStoreError(400, "SESSION_EXPIRY", "登录有效期无效");
        const user = requireUser(userId);
        if (user.enabled !== 1) throw new UserStoreError(403, "USER_DISABLED", "这个用户已停用");
        const createdAt = now();
        const expiresAt = createdAt + ttlMs;
        const token = randomBytes(32).toString("base64url");
        transaction(() => {
          pruneSessions();
          db.prepare(
            "INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
          ).run(tokenHash(token), userId, createdAt, expiresAt);
        });
        return { user: publicUser(user), token, expiresAt };
      },
      session(token) {
        if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
        const digest = tokenHash(token);
        const found = db
          .prepare(
            `
          SELECT users.*, auth_sessions.expires_at FROM auth_sessions
          JOIN users ON users.id = auth_sessions.user_id WHERE token_hash = ?
        `,
          )
          .get(digest) as (UserRow & { expires_at: number }) | undefined;
        if (!found) return null;
        if (found.enabled !== 1 || found.expires_at <= now()) {
          db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(digest);
          return null;
        }
        return publicUser(found);
      },
      revokeSession(token) {
        if (typeof token === "string" && TOKEN_PATTERN.test(token))
          db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash(token));
      },
      revokeUserSessions(userId) {
        db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
      },
      listUsers() {
        return (
          db.prepare("SELECT * FROM users ORDER BY created_at, id").all() as unknown as UserRow[]
        ).map(publicUser);
      },
      getUser(id) {
        const user = rowById(id);
        return user === undefined ? undefined : publicUser(user);
      },
      async createUser(input) {
        const username = cleanUsername(input.username);
        const role = cleanRole(input.role ?? "user");
        const hash = await hashPassword(input.password);
        const id = `user-${randomUUID()}`;
        try {
          db.prepare(
            "INSERT INTO users (id, username, username_key, password_hash, role, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
          ).run(id, username.name, username.key, hash, role, now());
        } catch (error) {
          if (isUsernameConflict(error)) throw duplicateUsername();
          throw error;
        }
        return publicUser(requireUser(id));
      },
      async updateUser(id, input) {
        requireUser(id);
        const username = input.username === undefined ? undefined : cleanUsername(input.username);
        const role = input.role === undefined ? undefined : cleanRole(input.role);
        if (input.enabled !== undefined && typeof input.enabled !== "boolean")
          throw new UserStoreError(400, "USER_ENABLED", "用户状态无效");
        const hash = input.password === undefined ? undefined : await hashPassword(input.password);
        try {
          return transaction(() => {
            const current = requireUser(id);
            const nextRole = role ?? current.role;
            const enabled =
              input.enabled === undefined ? current.enabled === 1 : (input.enabled as boolean);
            protectLastAdmin(current, nextRole, enabled);
            db.prepare(
              "UPDATE users SET username = ?, username_key = ?, password_hash = ?, role = ?, enabled = ? WHERE id = ?",
            ).run(
              username?.name ?? current.username,
              username?.key ?? current.username_key,
              hash ?? current.password_hash,
              nextRole,
              enabled ? 1 : 0,
              id,
            );
            if (hash !== undefined || nextRole !== current.role || !enabled)
              db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(id);
            return publicUser(requireUser(id));
          });
        } catch (error) {
          if (isUsernameConflict(error)) throw duplicateUsername();
          throw error;
        }
      },
      deleteUser(id) {
        transaction(() => {
          const user = requireUser(id);
          protectLastAdmin(user);
          db.prepare("DELETE FROM users WHERE id = ?").run(id);
        });
      },
      profileOwner(profileId) {
        const row = db
          .prepare("SELECT user_id FROM profile_owners WHERE profile_id = ?")
          .get(profileId);
        return typeof row?.user_id === "string" ? row.user_id : undefined;
      },
      listOwnedProfiles(userId) {
        return db
          .prepare("SELECT profile_id FROM profile_owners WHERE user_id = ? ORDER BY profile_id")
          .all(userId)
          .map((row) => String(row.profile_id));
      },
      assignProfile(profileId, userId) {
        checkProfileId(profileId);
        transaction(() => {
          requireUser(userId);
          const owner = store.profileOwner(profileId);
          if (owner !== undefined && owner !== userId)
            throw new UserStoreError(409, "PROFILE_OWNED", "这个浏览器已属于其他用户");
          db.prepare(
            "INSERT OR IGNORE INTO profile_owners (profile_id, user_id) VALUES (?, ?)",
          ).run(profileId, userId);
        });
      },
      unassignProfile(profileId) {
        db.prepare("DELETE FROM profile_owners WHERE profile_id = ?").run(profileId);
      },
      claimLegacyProfiles(profileIds, adminId) {
        for (const id of profileIds) checkProfileId(id);
        transaction(() => {
          if (
            db
              .prepare("SELECT 1 FROM user_store_meta WHERE key = 'legacy_profiles_imported_v1'")
              .get()
          )
            return;
          const admin = requireUser(adminId);
          if (admin.role !== "admin" || admin.enabled !== 1)
            throw new UserStoreError(403, "USER_ADMIN_REQUIRED", "旧浏览器需要归属到可用的管理员");
          const insert = db.prepare(
            "INSERT OR IGNORE INTO profile_owners (profile_id, user_id) VALUES (?, ?)",
          );
          for (const id of profileIds) insert.run(id, adminId);
          db.prepare(
            "INSERT INTO user_store_meta (key, value) VALUES ('legacy_profiles_imported_v1', ?)",
          ).run(adminId);
        });
      },
      close() {
        if (closed) return;
        closed = true;
        db.close();
      },
    };

    if (store.listUsers().length === 0) {
      const admin = await store.createUser({
        username: options.bootstrapUsername ?? process.env.MIRROR_ADMIN_USERNAME ?? "admin",
        password: options.bootstrapPassword ?? process.env.MIRROR_ACCESS_PASSWORD,
        role: "admin",
      });
      db.prepare(
        "INSERT OR REPLACE INTO user_store_meta (key, value) VALUES ('bootstrap_user_id', ?)",
      ).run(admin.id);
    }
    // Existing databases are never re-seeded from an environment variable after a password change.
    void store.bootstrapAdmin;
    pruneSessions();
    if (persistent)
      for (const file of [`${options.file}-wal`, `${options.file}-shm`])
        await chmod(file, 0o600).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
    return store;
  } catch (error) {
    db.close();
    throw error;
  }
}

function publicUser(row: UserRow): FrontendUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

function cleanUsername(value: unknown): { name: string; key: string } {
  const name = typeof value === "string" ? value.trim().normalize("NFKC") : "";
  if ([...name].length > 64 || !/^[\p{L}\p{N}][\p{L}\p{N}._@-]*$/u.test(name))
    throw new UserStoreError(
      400,
      "USER_NAME",
      "用户名需要 1 到 64 个字，可使用字母、数字、点、下划线、@ 和连字符",
    );
  return { name, key: name.toLowerCase() };
}

function cleanRole(role: unknown): UserRole {
  if (role !== "admin" && role !== "user")
    throw new UserStoreError(400, "USER_ROLE", "用户权限无效");
  return role;
}

function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && Buffer.byteLength(value, "utf8") <= 1024;
}

async function hashPassword(value: unknown): Promise<string> {
  if (!validPassword(value))
    throw new UserStoreError(400, "USER_PASSWORD", "密码至少需要 8 个字符，且不能超过 1024 字节");
  const salt = randomBytes(16);
  const key = await deriveKey(value, salt);
  return `scrypt-v1$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const match = HASH_PATTERN.exec(hash);
  if (!match) return false;
  const key = await deriveKey(password, Buffer.from(match[1]!, "hex"));
  return timingSafeEqual(key, Buffer.from(match[2]!, "hex"));
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function checkProfileId(id: string) {
  if (!PROFILE_PATTERN.test(id)) throw new UserStoreError(400, "PROFILE_ID", "浏览器标识无效");
}

function duplicateUsername() {
  return new UserStoreError(409, "USER_EXISTS", "这个用户名已经存在");
}

function isUsernameConflict(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("UNIQUE constraint failed: users.username_key")
  );
}
