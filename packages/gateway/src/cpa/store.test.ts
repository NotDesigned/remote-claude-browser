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
        expect(reopened.resolveKey(token)).toEqual(target);
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
    expect(store.resolveKey(token)?.id).toBe(target.id);

    store.revokeKey(target.id, imported.id);
    expect(store.resolveKey(token)).toBeUndefined();
  });
});
