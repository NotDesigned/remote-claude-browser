import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

export interface AppleCredentials {
  firstName: string;
  lastName: string;
  country: string;
  birthday: string;
  phoneCode: string;
  phone: string;
  email: string;
  password: string;
}

export type AppleAccountState = "pending" | "created" | "accepted" | "declined";
type AccountRow = {
  id: string;
  state: AppleAccountState;
  createdAt: number;
  sealed: Uint8Array;
};

export function createAppleAccountStore(db: DatabaseSync, keyFile?: string) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS apple_accounts (
      profile_id TEXT NOT NULL REFERENCES profile_owners(profile_id) ON DELETE CASCADE,
      id TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, sealed BLOB NOT NULL,
      PRIMARY KEY (profile_id, id)
    );
  `);
  let key: Promise<Buffer> | undefined;
  const encryptionKey = () =>
    (key ??= (async () => {
      if (!keyFile) return randomBytes(32);
      try {
        return await readFile(keyFile);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
        const generated = randomBytes(32);
        try {
          await writeFile(keyFile, generated, { flag: "wx", mode: 0o600 });
          return generated;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          return readFile(keyFile);
        }
      }
    })());
  const aad = (owner: string, profile: string, id: string) =>
    Buffer.from(JSON.stringify([owner, profile, id]));
  const select = `
    SELECT a.id, a.state, a.created_at AS createdAt, a.sealed
    FROM apple_accounts a JOIN profile_owners p USING(profile_id)
    WHERE p.user_id = ? AND a.profile_id = ?
  `;
  const list = db.prepare(`${select} ORDER BY a.created_at DESC, a.id`);
  const get = db.prepare(`${select} AND a.id = ?`);
  const save = db.prepare(`
    INSERT INTO apple_accounts(profile_id, id, state, created_at, sealed)
    SELECT profile_id, ?, 'pending', ?, ? FROM profile_owners WHERE user_id = ? AND profile_id = ?
    ON CONFLICT(profile_id, id) DO UPDATE SET sealed = excluded.sealed WHERE apple_accounts.state = 'pending'
  `);
  const transition = db.prepare(`
    UPDATE apple_accounts SET state = ?
    WHERE profile_id = ? AND id = ? AND state IN ('pending', 'created') AND state <> ?
      AND EXISTS (SELECT 1 FROM profile_owners WHERE user_id = ? AND profile_id = ?)
  `);
  const decrypt = (row: AccountRow, secret: Buffer, owner: string, profile: string) => {
    const packed = Buffer.from(row.sealed);
    const decipher = createDecipheriv("aes-256-gcm", secret, packed.subarray(0, 12));
    decipher.setAAD(aad(owner, profile, row.id));
    decipher.setAuthTag(packed.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString(),
    ) as AppleCredentials;
  };
  return {
    async save(owner: string, profile: string, id: string, credentials: AppleCredentials) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", await encryptionKey(), nonce);
      cipher.setAAD(aad(owner, profile, id));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials)), cipher.final()]);
      save.run(
        id,
        Date.now(),
        Buffer.concat([nonce, cipher.getAuthTag(), encrypted]),
        owner,
        profile,
      );
    },
    setState(owner: string, profile: string, id: string, state: AppleAccountState) {
      transition.run(state, profile, id, state, owner, profile);
    },
    async list(owner: string, profile: string) {
      const rows = list.all(owner, profile) as unknown as AccountRow[];
      if (!rows.length) return [];
      const secret = await encryptionKey();
      return rows.map((row) => {
        const { firstName, lastName, email } = decrypt(row, secret, owner, profile);
        return {
          id: row.id,
          state: row.state,
          createdAt: row.createdAt,
          firstName,
          lastName,
          email,
        };
      });
    },
    async get(owner: string, profile: string, id: string) {
      const row = get.get(owner, profile, id) as unknown as AccountRow | undefined;
      if (row) return decrypt(row, await encryptionKey(), owner, profile);
    },
  };
}
export type AppleAccountStore = ReturnType<typeof createAppleAccountStore>;
