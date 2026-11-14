/**
 * The accounts a session can use. Each one is a Chrome of its own with its own profile: logins,
 * cookies and storage stay apart, though host and egress fingerprints can match. The default
 * account is the profile the gateway has always used.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ClientSessionError } from "./clients";

export const DEFAULT_PROFILE = "default";
export const MAX_PROFILES = 8;
const ID = /^p-[0-9a-f]{10}$/;

export interface ProfileRecord {
  id: string;
  name: string;
  createdAt: number;
}

export function isProfileId(value: unknown): value is string {
  return value === DEFAULT_PROFILE || (typeof value === "string" && ID.test(value));
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (name.length === 0 || [...name].length > 40)
    throw new ClientSessionError(400, "PROFILE_NAME", "账号名称需要 1 到 40 个字");
  return name;
}

export async function createProfileStore(
  options: { file?: string; now?: () => number; maxProfiles?: number } = {},
) {
  const now = options.now ?? Date.now;
  const maxProfiles = options.maxProfiles ?? MAX_PROFILES;
  if (maxProfiles !== Infinity && (!Number.isSafeInteger(maxProfiles) || maxProfiles < 1))
    throw new Error("Invalid browser profile capacity");
  const records = new Map<string, ProfileRecord>([
    [DEFAULT_PROFILE, { id: DEFAULT_PROFILE, name: "默认账号", createdAt: 0 }],
  ]);
  if (options.file) {
    try {
      const parsed: unknown = JSON.parse(await readFile(options.file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Invalid account store");
      for (const value of parsed) {
        const record = value as Partial<ProfileRecord>;
        if (
          !isProfileId(record.id) ||
          typeof record.name !== "string" ||
          !Number.isFinite(record.createdAt)
        )
          throw new Error("Invalid account record");
        records.set(record.id, {
          id: record.id,
          name: cleanName(record.name),
          createdAt: record.createdAt!,
        });
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
  const known = (id: unknown): ProfileRecord => {
    const record = isProfileId(id) ? records.get(id) : undefined;
    if (!record) throw new ClientSessionError(404, "PROFILE_UNKNOWN", "没有这个账号");
    return record;
  };

  return {
    all(): ProfileRecord[] {
      return [...records.values()];
    },
    get(id: string): ProfileRecord | undefined {
      return records.get(id);
    },
    has(id: unknown): boolean {
      return isProfileId(id) && records.has(id);
    },
    async create(name: unknown): Promise<ProfileRecord> {
      const clean = cleanName(name);
      if (records.size >= maxProfiles)
        throw new ClientSessionError(409, "PROFILE_LIMIT", `最多 ${maxProfiles} 个浏览器配置`);
      let id: string;
      do id = `p-${randomBytes(5).toString("hex")}`;
      while (records.has(id));
      const record = { id, name: clean, createdAt: now() };
      records.set(id, record);
      try {
        await persist();
      } catch (error) {
        records.delete(id);
        throw error;
      }
      return record;
    },
    async rename(id: unknown, name: unknown): Promise<ProfileRecord> {
      const record = known(id);
      const previous = record.name;
      record.name = cleanName(name);
      try {
        await persist();
      } catch (error) {
        record.name = previous;
        throw error;
      }
      return record;
    },
    async remove(id: unknown): Promise<void> {
      const record = known(id);
      if (record.id === DEFAULT_PROFILE)
        throw new ClientSessionError(409, "PROFILE_DEFAULT", "默认账号不能删除");
      records.delete(record.id);
      try {
        await persist();
      } catch (error) {
        records.set(record.id, record);
        throw error;
      }
    },
  };
}
