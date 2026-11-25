import { describe, expect, it } from "vitest";

import { browserEnvironment, chromiumLaunchArgs } from "./launch";

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
    expect(args.join(" ")).not.toMatch(/MediaRouter|enable-automation/);
    expect(args).toContain("--disable-blink-features=AutomationControlled");
  });
});

describe("local Chromium environment", () => {
  it("passes only the runtime variables Chromium needs, plus explicit additions", () => {
    const env = browserEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/home/mirror",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        XDG_RUNTIME_DIR: "/run/user/1",
        DISPLAY: ":1",
        MIRROR_AUTH_SECRET: "secret",
        MIRROR_OIDC_CLIENT_SECRET: "oidc",
        MIRROR_ACCESS_PASSWORD: "password",
        RESEND_API_KEY: "re_123",
        RESEND_WEBHOOK_SECRET: "whsec",
        AWS_SECRET_ACCESS_KEY: "aws",
        NODE_OPTIONS: "--require /tmp/x.js",
      },
      { TZ: "Asia/Tokyo", XDG_CONFIG_HOME: "/data/xdg", DISPLAY: ":7" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/mirror",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1",
      DISPLAY: ":7",
      TZ: "Asia/Tokyo",
      XDG_CONFIG_HOME: "/data/xdg",
    });
  });
});
