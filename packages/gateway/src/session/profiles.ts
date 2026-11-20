/**
 * The accounts a session can use. Each one is a Chrome of its own with its own profile: logins,
 * cookies and storage stay apart, though host and egress fingerprints can match. The default
 * account is the profile the gateway has always used.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ClientSessionError } from "./clients";
import type { ExitMetadata } from "../egress/timezone";
import {
  browserIdentity,
  type BrowserEngine,
  type BrowserIdentity,
  type BrowserPlatform,
} from "../browser/identity";
import type { ClaudeKyc, ClaudeLogin } from "../claude/signed-in";

export const DEFAULT_PROFILE = "default";
export const MAX_PROFILES = 8;
const ID = /^p-[0-9a-f]{10}$/;

export interface ProfileRecord {
  id: string;
  name: string;
  createdAt: number;
  /** The Claude account it was last seen signed in to; null once seen signed out. */
  email?: string | null;
  signedIn?: boolean;
  /** The site explicitly rejected this account, rather than just failing to respond. */
  unavailable?: boolean;
  /** Last KYC response for the selected Claude organization. */
  kyc?: ClaudeKyc;
  /** Stable proxy catalog node; null/absent prevents opening the browser. */
  proxyId?: string | null;
  /** Last detected IANA zone of this profile's exit. Cleared when its exit changes. */
  timeZone?: string;
  exitCity?: string;
  exitCountry?: string;
  exitIp?: string;
  checkedAt?: number;
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
  options: {
    file?: string;
    now?: () => number;
    maxProfiles?: number;
    /** Used once to preserve the identity of records written before identities were saved. */
    legacyIdentitySecret?: string;
    /** Applies only to newly created profiles; saved and legacy identities are unchanged. */
    browserEngine?: BrowserEngine;
    fingerprintPlatform?: BrowserPlatform;
  } = {},
) {
  const now = options.now ?? Date.now;
  const maxProfiles = options.maxProfiles ?? MAX_PROFILES;
  if (maxProfiles !== Infinity && (!Number.isSafeInteger(maxProfiles) || maxProfiles < 1))
    throw new Error("Invalid browser profile capacity");
  const records = new Map<string, ProfileRecord>([
    [DEFAULT_PROFILE, { id: DEFAULT_PROFILE, name: "默认账号", createdAt: 0 }],
  ]);
  const legacyIdentity = (id: string) => browserIdentity(options.legacyIdentitySecret ?? "", id);
  const identities = new Map<string, BrowserIdentity>([
    [DEFAULT_PROFILE, legacyIdentity(DEFAULT_PROFILE)],
  ]);
  let migrateIdentities = true;
  if (options.file) {
    try {
      const parsed: unknown = JSON.parse(await readFile(options.file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Invalid account store");
      records.clear();
      identities.clear();
      migrateIdentities = false;
      for (const value of parsed) {
        const record = value as Partial<ProfileRecord> & { identity?: BrowserIdentity };
        if (
          !isProfileId(record.id) ||
          typeof record.name !== "string" ||
          !Number.isFinite(record.createdAt)
        )
          throw new Error("Invalid account record");
        identities.set(record.id, record.identity ?? legacyIdentity(record.id));
        if (record.identity === undefined) migrateIdentities = true;
        records.set(record.id, {
          id: record.id,
          name: cleanName(record.name),
          createdAt: record.createdAt!,
          ...(typeof record.email === "string" || record.email === null
            ? { email: record.email }
            : {}),
          ...(record.unavailable === true ? { unavailable: true } : {}),
          ...(typeof record.signedIn === "boolean" ? { signedIn: record.signedIn } : {}),
          ...(record.kyc ? { kyc: record.kyc } : {}),
          ...(typeof record.proxyId === "string" ? { proxyId: record.proxyId } : {}),
          ...(typeof record.timeZone === "string" ? { timeZone: record.timeZone } : {}),
          ...(typeof record.exitCity === "string" ? { exitCity: record.exitCity } : {}),
          ...(typeof record.exitCountry === "string" ? { exitCountry: record.exitCountry } : {}),
          ...(typeof record.exitIp === "string" ? { exitIp: record.exitIp } : {}),
          ...(typeof record.checkedAt === "number" ? { checkedAt: record.checkedAt } : {}),
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
        await writeFile(
          temporary,
          JSON.stringify(
            [...records.values()].map((record) => ({
              ...record,
              identity: identities.get(record.id),
            })),
          ),
          { mode: 0o600 },
        );
        await rename(temporary, options.file);
      });
    return tail;
  };
  // Save every legacy identity before accepting requests, including profiles that stay closed.
  if (migrateIdentities) await persist();
  const known = (id: unknown): ProfileRecord => {
    const record = isProfileId(id) ? records.get(id) : undefined;
    if (!record) throw new ClientSessionError(404, "PROFILE_UNKNOWN", "没有这个账号");
    return record;
  };
  const setExitMetadata = async (id: string, metadata: ExitMetadata | undefined): Promise<void> => {
    const record = known(id);
    if (
      record.timeZone === metadata?.timeZone &&
      record.exitCity === metadata?.exitCity &&
      record.exitCountry === metadata?.exitCountry &&
      record.exitIp === metadata?.exitIp &&
      record.checkedAt === metadata?.checkedAt
    )
      return;
    const previous = {
      timeZone: record.timeZone,
      exitCity: record.exitCity,
      exitCountry: record.exitCountry,
      exitIp: record.exitIp,
      checkedAt: record.checkedAt,
    };
    record.timeZone = metadata?.timeZone;
    record.exitCity = metadata?.exitCity;
    record.exitCountry = metadata?.exitCountry;
    record.exitIp = metadata?.exitIp;
    record.checkedAt = metadata?.checkedAt;
    try {
      await persist();
    } catch (error) {
      Object.assign(record, previous);
      throw error;
    }
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
    identity(id: string): BrowserIdentity {
      known(id);
      return identities.get(id)!;
    },
    async create(
      name: unknown,
      platform = options.fingerprintPlatform ?? "windows",
    ): Promise<ProfileRecord> {
      const clean = cleanName(name);
      if (records.size >= maxProfiles)
        throw new ClientSessionError(409, "PROFILE_LIMIT", `最多 ${maxProfiles} 个浏览器配置`);
      let id: string;
      do id = `p-${randomBytes(5).toString("hex")}`;
      while (records.has(id));
      const record = { id, name: clean, createdAt: now() };
      records.set(id, record);
      const identity = browserIdentity(randomBytes(32).toString("hex"), id);
      if (options.browserEngine === "aliasmode")
        identity.fingerprint = {
          engine: "aliasmode",
          seed: randomBytes(16).toString("hex"),
          platform,
        };
      identities.set(id, identity);
      try {
        await persist();
      } catch (error) {
        records.delete(id);
        identities.delete(id);
        throw error;
      }
      return record;
    },
    async setPlatform(id: string, platform: BrowserPlatform): Promise<void> {
      known(id);
      const identity = identities.get(id)!;
      const previous = identity.fingerprint;
      if ((previous?.platform ?? "linux") === platform) return;
      identity.fingerprint = {
        engine: "aliasmode",
        seed: previous?.seed ?? randomBytes(16).toString("hex"),
        platform,
      };
      try {
        await persist();
      } catch (error) {
        if (previous) identity.fingerprint = previous;
        else delete identity.fingerprint;
        throw error;
      }
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
    async setProxy(id: string, proxyId: string | null): Promise<void> {
      const record = known(id);
      const previous = record.proxyId;
      const previousMetadata = {
        kyc: record.kyc,
        timeZone: record.timeZone,
        exitCity: record.exitCity,
        exitCountry: record.exitCountry,
        exitIp: record.exitIp,
        checkedAt: record.checkedAt,
      };
      record.proxyId = proxyId;
      delete record.kyc;
      delete record.timeZone;
      delete record.exitCity;
      delete record.exitCountry;
      delete record.exitIp;
      delete record.checkedAt;
      try {
        await persist();
      } catch (error) {
        record.proxyId = previous;
        Object.assign(record, previousMetadata);
        throw error;
      }
    },
    setExitMetadata,
    setTimeZone: (id: string, timeZone: string | undefined): Promise<void> =>
      setExitMetadata(id, timeZone === undefined ? undefined : { timeZone }),
    /** Remembers who it is signed in as. Unchanged values are not written again. */
    async setLogin(id: string, login: ClaudeLogin): Promise<void> {
      const record = records.get(id);
      if (
        !record ||
        (record.email === login.email &&
          record.signedIn === login.signedIn &&
          !!record.unavailable === !!login.unavailable &&
          record.kyc?.status === login.kyc?.status &&
          record.kyc?.organizationId === login.kyc?.organizationId &&
          record.kyc?.checkedAt === login.kyc?.checkedAt)
      )
        return;
      record.email = login.email;
      record.signedIn = login.signedIn;
      record.unavailable = !!login.unavailable;
      record.kyc = login.kyc;
      await persist();
    },
    async remove(id: unknown): Promise<void> {
      const record = known(id);
      const identity = identities.get(record.id)!;
      records.delete(record.id);
      identities.delete(record.id);
      try {
        await persist();
      } catch (error) {
        records.set(record.id, record);
        identities.set(record.id, identity);
        throw error;
      }
    },
  };
}
