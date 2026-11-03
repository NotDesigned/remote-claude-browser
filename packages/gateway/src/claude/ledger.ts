import { createHash } from "node:crypto";
import { readFile, open } from "node:fs/promises";

export interface ActionResult {
  id: string;
  digest: string;
  status: "pending" | "confirmed" | "unknown" | "not-started";
  updatedAt: number;
}

/** Only IDs, digests and receipts reach disk. Never conversation text. */
export class ActionLedger {
  private readonly records = new Map<string, ActionResult>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      try {
        const record = JSON.parse(line) as ActionResult;
        this.records.set(record.id, {
          ...record,
          status: record.status === "pending" ? "unknown" : record.status,
        });
      } catch {
        if (i !== lines.length - 1) throw new Error("Action ledger is corrupt");
      }
    }
  }

  get(id: string): ActionResult | undefined {
    return this.records.get(id);
  }

  run(
    id: string,
    payload: unknown,
    execute: () => Promise<boolean | "not-started">,
  ): Promise<ActionResult> {
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const task = this.queue.then(async () => {
      const previous = this.records.get(id);
      if (previous) {
        if (previous.digest !== digest) throw new Error("actionId 已被其他操作使用");
        return previous;
      }
      const pending: ActionResult = { id, digest, status: "pending", updatedAt: Date.now() };
      await this.save(pending);
      let outcome: boolean | "not-started" = false;
      try {
        outcome = await execute();
      } catch {
        /* An interrupted side effect is never retried. */
      }
      const result: ActionResult = {
        ...pending,
        status: outcome === "not-started" ? "not-started" : outcome ? "confirmed" : "unknown",
        updatedAt: Date.now(),
      };
      await this.save(result);
      return result;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async save(record: ActionResult): Promise<void> {
    const file = await open(this.path, "a", 0o600);
    try {
      await file.writeFile(JSON.stringify(record) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    this.records.set(record.id, record);
  }
}
