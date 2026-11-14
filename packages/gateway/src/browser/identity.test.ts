import { describe, expect, it } from "vitest";

import { browserIdentity, fontconfigFor } from "./identity";

describe("browser account identity", () => {
  it("is stable for an account and differs between accounts", () => {
    expect(browserIdentity("secret", "p-a")).toEqual(browserIdentity("secret", "p-a"));
    const many = new Set(
      Array.from({ length: 20 }, (_, i) => JSON.stringify(browserIdentity("secret", `p-${i}`))),
    );
    expect(many.size).toBe(20);
  });
  it("writes a fontconfig that keeps the system fonts and rejects the missing ones", () => {
    const identity = browserIdentity("secret", "p-a");
    const conf = fontconfigFor(identity);
    expect(conf).toContain("/etc/fonts/fonts.conf");
    for (const family of identity.missingFonts)
      expect(conf).toContain(`<string>${family}</string>`);
  });
});
