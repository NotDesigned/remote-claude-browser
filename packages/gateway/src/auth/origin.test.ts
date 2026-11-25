import { describe, expect, it } from "vitest";
import { isOwnOrigin } from "./origin";

describe("own-origin check", () => {
  it("matches the configured public origin exactly", () => {
    const configured = "https://browser.example.com/";
    expect(isOwnOrigin("https://browser.example.com", "anything", configured)).toBe(true);
    expect(isOwnOrigin("https://attacker.example", "browser.example.com", configured)).toBe(false);
    expect(isOwnOrigin("http://browser.example.com", "browser.example.com", configured)).toBe(
      false,
    );
    expect(isOwnOrigin(undefined, "browser.example.com", configured)).toBe(false);
  });

  it("falls back to the request's own Host when no public origin is configured", () => {
    expect(isOwnOrigin("http://127.0.0.1:3010", "127.0.0.1:3010", undefined)).toBe(true);
    expect(isOwnOrigin("https://browser.example.com", "browser.example.com:443", "")).toBe(true);
    expect(isOwnOrigin("https://attacker.example", "127.0.0.1:3010", undefined)).toBe(false);
    expect(isOwnOrigin("http://127.0.0.1:3011", "127.0.0.1:3010", undefined)).toBe(false);
    expect(isOwnOrigin("null", "127.0.0.1:3010", undefined)).toBe(false);
    expect(isOwnOrigin("http://127.0.0.1:3010", undefined, undefined)).toBe(false);
    expect(isOwnOrigin(undefined, "127.0.0.1:3010", undefined)).toBe(false);
    expect(isOwnOrigin("chrome-extension://abc", "abc", undefined)).toBe(false);
  });
});
