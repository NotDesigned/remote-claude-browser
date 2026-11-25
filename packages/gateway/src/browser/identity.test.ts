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
    // AliasMode personas' Windows/macOS fonts stay invisible to native accounts.
    expect(conf).toContain("<glob>/usr/local/share/fonts/fingerprint/*</glob>");
    for (const family of identity.missingFonts)
      expect(conf).toContain(`<string>${family}</string>`);
  });
});

describe("browser account environment", () => {
  it.each(["chromium", "aliasmode"] as const)("configures fonts and GTK for %s", async (engine) => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { identityEnvironment } = await import("./identity");
    const dir = await mkdtemp(join(tmpdir(), "identity-"));
    try {
      const identity = browserIdentity("secret", "p-a");
      if (engine === "aliasmode")
        identity.fingerprint = { engine, seed: "fixed-seed", platform: "linux" };
      const env = await identityEnvironment(dir, identity);
      if (engine === "chromium") {
        expect(env.FONTCONFIG_FILE).toBe(join(dir, "fonts.conf"));
        expect(await readFile(env.FONTCONFIG_FILE!, "utf8")).toBe(fontconfigFor(identity));
      } else {
        expect(env.FONTCONFIG_FILE).toBeUndefined();
        await expect(readFile(join(dir, "fonts.conf"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      for (const gtk of ["gtk-3.0", "gtk-4.0"])
        expect(await readFile(join(env.XDG_CONFIG_HOME!, gtk, "settings.ini"), "utf8")).toContain(
          "gtk-enable-primary-paste=false",
        );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
