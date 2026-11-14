/**
 * Configures screen and touch for sessions opened from a phone.
 *
 * Phone sessions use touch and viewport emulation, retaining the browser's native identity.
 * A page-only Android identity disagrees with HTTP headers, workers, and the renderer.
 * Shared profiles must keep one browser identity across desktop and phone viewers.
 */
import type { CdpSend, TargetRef } from "../types";
import { screenMetrics } from "./screen-metrics";

const OWNER_WAIT_MS = 500;
const OWNER_POLL_MS = 10;

/** Tablets stay on the desktop interface, as their browsers leave this word out on purpose. */
export function isPhoneRequest(userAgent: string | undefined): boolean {
  return /\bMobi/.test(userAgent ?? "");
}

export interface PhoneIdentityDeps {
  send: CdpSend;
  ownerOf(targetId: string): string | undefined;
  isPhoneSession(sid: string): boolean;
  sleep?(ms: number): Promise<void>;
  onError?(error: unknown): void;
}

/** A new window attaches before its createTarget is acknowledged, which is what names its owner. */
export async function waitForOwner(
  target: TargetRef,
  deps: Pick<PhoneIdentityDeps, "ownerOf" | "sleep">,
): Promise<string | undefined> {
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let owner = deps.ownerOf(target.targetId);
  for (let waited = 0; owner === undefined && waited < OWNER_WAIT_MS; waited += OWNER_POLL_MS) {
    await sleep(OWNER_POLL_MS);
    owner = deps.ownerOf(target.targetId);
  }
  return owner;
}

/** For a target still paused, so that its first document already sees the identity. */
export function createPhoneTargetPreparer(deps: PhoneIdentityDeps) {
  return async (target: TargetRef): Promise<void> => {
    const owner = await waitForOwner(target, deps);
    if (owner === undefined || target.type !== "page") return;
    const commands = [
      deps.send(target.sessionId, "Emulation.setDeviceMetricsOverride", {
        width: 0,
        height: 0,
        deviceScaleFactor: 0,
        mobile: false,
        ...screenMetrics(0, 0, false),
      }),
    ];
    if (deps.isPhoneSession(owner))
      commands.push(
        deps.send(target.sessionId, "Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 5,
        }),
      );
    void Promise.all(commands).catch((error: unknown) => deps.onError?.(error));
  };
}
