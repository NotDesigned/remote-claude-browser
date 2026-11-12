import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { fetchXray, zipMember } from "./fetch-xray.mjs";

function archive(method = 8) {
  const name = Buffer.from("xray"),
    plain = Buffer.from("verified binary fixture");
  const compressed = method === 8 ? deflateRawSync(plain) : plain;
  const local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}
test("extracts only requested ZIP members in stored and deflated release archives", () => {
  for (const method of [0, 8])
    assert.equal(zipMember(archive(method), "xray").toString(), "verified binary fixture");
  assert.throws(() => zipMember(archive(), "LICENSE"), /not in the Xray archive/);
});
test("rejects malformed archives and unknown architectures before using a binary", async () => {
  assert.throws(() => zipMember(Buffer.alloc(22), "xray"), /invalid/);
  assert.throws(() => zipMember(archive(99), "xray"), /unsupported/);
  await assert.rejects(() => fetchXray("mips", "/unused"), /supported/);
});
test("a corrupt download is never extracted or cached", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response("corrupt release");
  try {
    await assert.rejects(() => fetchXray("amd64", "/unused"), /does not match its known digest/);
  } finally {
    globalThis.fetch = previous;
  }
});
