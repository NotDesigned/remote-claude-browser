import type { BrowserEngine, BrowserIdentity } from "./identity";

export const ALIASMODE_PATH = "/usr/local/lib/aliasmode/chrome";

export function configuredBrowserEngine(value: string | undefined): BrowserEngine {
  if (!value || value === "chromium") return "chromium";
  if (value === "aliasmode") return value;
  throw new Error("MIRROR_BROWSER_ENGINE must be chromium or aliasmode");
}

/** A profile keeps its engine and seed even when the deployment's new-profile default changes. */
export function profileBrowserOptions(identity: BrowserIdentity) {
  const fingerprint = identity.fingerprint;
  if (!fingerprint)
    return { engine: "chromium" as const, executablePath: process.env.CHROME_PATH, args: [] };
  return {
    engine: fingerprint.engine,
    executablePath: ALIASMODE_PATH,
    args: [
      `--fingerprint=${fingerprint.seed}`,
      `--fingerprint-platform=${fingerprint.platform}`,
      `--fingerprint-screen-width=${identity.screen.width}`,
      `--fingerprint-screen-height=${identity.screen.height}`,
    ],
  };
}
