/**
 * SHA-256 content-addressed disk cache with byte-bounded LRU eviction.
 * A body is stored while it streams to its first reader (see `tee`): bytes go to a temporary
 * file as they pass, and only a complete body within the entry limit is kept. Duplicate bytes
 * share one blob.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_ASSET_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
/** Cache keys are sealed tokens, one per runtime and URL; the least recently used go past this. */
export const DEFAULT_ASSET_CACHE_KEYS = 50_000;

export interface CacheMetadata {
  statusCode: number;
  headers: Record<string, string | string[]>;
}

export interface CachedAsset extends CacheMetadata {
  digest: string;
  size: number;
  path: string;
  createReadStream(): ReadStream;
}

export interface AssetCacheStats {
  hits: number;
  misses: number;
  blobs: number;
  bytes: number;
  keys: number;
}

export interface AssetCacheOptions {
  /** The largest body stored; larger ones pass through without a copy. Default: the cache size. */
  maxEntryBytes?: number;
  /** How many keys are remembered before the least recently used are forgotten. */
  maxKeys?: number;
}

export interface TeeOptions {
  /** Asked once the body is complete; false discards the copy (its session has ended). */
  commit?: () => boolean;
}

export interface AssetCache {
  get(key: string): Promise<CachedAsset | undefined>;
  /**
   * A pass-through for a body, stored under `key` once it ends complete. Nothing is kept if it
   * fails, is destroyed (the reader went away), outgrows the entry limit or `commit` says no;
   * its temporary file is removed in each of those cases.
   */
  tee(key: string, metadata: CacheMetadata, options?: TeeOptions): Transform;
  /** Stores a whole body; undefined when it was not kept. */
  put(
    key: string,
    body: AsyncIterable<Uint8Array>,
    metadata: CacheMetadata,
  ): Promise<CachedAsset | undefined>;
  stats(): AssetCacheStats;
}

interface BlobEntry {
  digest: string;
  size: number;
  path: string;
  lastAccess: number;
  keys: Set<string>;
}

interface KeyEntry extends CacheMetadata {
  digest: string;
}

export function createAssetCache(
  dir: string,
  maxBytes = DEFAULT_ASSET_CACHE_BYTES,
  options: AssetCacheOptions = {},
): AssetCache {
  if (dir.trim() === "") throw new TypeError("Asset cache directory must not be empty");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("Asset cache maxBytes must be a positive safe integer");
  }
  const maxEntryBytes = Math.min(options.maxEntryBytes ?? maxBytes, maxBytes);
  const maxKeys = options.maxKeys ?? DEFAULT_ASSET_CACHE_KEYS;
  if (!(maxEntryBytes >= 0) || !Number.isSafeInteger(maxKeys) || maxKeys <= 0) {
    throw new TypeError("Asset cache limits must be positive");
  }

  const blobDir = join(dir, "sha256");
  const tempDir = join(dir, "tmp");
  const ready = Promise.all([
    mkdir(blobDir, { recursive: true }),
    mkdir(tempDir, { recursive: true }),
  ]);
  const blobs = new Map<string, BlobEntry>();
  /** Insertion order is recency: a hit or a store moves its key to the end. */
  const keys = new Map<string, KeyEntry>();
  let totalBytes = 0;
  let hits = 0;
  let misses = 0;
  let clock = 0;
  let mutation = Promise.resolve();

  const serialized = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = mutation;
    let release: (() => void) | undefined;
    mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  };

  const materialize = (keyEntry: KeyEntry, blob: BlobEntry): CachedAsset => ({
    statusCode: keyEntry.statusCode,
    headers: cloneHeaders(keyEntry.headers),
    digest: blob.digest,
    size: blob.size,
    path: blob.path,
    createReadStream: () => createReadStream(blob.path),
  });

  /** Moves a complete temporary file into the index under key. */
  const store = (
    key: string,
    tempPath: string,
    digest: string,
    size: number,
    metadata: CacheMetadata,
  ) =>
    serialized(async () => {
      let blob = blobs.get(digest);
      if (blob === undefined) {
        const path = join(blobDir, digest);
        try {
          await rename(tempPath, path);
        } catch (error) {
          await rm(tempPath, { force: true });
          throw error;
        }
        blob = { digest, size, path, lastAccess: ++clock, keys: new Set() };
        blobs.set(digest, blob);
        totalBytes += size;
      } else {
        await rm(tempPath, { force: true });
        blob.lastAccess = ++clock;
      }

      const previous = keys.get(key);
      if (previous !== undefined) {
        keys.delete(key);
        if (previous.digest !== digest) await unlinkKey(key, previous.digest);
      }
      keys.set(key, {
        digest,
        statusCode: metadata.statusCode,
        headers: cloneHeaders(metadata.headers),
      });
      blob.keys.add(key);
      while (keys.size > maxKeys) {
        const [oldest, entry] = keys.entries().next().value!;
        keys.delete(oldest);
        await unlinkKey(oldest, entry.digest);
      }
      await evict(blob.digest);
    });

  const cache: AssetCache = {
    async get(key) {
      await ready;
      return serialized(async () => {
        const keyEntry = keys.get(key);
        const blob = keyEntry === undefined ? undefined : blobs.get(keyEntry.digest);
        if (keyEntry === undefined || blob === undefined) {
          misses += 1;
          return undefined;
        }
        try {
          await stat(blob.path);
        } catch {
          dropBlob(blob);
          misses += 1;
          return undefined;
        }
        hits += 1;
        blob.lastAccess = ++clock;
        keys.delete(key);
        keys.set(key, keyEntry);
        return materialize(keyEntry, blob);
      });
    },

    tee(key, metadata, teeOptions = {}) {
      const tempPath = join(tempDir, `${process.pid}-${randomBytes(12).toString("hex")}`);
      const hash = createHash("sha256");
      const wanted = () => !teeOptions.commit || teeOptions.commit();
      let output: WriteStream | undefined;
      let created = false;
      let size = 0;
      /** Nothing more is written: the copy was given up, or handed to the index. */
      let done = false;
      let removed: Promise<void> = Promise.resolve();
      const discard = (): Promise<void> => {
        if (done) return removed;
        done = true;
        output?.destroy();
        output = undefined;
        if (created) removed = rm(tempPath, { force: true }).catch(() => undefined);
        return removed;
      };
      const open = async (): Promise<WriteStream | undefined> => {
        if (output || done) return output;
        await ready;
        if (done) return undefined;
        created = true;
        output = createWriteStream(tempPath, { flags: "wx" });
        // A disk problem costs the copy, never the reader's response.
        output.on("error", () => void discard());
        return output;
      };
      const write = async (bytes: Buffer) => {
        if (done) return;
        size += bytes.length;
        // An oversized body passes through without the rest of it touching the disk.
        if (size > maxEntryBytes) return discard();
        hash.update(bytes);
        const stream = await open();
        if (!stream || stream.write(bytes)) return;
        await Promise.race([once(stream, "drain"), once(stream, "close")]);
      };
      const finish = async () => {
        if (done || !wanted()) return discard();
        const stream = await open();
        if (!stream) return;
        stream.end();
        await once(stream, "close");
        if (done || !wanted()) return discard();
        done = true;
        output = undefined;
        await store(key, tempPath, hash.digest("hex"), size, metadata);
      };
      return new Transform({
        transform(chunk: Buffer | string, _encoding, callback) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          write(bytes).then(
            () => callback(null, bytes),
            () => {
              void discard();
              callback(null, bytes);
            },
          );
        },
        flush(callback) {
          // The reader has every byte already; a failed store only means no cached copy.
          finish().then(
            () => callback(),
            () => {
              void rm(tempPath, { force: true }).catch(() => undefined);
              callback();
            },
          );
        },
        destroy(error, callback) {
          void discard().then(() => callback(error));
        },
      });
    },

    async put(key, body, metadata) {
      const source = body instanceof Readable ? body : Readable.from(body);
      await pipeline(
        source,
        cache.tee(key, metadata),
        new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
      );
      return serialized(async () => {
        const keyEntry = keys.get(key);
        const blob = keyEntry === undefined ? undefined : blobs.get(keyEntry.digest);
        return keyEntry && blob ? materialize(keyEntry, blob) : undefined;
      });
    },

    stats() {
      return { hits, misses, blobs: blobs.size, bytes: totalBytes, keys: keys.size };
    },
  };
  return cache;

  async function unlinkKey(key: string, digest: string): Promise<void> {
    const blob = blobs.get(digest);
    if (blob === undefined) return;
    blob.keys.delete(key);
    if (blob.keys.size === 0) await removeBlob(blob);
  }

  async function evict(protectedDigest: string): Promise<void> {
    while (totalBytes > maxBytes && blobs.size > 1) {
      const victim = [...blobs.values()]
        .filter((blob) => blob.digest !== protectedDigest)
        .sort((left, right) => left.lastAccess - right.lastAccess)[0];
      if (victim === undefined) return;
      await removeBlob(victim);
    }
  }

  async function removeBlob(blob: BlobEntry): Promise<void> {
    dropBlob(blob);
    await rm(blob.path, { force: true });
  }

  function dropBlob(blob: BlobEntry): void {
    if (!blobs.delete(blob.digest)) return;
    totalBytes -= blob.size;
    for (const key of blob.keys) keys.delete(key);
  }
}

function cloneHeaders(
  headers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? [...value] : value,
    ]),
  );
}
