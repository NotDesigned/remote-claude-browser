import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatDelta, textEdit, type ChatState } from "./delta";
import { ActionLedger } from "./ledger";

describe("chat text transport", () => {
  it("sends history metadata only when the list changes", () => {
    const before: ChatState = {
      tab: "tab",
      epoch: "doc",
      url: "https://claude.ai/new",
      title: "Claude",
      ready: true,
      generating: true,
      messages: [{ id: "a", role: "assistant", text: "one" }],
      conversations: [{ path: "/chat/a", title: "A" }],
    };
    const after = { ...before, messages: [{ ...before.messages[0]!, text: "one two" }] };
    expect(chatDelta(before, after)).not.toHaveProperty("conversations");
    const history = [{ path: "/chat/a", title: "Renamed" }];
    expect(chatDelta(after, { ...after, conversations: history })).toHaveProperty(
      "conversations",
      history,
    );
  });
  it("reconstructs append, correction, deletion and Chinese/surrogate text", () => {
    for (const [before, after] of [
      ["", "你好"],
      ["hello", "hello world"],
      ["abc123end", "abc456end"],
      ["delete me", ""],
      ["🙂中文🙂", "🙃中文🙂"],
    ]) {
      const edit = textEdit(before!, after!);
      expect(before!.slice(0, edit.at) + edit.insert + before!.slice(edit.at + edit.delete)).toBe(
        after,
      );
    }
  });
  it("streams a long answer without quadratic wire growth, and resets on navigation", () => {
    let before: ChatState = {
      tab: "tab",
      epoch: "doc",
      url: "https://claude.ai/chat/a",
      title: "Test",
      ready: true,
      generating: true,
      messages: [{ id: "a", role: "assistant", text: "" }],
      conversations: [],
    };
    let bytes = 0;
    for (let i = 1; i <= 200; i++) {
      const after: ChatState = {
        ...before,
        messages: [{ id: "a", role: "assistant", text: "x".repeat(i * 100) }],
      };
      bytes += Buffer.byteLength(JSON.stringify(chatDelta(before, after)));
      before = after;
    }
    expect(bytes).toBeLessThan(100000);
    expect(chatDelta(before, before)).toBeNull();
    const withFile = {
      ...before,
      messages: [{ ...before.messages[0]!, files: [{ id: "0", name: "报告.txt" }] }],
    };
    expect(chatDelta(before, withFile)?.edits).toEqual([
      { index: 0, message: withFile.messages[0] },
    ]);
    expect(chatDelta(before, { ...before, epoch: "next" })?.type).toBe("snapshot");
  });
});

describe("durable action receipts", () => {
  it("persists a pre-execution failure without executing a replay", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-not-started-"));
    try {
      const path = join(dir, "actions.jsonl");
      const ledger = new ActionLedger(path);
      let attempts = 0;
      const rejected = await ledger.run("not-started", { type: "send" }, async () => {
        attempts++;
        return "not-started";
      });
      expect(rejected.status).toBe("not-started");
      const restarted = new ActionLedger(path);
      await restarted.load();
      expect(
        (
          await restarted.run("not-started", { type: "send" }, async () => {
            attempts++;
            return true;
          })
        ).status,
      ).toBe("not-started");
      expect(attempts).toBe(1);
      expect((await restarted.run("new-attempt", { type: "send" }, async () => true)).status).toBe(
        "confirmed",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("executes concurrent retries once, survives restart, and stores no message text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-ledger-test-"));
    try {
      const path = join(dir, "actions.jsonl");
      const ledger = new ActionLedger(path);
      await ledger.load();
      let executions = 0;
      const execute = async () => {
        executions++;
        return true;
      };
      const results = await Promise.all([
        ledger.run("same", { text: "private message" }, execute),
        ledger.run("same", { text: "private message" }, execute),
      ]);
      expect(executions).toBe(1);
      expect(results[0]?.status).toBe("confirmed");
      const restarted = new ActionLedger(path);
      await restarted.load();
      await restarted.run("same", { text: "private message" }, execute);
      expect(executions).toBe(1);
      await expect(restarted.run("same", { text: "different" }, execute)).rejects.toThrow();
      expect(await readFile(path, "utf8")).not.toContain("private message");
      await writeFile(
        path,
        JSON.stringify({ id: "interrupted", digest: "digest", status: "pending", updatedAt: 1 }) +
          "\n",
      );
      const interrupted = new ActionLedger(path);
      await interrupted.load();
      expect(interrupted.get("interrupted")?.status).toBe("unknown");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
