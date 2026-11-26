import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { createAssetCache } from "./cache";

const dirs: string[] = [];
const metadata = { statusCode: 200, headers: { "content-type": "text/plain" } };

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("asset disk cache", () => {
  it("uses sha256 content addressing and deduplicates identical bodies", async () => {
    const cache = createAssetCache(await tempDir(), 1024);
    const first = await cache.put("first", Readable.from(["same bytes"]), metadata);
    const second = await cache.put("second", Readable.from(["same ", "bytes"]), metadata);

    expect(first!.digest).toBe(createHash("sha256").update("same bytes").digest("hex"));
    expect(second!.digest).toBe(first!.digest);
    expect(second!.path).toBe(first!.path);
    expect(cache.stats()).toMatchObject({ blobs: 1, bytes: 10 });
    expect(await readFile(second!.path, "utf8")).toBe("same bytes");
  });

  it("evicts the least-recently-used blob while retaining a touched entry", async () => {
    const cache = createAssetCache(await tempDir(), 6);
    await cache.put("a", Readable.from(["aaa"]), metadata);
    await cache.put("b", Readable.from(["bbb"]), metadata);
    expect(await cache.get("a")).toBeDefined(); // a is now newer than b
    await cache.put("c", Readable.from(["ccc"]), metadata);

    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("a")).toBeDefined();
    expect(await cache.get("c")).toBeDefined();
    expect(cache.stats()).toMatchObject({ blobs: 2, bytes: 6 });
  });

  it("passes an oversized body through without keeping it or leaving a temporary file", async () => {
    const dir = await tempDir();
    const cache = createAssetCache(dir, 3);
    const tee = cache.tee("large", metadata);
    const passed = readStream(tee);
    tee.end("larger");

    expect(await passed).toBe("larger");
    expect(await cache.put("also-large", Readable.from(["larger"]), metadata)).toBeUndefined();
    expect(cache.stats()).toMatchObject({ blobs: 0, bytes: 0 });
    expect(await cache.get("large")).toBeUndefined();
    expect(await tempFiles(dir)).toEqual([]);
  });

  it("stops writing a body at the entry limit, before the rest reaches the disk", async () => {
    const dir = await tempDir();
    const cache = createAssetCache(dir, 1024, { maxEntryBytes: 4 });
    const tee = cache.tee("big", metadata);
    const passed = readStream(tee);
    tee.write("abc");
    await expect.poll(() => tempFiles(dir)).toHaveLength(1);
    tee.write("defgh");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await tempFiles(dir)).toEqual([]);
    tee.end("ij");
    expect(await passed).toBe("abcdefghij");
    expect(await cache.get("big")).toBeUndefined();
  });

  it("removes the temporary file when the reader goes away before the end", async () => {
    const dir = await tempDir();
    const cache = createAssetCache(dir, 1024);
    const upstream = new PassThrough();
    const tee = cache.tee("partial", metadata);
    upstream.pipe(tee);
    tee.resume();
    upstream.write("first part");
    await expect.poll(() => tempFiles(dir)).toHaveLength(1);
    tee.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await tempFiles(dir)).toEqual([]);
    expect(await cache.get("partial")).toBeUndefined();
  });

  it("discards a complete body whose session ended while it streamed", async () => {
    const dir = await tempDir();
    const cache = createAssetCache(dir, 1024);
    let current = true;
    const tee = cache.tee("ended", metadata, { commit: () => current });
    const passed = readStream(tee);
    tee.write("bytes");
    current = false;
    tee.end();
    expect(await passed).toBe("bytes");
    expect(await cache.get("ended")).toBeUndefined();
    expect(cache.stats()).toMatchObject({ blobs: 0, keys: 0 });
    expect(await tempFiles(dir)).toEqual([]);
  });

  it("forgets the least recently used keys past its key limit, and their unshared blobs", async () => {
    const cache = createAssetCache(await tempDir(), 1024, { maxKeys: 2 });
    await cache.put("a", Readable.from(["shared"]), metadata);
    await cache.put("b", Readable.from(["own"]), metadata);
    expect(await cache.get("a")).toBeDefined(); // b is now the oldest
    await cache.put("c", Readable.from(["shared"]), metadata);

    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("a")).toBeDefined();
    expect(await cache.get("c")).toBeDefined();
    expect(cache.stats()).toMatchObject({ keys: 2, blobs: 1, bytes: 6 });
  });
});

async function tempFiles(dir: string): Promise<string[]> {
  return readdir(join(dir, "tmp"));
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mirror-asset-cache-test-"));
  dirs.push(dir);
  return dir;
}

async function readStream(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
