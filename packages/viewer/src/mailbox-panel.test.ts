// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractMailLinks } from "./mailbox-panel";

describe("extractMailLinks", () => {
  it("extracts unique HTTP(S) links from html-to-text bracketed output and strips trailing punctuation", () => {
    const body = [
      "Sign in to Claude [https://claude.ai/magic-link?state=abc#token=xyz].",
      "Or paste https://claude.ai/magic-link?state=abc#token=xyz, or visit (https://anthropic.com/security)!",
      "Wiki link: https://en.wikipedia.org/wiki/Proxy_(networking)).",
      "Ignore mailto:user@example.com and javascript:alert(1).",
    ].join("\n");

    expect(extractMailLinks(body)).toEqual([
      "https://claude.ai/magic-link?state=abc#token=xyz",
      "https://anthropic.com/security",
      "https://en.wikipedia.org/wiki/Proxy_(networking)",
    ]);
  });
});
