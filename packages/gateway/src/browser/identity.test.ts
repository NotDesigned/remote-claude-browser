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

describe("browser account environment", () => {
  it("points Chromium at the account's fonts and turns off middle-click paste", async () => {
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { identityEnvironment } = await import("./identity");
    const dir = await mkdtemp(join(tmpdir(), "identity-"));
    const env = await identityEnvironment(dir, browserIdentity("secret", "p-a"));
    expect(env.FONTCONFIG_FILE).toBe(join(dir, "fonts.conf"));
    expect(await readFile(join(env.XDG_CONFIG_HOME!, "gtk-3.0", "settings.ini"), "utf8")).toContain(
      "gtk-enable-primary-paste=false",
    );
  });
});
