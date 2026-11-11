import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_SESSION_CAPACITY = 8;
export type ClientSlot = `client-${number}`;

export function parseSessionCapacity(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MIRROR_CLIENTS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_SESSION_CAPACITY;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error("MIRROR_CLIENTS must be a positive safe integer");
  return sessionCapacity(Number(raw));
}

function sessionCapacity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("MIRROR_CLIENTS must be a positive safe integer");
  return value;
}

/** A persisted slot remains valid when the operator reduces the admission limit. */
export function isClientSlot(value: unknown): value is ClientSlot {
  return (
    typeof value === "string" &&
    /^client-[1-9]\d*$/.test(value) &&
    Number.isSafeInteger(Number(value.slice("client-".length)))
  );
}
export interface ClientRecord {
  sid: ClientSlot;
  owner: string;
  clientKey: string;
  createdAt: number;
  /** Opened from a phone, so it lives in the browser that asks for Claude's phone interface. */
  phone?: boolean;
  /** The account it uses, when not the default one. */
  profile?: string;
}
export class ClientSessionError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Stable device ownership is separate from the workspace selected in a browser tab. */
export async function createClientSessions(
  options: { file?: string; now?: () => number; maxSessions?: number } = {},
) {
  const maxSessions = sessionCapacity(options.maxSessions ?? parseSessionCapacity());
  const records = new Map<ClientSlot, ClientRecord>();
  const now = options.now ?? Date.now;
  if (options.file) {
    try {
      const parsed: unknown = JSON.parse(await readFile(options.file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Invalid client session store");
      for (const record of parsed) {
        if (!isRecord(record) || records.has(record.sid))
          throw new Error("Invalid client session record");
        records.set(record.sid, record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let tail = Promise.resolve();
  const persist = () => {
    tail = tail
      .catch(() => undefined)
      .then(async () => {
        if (!options.file) return;
        await mkdir(dirname(options.file), { recursive: true, mode: 0o700 });
        const temporary = options.file + ".next";
        await writeFile(temporary, JSON.stringify([...records.values()]), { mode: 0o600 });
        await rename(temporary, options.file);
      });
    return tail;
  };
  const owns = (owner: string | undefined, sid: string) =>
    !!owner && records.get(sid as ClientSlot)?.owner === owner;
  const describe = (sid: ClientSlot) => ({
    sid,
    label: `独立会话 ${sid.slice("client-".length)}`,
  });
  return {
    capacity() {
      return maxSessions;
    },
    *slots(): IterableIterator<ClientSlot> {
      for (let slot = 1; slot <= maxSessions; slot++) yield `client-${slot}`;
    },
    owns,
    all() {
      return [...records.values()];
    },
    get(sid: string) {
      return records.get(sid as ClientSlot);
    },
    owned(owner: string) {
      return [...records.values()].filter((r) => r.owner === owner).map((r) => describe(r.sid));
    },
    /** Rebind legacy device identities during user-account migration, retaining every session. */
    async migrateOwners(mapper: (owner: string) => string): Promise<void> {
      const changes = [...records.values()].map((record) => ({
        record,
        previous: record.owner,
        next: mapper(record.owner),
      }));
      if (changes.some(({ next }) => typeof next !== "string" || next.length === 0))
        throw new Error("Invalid migrated session owner");
      if (changes.every(({ previous, next }) => previous === next)) return;
      for (const { record, next } of changes) record.owner = next;
      try {
        await persist();
      } catch (error) {
        for (const { record, previous } of changes) record.owner = previous;
        throw error;
      }
    },
    describe,
    available() {
      return Math.max(0, maxSessions - records.size);
    },
    async acquire(owner: string, clientKey: unknown, requested?: unknown, phone = false) {
      if (!owner || typeof clientKey !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(clientKey))
        throw new ClientSessionError(400, "INVALID_CLIENT_KEY", "客户端标识无效，请刷新重试");
      if (requested !== undefined) {
        if (!isClientSlot(requested))
          throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个独立会话不属于当前客户端");
        const hinted = records.get(requested as ClientSlot);
        if (hinted && hinted.owner !== owner)
          throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个独立会话不属于当前客户端");
        if (hinted) return hinted;
      }
      const current = [...records.values()].find(
        (r) => r.owner === owner && r.clientKey === clientKey,
      );
      if (current) return current;
      if (records.size >= maxSessions)
        throw new ClientSessionError(
          503,
          "CLIENT_CAPACITY",
          `${maxSessions} 个会话均已占用，离线会话会自动回收，请稍后重试`,
        );
      let slot = 1;
      while (records.has(`client-${slot}`)) slot++;
      const sid: ClientSlot = `client-${slot}`;
      const record: ClientRecord = {
        sid,
        owner,
        clientKey,
        createdAt: now(),
        ...(phone ? { phone } : {}),
      };
      records.set(sid, record);
      try {
        await persist();
      } catch (error) {
        if (records.get(sid) === record) records.delete(sid);
        throw error;
      }
      return record;
    },
    /** The account a session uses. */
    profileOf(sid: string): string {
      return records.get(sid as ClientSlot)?.profile ?? "default";
    },
    async setProfile(owner: string, sid: string, profile: string) {
      if (!owns(owner, sid))
        throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个独立会话不属于当前客户端");
      if (!PROFILE_ID.test(profile))
        throw new ClientSessionError(404, "PROFILE_UNKNOWN", "没有这个账号");
      const record = records.get(sid as ClientSlot)!;
      const previous = record.profile;
      if (profile === "default") delete record.profile;
      else record.profile = profile;
      try {
        await persist();
      } catch (error) {
        if (previous === undefined) delete record.profile;
        else record.profile = previous;
        throw error;
      }
    },
    async release(owner: string, sid: string) {
      if (!owns(owner, sid))
        throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个独立会话不属于当前客户端");
      const record = records.get(sid as ClientSlot)!;
      records.delete(sid as ClientSlot);
      try {
        await persist();
      } catch (error) {
        if (!records.has(record.sid)) records.set(record.sid, record);
        throw error;
      }
    },
  };
}
const PROFILE_ID = /^(default|p-[0-9a-f]{10})$/;
function isRecord(value: unknown): value is ClientRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as ClientRecord;
  return (
    isClientSlot(r.sid) &&
    typeof r.owner === "string" &&
    r.owner.length > 0 &&
    typeof r.clientKey === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(r.clientKey) &&
    Number.isFinite(r.createdAt) &&
    (r.profile === undefined || (typeof r.profile === "string" && PROFILE_ID.test(r.profile)))
  );
}
