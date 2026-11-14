import { describe, expect, it } from "vitest";

import { chromiumLaunchArgs } from "./launch";

describe("Chromium launch arguments", () => {
  it("merges caller features into one switch and leaves real Chrome features on", () => {
    const args = chromiumLaunchArgs(
      ["--disable-dev-shm-usage", "--disable-features=CallerFeature"],
      {
        headful: true,
        userDataDir: "/tmp/mirror-launch-test",
      },
    );
    expect(args.filter((arg) => arg.startsWith("--disable-features="))).toEqual([
      "--disable-features=BackForwardCache,CallerFeature",
    ]);
    expect(args).toContain("--disable-dev-shm-usage");
    expect(args).toContain("--user-data-dir=/tmp/mirror-launch-test");
    expect(args).toContain("--enable-unsafe-swiftshader");
    // Puppeteer's defaults disable MediaRouter, which detectors read as automation.
    expect(args.join(" ")).not.toMatch(/MediaRouter|enable-automation|AutomationControlled/);
  });
});
