import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const CLIENT_SLOTS = [
  "client-1",
  "client-2",
  "client-3",
  "client-4",
  "client-5",
  "client-6",
  "client-7",
  "client-8",
  "client-9",
  "client-10",
  "client-11",
  "client-12",
  "client-13",
  "client-14",
  "client-15",
  "client-16",
] as const;
export type ClientSlot = (typeof CLIENT_SLOTS)[number];
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
export async function createClientSessions(options: { file?: string; now?: () => number } = {}) {
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
    label: `独立会话 ${CLIENT_SLOTS.indexOf(sid) + 1}`,
  });
  return {
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
    describe,
    available() {
      return CLIENT_SLOTS.length - records.size;
    },
    async acquire(owner: string, clientKey: unknown, requested?: unknown, phone = false) {
      if (!owner || typeof clientKey !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(clientKey))
        throw new ClientSessionError(400, "INVALID_CLIENT_KEY", "客户端标识无效，请刷新重试");
      if (requested !== undefined) {
        if (typeof requested !== "string" || !CLIENT_SLOTS.includes(requested as ClientSlot))
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
      const sid = CLIENT_SLOTS.find((id) => !records.has(id));
      if (!sid)
        throw new ClientSessionError(
          503,
          "CLIENT_CAPACITY",
          "16 个会话均已占用，离线会话会自动回收，请稍后重试",
        );
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
      records.delete(sid as ClientSlot);
      await persist();
    },
  };
}
const PROFILE_ID = /^(default|p-[0-9a-f]{10})$/;
function isRecord(value: unknown): value is ClientRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as ClientRecord;
  return (
    CLIENT_SLOTS.includes(r.sid) &&
    typeof r.owner === "string" &&
    r.owner.length > 0 &&
    typeof r.clientKey === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(r.clientKey) &&
    Number.isFinite(r.createdAt) &&
    (r.profile === undefined || (typeof r.profile === "string" && PROFILE_ID.test(r.profile)))
  );
}
