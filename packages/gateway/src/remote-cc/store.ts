/**
 * Durable state of the remote-cc integration, all owned by workbench users:
 * - tokens, issued only through a device approval in the workbench:
 *   "client" — remote-cc on a user's computer (reads that user's profiles,
 *              asks for session grants and one-click logins);
 *   "host"   — an egress host (admin approval only); it redeems session grants
 *              for node configurations, credentials included.
 * - host nodes: which node an egress host received on whose grant, so it can
 *   refresh that node later and loses it when that user loses access.
 * Only SHA-256 digests of tokens are stored; a token is handed out once.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type RemoteCcTokenKind = "client" | "host";
export interface RemoteCcToken {
  id: string;
  userId: string;
  kind: RemoteCcTokenKind;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}
export class RemoteCcError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const TOKEN_PREFIX: Record<RemoteCcTokenKind, string> = { client: "rcck_", host: "rcch_" };
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const info = (row: Record<string, unknown>): RemoteCcToken => ({
  id: String(row.id),
  userId: String(row.user_id),
  kind: row.kind as RemoteCcTokenKind,
  name: String(row.name),
  prefix: String(row.prefix),
  createdAt: Number(row.created_at),
  lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
});
/** At most this many live tokens of one kind per user. */
export const MAX_TOKENS = 20;
/** last_used_at is written at most this often per token. */
const TOUCH_INTERVAL_MS = 60_000;

export type RemoteCcStore = Awaited<ReturnType<typeof createRemoteCcStore>>;

export async function createRemoteCcStore(options: { file: string; now?: () => number }) {
  if (options.file !== ":memory:") {
    await mkdir(dirname(options.file), { recursive: true, mode: 0o700 });
    await (await open(options.file, "a", 0o600)).close();
    await chmod(options.file, 0o600);
  }
  const db = new DatabaseSync(options.file);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS remote_cc_tokens (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('client','host')),
      name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS remote_cc_tokens_user ON remote_cc_tokens(user_id);
    CREATE TABLE IF NOT EXISTS remote_cc_host_nodes (
      host_id TEXT NOT NULL REFERENCES remote_cc_tokens(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL, user_id TEXT NOT NULL, granted_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, node_id, user_id)
    );`);
  if (options.file !== ":memory:") {
    await chmod(options.file + "-wal", 0o600).catch(() => {});
    await chmod(options.file + "-shm", 0o600).catch(() => {});
  }
  const now = options.now ?? Date.now;
  return {
    list(userId: string): RemoteCcToken[] {
      return db
        .prepare("SELECT * FROM remote_cc_tokens WHERE user_id=? ORDER BY created_at,id")
        .all(userId)
        .map(info);
    },
    issue(
      userId: string,
      kind: RemoteCcTokenKind,
      name: string,
    ): RemoteCcToken & { token: string } {
      const trimmed = name.trim();
      if (!trimmed || [...trimmed].length > 80)
        throw new RemoteCcError(400, "REMOTE_CC_TOKEN_NAME", "名称需要 1 到 80 个字");
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM remote_cc_tokens WHERE user_id=? AND kind=?")
        .get(userId, kind) as { n: number };
      if (count.n >= MAX_TOKENS)
        throw new RemoteCcError(
          409,
          "REMOTE_CC_TOKEN_LIMIT",
          `每种连接最多 ${MAX_TOKENS} 个，请先撤销不用的`,
        );
      const token = `${TOKEN_PREFIX[kind]}${randomBytes(32).toString("base64url")}`;
      const row = {
        id: `rcc-${randomBytes(10).toString("hex")}`,
        user_id: userId,
        kind,
        name: trimmed,
        prefix: token.slice(0, TOKEN_PREFIX[kind].length + 6),
        created_at: now(),
        last_used_at: null,
      };
      db.prepare(
        "INSERT INTO remote_cc_tokens (id,user_id,kind,name,token_hash,prefix,created_at,last_used_at) VALUES (?,?,?,?,?,?,?,NULL)",
      ).run(row.id, userId, kind, trimmed, digest(token), row.prefix, row.created_at);
      return { ...info(row), token };
    },
    /** The token's record if it is live and of the expected kind; records its use. */
    resolve(token: unknown, kind: RemoteCcTokenKind): RemoteCcToken | undefined {
      if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX[kind]) || token.length > 200)
        return undefined;
      const row = db
        .prepare("SELECT * FROM remote_cc_tokens WHERE token_hash=? AND kind=?")
        .get(digest(token), kind);
      if (!row) return undefined;
      const record = info(row);
      const at = now();
      if (record.lastUsedAt === null || at - record.lastUsedAt >= TOUCH_INTERVAL_MS) {
        db.prepare("UPDATE remote_cc_tokens SET last_used_at=? WHERE id=?").run(at, record.id);
        record.lastUsedAt = at;
      }
      return record;
    },
    revoke(userId: string, id: string): boolean {
      return (
        Number(
          db.prepare("DELETE FROM remote_cc_tokens WHERE user_id=? AND id=?").run(userId, id)
            .changes,
        ) > 0
      );
    },
    /** Records that a host received a node on a user's grant. */
    recordHostNode(hostId: string, nodeId: string, userId: string) {
      db.prepare(
        "INSERT INTO remote_cc_host_nodes (host_id,node_id,user_id,granted_at) VALUES (?,?,?,?) ON CONFLICT(host_id,node_id,user_id) DO UPDATE SET granted_at=excluded.granted_at",
      ).run(hostId, nodeId, userId, now());
    },
    /** The users on whose grants a host received a node, most recent first. */
    hostNodeUsers(hostId: string, nodeId: string): string[] {
      return db
        .prepare(
          "SELECT user_id FROM remote_cc_host_nodes WHERE host_id=? AND node_id=? ORDER BY granted_at DESC",
        )
        .all(hostId, nodeId)
        .map((row) => String(row.user_id));
    },
    forgetHostNode(hostId: string, nodeId: string, userId: string) {
      db.prepare(
        "DELETE FROM remote_cc_host_nodes WHERE host_id=? AND node_id=? AND user_id=?",
      ).run(hostId, nodeId, userId);
    },
    removeUser(userId: string) {
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM remote_cc_host_nodes WHERE user_id=?").run(userId);
        db.prepare("DELETE FROM remote_cc_tokens WHERE user_id=?").run(userId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}
