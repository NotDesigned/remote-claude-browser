import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { VoiceTarget } from "../browser/account-pool";
import { createViewerHub, type ViewerHubDeps } from "./viewer-hub";

it("forgets which tabs use the microphone when they close or their session stops", async () => {
  const server = createServer();
  const hub = createViewerHub({
    server,
    e2e: true,
    publicOrigin: undefined,
    access: {} as ViewerHubDeps["access"],
    upgradeSignedIn: () => false,
    registry: {
      get: () => undefined,
      ensure: async () => {
        throw new Error("no runtime");
      },
      isClosing: () => false,
      sids: () => [][Symbol.iterator](),
    },
    sessions: { get: () => undefined },
    pixelCapacity: {} as ViewerHubDeps["pixelCapacity"],
    status: () => ({}) as ReturnType<ViewerHubDeps["status"]>,
    touch: () => undefined,
    build: () => undefined,
    isStopping: () => false,
    report: () => undefined,
  });
  const account = { browser: {}, sessionTargets: new Map() } as unknown as VoiceTarget;
  try {
    hub.onVoice("s1", "tab-a", { mic: true }, account);
    hub.onVoice("s1", "tab-b", { mic: true }, account);
    hub.onVoice("s2", "tab-c", { mic: true }, account);
    expect(hub.micTabCount).toBe(3);
    hub.forgetTab("s1", "tab-a");
    expect(hub.micTabCount).toBe(2);
    hub.disconnectSession("s1", false);
    expect(hub.micTabCount).toBe(1);
    hub.onVoice("s2", "tab-c", { mic: false }, account);
    expect(hub.micTabCount).toBe(0);
  } finally {
    await hub.close?.();
  }
});
