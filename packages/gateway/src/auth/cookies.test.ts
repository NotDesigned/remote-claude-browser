import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { readCookie } from "./cookies";

const request = (cookie?: string) => ({ headers: { cookie } }) as IncomingMessage;

describe("readCookie", () => {
  it("reads the first cookie of that name, trimmed, from a header or a request", () => {
    const header = " other=1; name = first ; name=second";
    expect(readCookie(header, "name")).toBe("first");
    expect(readCookie(request(header), "name")).toBe("first");
    expect(readCookie(request(header), "other")).toBe("1");
  });

  it("keeps an empty value apart from a missing cookie", () => {
    expect(readCookie("name=; x=1", "name")).toBe("");
    expect(readCookie("x=1; broken", "name")).toBeUndefined();
    expect(readCookie(request(), "name")).toBeUndefined();
    expect(readCookie(undefined, "name")).toBeUndefined();
  });

  it("keeps everything after the first equals sign", () => {
    expect(readCookie("token=a=b=c", "token")).toBe("a=b=c");
  });
});
