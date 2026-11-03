// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createClipboardWriter } from "./clipboard";

describe("automatic local clipboard bridge", () => {
  it("writes remote copies immediately and preserves copy order", async () => {
    let release!: () => void;
    const writes: string[] = [];
    const writeText = vi.fn(async (text: string) => {
      writes.push(text);
      if (text === "first")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    });
    const copied = vi.fn();
    const writer = createClipboardWriter({ writeText, onCopied: copied });
    writer.write("first");
    writer.write("第二次复制");
    await vi.waitFor(() => expect(writes).toEqual(["first"]));
    release();
    await vi.waitFor(() => expect(writes).toEqual(["first", "第二次复制"]));
    expect(copied).toHaveBeenCalledTimes(2);
  });

  it("continues after a permission failure and stops queued writes after disposal", async () => {
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const writer = createClipboardWriter({ writeText, onError });
    writer.write("one");
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    writer.write("two");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    writer.dispose();
    writer.write("old workspace");
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledTimes(2);
  });
});
