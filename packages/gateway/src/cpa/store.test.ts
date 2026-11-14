import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { FrontendUser } from "../auth/users";
import { createCpaStore, type CpaStore } from "./store";

const admin: FrontendUser = {
  id: "admin",
  username: "admin",
  role: "admin",
  enabled: true,
  createdAt: 1,
};
const stores: CpaStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("legacy CPA key import", () => {
  it("migrates private and shared caller keys to named users without changing tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cpa-key-owner-migration-"));
    const file = join(dir, "cpa.sqlite");
    try {
      const before = await createCpaStore({ file });
      const owner = { ...admin, id: "member", username: "member", role: "user" as const };
      const privateInstance = before.create(owner);
      const sharedInstance = before.create(admin, "shared");
      const privateKey = before.issueKey(privateInstance.id, "Private client", owner.id);
      const sharedKey = before.issueKey(sharedInstance.id, "Existing shared client", admin.id);
      before.close();
      const oldDb = new DatabaseSync(file);
      oldDb.exec("ALTER TABLE cpa_api_keys DROP COLUMN user_id");
      oldDb.close();
      await expect(createCpaStore({ file })).rejects.toThrow("NOT NULL");
      const migrated = await createCpaStore({ file, legacySharedKeyOwnerId: admin.id });
      expect(migrated.resolveKey(privateKey.token)).toEqual({
        instance: privateInstance,
        userId: owner.id,
      });
      expect(migrated.resolveKey(sharedKey.token)).toEqual({
        instance: sharedInstance,
        userId: admin.id,
      });
      expect(migrated.listKeys(sharedInstance.id)).toEqual([
        expect.objectContaining({ id: sharedKey.id, userId: admin.id }),
      ]);
      migrated.close();
      const reopened = await createCpaStore({ file });
      expect(reopened.resolveKey(sharedKey.token)?.userId).toBe(admin.id);
      expect(() =>
        reopened.importKey(sharedInstance.id, "Unowned key", "old-shared-key-without-owner"),
      ).toThrow("指定用户");
      reopened.revokeUserKeys(admin.id);
      expect(reopened.resolveKey(sharedKey.token)).toBeUndefined();
      expect(reopened.resolveKey(privateKey.token)?.userId).toBe(owner.id);
      reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves an old-format key after restart while persisting only its hash and display prefix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cpa-key-import-"));
    const file = join(dir, "cpa.sqlite");
    const token = "sk-legacy-client-secret-that-remains-with-the-client";
    try {
      const store = await createCpaStore({ file, now: () => 42 });
      const target = store.create(admin);
      const imported = store.importKey(target.id, "  旧客户端  ", token);
      expect(imported).toMatchObject({
        instanceId: target.id,
        name: "旧客户端",
        prefix: token.slice(0, 12),
        createdAt: 42,
      });
      expect(imported).not.toHaveProperty("token");
      expect(store.get(target.id)).toEqual(target);
      store.close();

      const reopened = await createCpaStore({ file });
      try {
        expect(reopened.resolveKey(token)).toEqual({ instance: target, userId: admin.id });
        expect(reopened.listKeys(target.id)).toEqual([imported]);
      } finally {
        reopened.close();
      }

      const db = new DatabaseSync(file, { readOnly: true });
      try {
        expect(db.prepare("SELECT token_hash,prefix FROM cpa_api_keys").get()).toEqual({
          token_hash: createHash("sha256").update(token).digest("hex"),
          prefix: token.slice(0, 12),
        });
      } finally {
        db.close();
      }
      expect((await readFile(file)).includes(Buffer.from(token))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("repeats an import idempotently and refuses to move another instance's key", async () => {
    const store = await createCpaStore({ file: ":memory:" });
    stores.push(store);
    const target = store.create(admin);
    const shared = store.create(admin, "shared");
    const other = store.create({ ...admin, id: "sphere", username: "sphere", role: "user" });
    const token = "old-caller-key-with-no-rcpa-prefix-and-a-private-suffix";
    const imported = store.importKey(target.id, "迁移的调用密钥", token);

    expect(store.importKey(target.id, "重复迁移不会改名", token)).toEqual(imported);
    expect(store.listKeys(target.id)).toEqual([imported]);
    for (const destination of [shared, other]) {
      expect(() => store.importKey(destination.id, "错误目标", token)).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "CPA_KEY_CONFLICT" }),
      );
      expect(store.listKeys(destination.id)).toEqual([]);
    }
    expect(store.resolveKey(token)?.instance.id).toBe(target.id);

    store.revokeKey(target.id, imported.id);
    expect(store.resolveKey(token)).toBeUndefined();
  });
});
