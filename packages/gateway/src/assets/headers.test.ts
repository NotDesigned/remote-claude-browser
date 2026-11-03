import { describe, expect, it } from "vitest";
import { normalizeAssetHeaders } from "./headers";

describe("CDP response headers", () => {
  it("preserves repeated values without forwarding CDP's LF separator", () => {
    expect(normalizeAssetHeaders({ "X-Goog-Hash": "crc32c=abc\nmd5=def" })).toEqual({
      "x-goog-hash": ["crc32c=abc", "md5=def"],
    });
    expect(
      normalizeAssetHeaders([
        { name: "X-Goog-Hash", value: "crc32c=abc" },
        { name: "x-goog-hash", value: "md5=def" },
      ]),
    ).toEqual({ "x-goog-hash": ["crc32c=abc", "md5=def"] });
  });

  it("drops malformed names, CR/NUL and non-Latin-1 values without harming other fields", () => {
    expect(
      normalizeAssetHeaders({
        "bad name": "value",
        "x-null": "a\u0000b",
        "x-crlf": "a\r\nb",
        "x-unicode": "中文",
        "content-type": "image/png",
        "x-latin1": "café",
      }),
    ).toEqual({ "content-type": "image/png", "x-latin1": "café" });
  });
});
