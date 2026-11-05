/**
 * Gets Claude's phone interface for a session opened from a phone.
 *
 * Claude decides this in the page's own scripts, from the user agent they read. Only that changes:
 * requests keep the browser's real user agent, because Cloudflare ties its clearance to it and every
 * session shares that clearance.
 */
import type { CdpSend, TargetRef } from "../types";

const OWNER_WAIT_MS = 500;
const OWNER_POLL_MS = 10;

/** Tablets stay on the desktop interface, as their browsers leave this word out on purpose. */
export function isPhoneRequest(userAgent: string | undefined): boolean {
  return /\bMobi/.test(userAgent ?? "");
}

/** Keeps the browser's real version, which is what a phone running it would report. */
export const PHONE_IDENTITY_SOURCE = `(() => {
  const major = /Chrome\\/(\\d+)/.exec(navigator.userAgent)?.[1] ?? "0";
  const userAgent = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + major + ".0.0.0 Mobile Safari/537.36";
  const brands = [
    { brand: "Chromium", version: major },
    { brand: "Google Chrome", version: major },
    { brand: "Not_A Brand", version: "24" },
  ];
  const userAgentData = {
    brands,
    mobile: true,
    platform: "Android",
    getHighEntropyValues: async () => ({
      brands,
      mobile: true,
      platform: "Android",
      platformVersion: "14.0.0",
      model: "Pixel 8",
      architecture: "",
    }),
    toJSON: () => ({ brands, mobile: true, platform: "Android" }),
  };
  for (const [name, value] of [
    ["userAgent", userAgent],
    ["appVersion", userAgent.slice(8)],
    ["platform", "Linux armv8l"],
    ["userAgentData", userAgentData],
  ])
    Object.defineProperty(Navigator.prototype, name, { configurable: true, get: () => value });
})()`;

export interface PhoneIdentityDeps {
  send: CdpSend;
  ownerOf(targetId: string): string | undefined;
  isPhoneSession(sid: string): boolean;
  sleep?(ms: number): Promise<void>;
}

/** For a target still paused, so that its first document already sees the identity. */
export function createPhoneTargetPreparer(deps: PhoneIdentityDeps) {
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return async (target: TargetRef): Promise<void> => {
    // A new window attaches before its createTarget is acknowledged, which is what names its owner.
    let owner = deps.ownerOf(target.targetId);
    for (let waited = 0; owner === undefined && waited < OWNER_WAIT_MS; waited += OWNER_POLL_MS) {
      await sleep(OWNER_POLL_MS);
      owner = deps.ownerOf(target.targetId);
    }
    if (owner === undefined || !deps.isPhoneSession(owner)) return;
    await deps.send(target.sessionId, "Page.addScriptToEvaluateOnNewDocument", {
      source: PHONE_IDENTITY_SOURCE,
      runImmediately: true,
    });
    if (target.type === "page")
      await deps.send(target.sessionId, "Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 5,
      });
  };
}
