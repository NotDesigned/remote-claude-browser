// Destructive crash exercise on an isolated local fixture only, never the authenticated browser.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { launchBrowser } from "../packages/gateway/src/browser/launch";
import { createAgentLink } from "../packages/gateway/src/browser/agentlink";
import { createTabLifecycle } from "../packages/gateway/src/session/tabs";
import { createRendererRecovery } from "../packages/gateway/src/browser/recovery";
import { createScreencast } from "../packages/gateway/src/px";
import type { Down } from "../packages/protocol/src/index";

if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");
const watchdog = setTimeout(() => process.exit(124), 120000);
const profile = await mkdtemp(join(tmpdir(), "renderer-recovery-fixture-"));
const browser = await launchBrowser({
  executablePath: "/opt/claude-test-chrome/chrome",
  userDataDir: profile,
  headful: false,
  args: ["--disable-dev-shm-usage", "--enable-logging=stderr"],
});
let tabs: ReturnType<typeof createTabLifecycle> | undefined;
let recovery: ReturnType<typeof createRendererRecovery> | undefined;
let pixels: ReturnType<typeof createScreencast> | undefined;
try {
  const agent = createAgentLink(browser);
  browser.onBrowserEvent?.("Target.targetCrashed", (event) =>
    console.log("Fixture renderer crash event", event.status, event.errorCode),
  );
  const targets = new Map<string, { sessionId: string }>();
  browser.onAttached((target) => {
    if (target.type === "page") targets.set(target.targetId, target);
  });
  browser.onDetached((target) => targets.delete(target.targetId));
  const messages: Down[] = [];
  tabs = createTabLifecycle({
    browser,
    agentLink: agent,
    sessionId: "fixture",
    assetTokenKey: randomBytes(32),
    publish: (message) => messages.push(message),
    onSnapshot: (snapshot) => recovery?.noteSnapshot(snapshot.tab),
  });
  const waitFor = async (condition: () => boolean, label: string) => {
    const deadline = Date.now() + 30000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("Timed out: " + label);
      await new Promise((r) => setTimeout(r, 50));
    }
    console.log("Verified:", label);
  };
  await waitFor(
    () => !!tabs?.activeTabId && !!tabs.hubFor(tabs.activeTabId)?.snapshot,
    "initial recorder",
  );
  const tab = tabs.activeTabId!,
    session = targets.get(tab)!.sessionId;
  recovery = createRendererRecovery({
    browser,
    sessionFor: (id) => targets.get(id)?.sessionId,
    hubFor: (id) => tabs?.hubFor(id),
    publish: (message) => messages.push(message),
    onCrash(id) {
      assert.deepEqual(tabs!.hubFor(id)!.joinPayload(), [{ t: "resync", tab: id }]);
      pixels?.reset(id);
    },
    recoveryMs: 15000,
  });
  await browser.send(session, "Page.navigate", {
    url: "data:text/html,<title>Recovery fixture</title><p>Isolated recovery fixture</p>",
  });
  await waitFor(
    () => JSON.stringify(tabs!.hubFor(tab)!.snapshot).includes("Isolated recovery fixture"),
    "fixture navigation",
  );
  const oldDoc = tabs.hubFor(tab)!.docId;
  void browser.send(session, "Page.crash").catch(() => {});
  await waitFor(
    () => messages.some((message) => message.t === "tab-state" && message.state === "recovering"),
    "real renderer crash event",
  );
  await waitFor(
    () => messages.some((message) => message.t === "tab-state" && message.state === "ready"),
    "fresh document after automatic reload",
  );
  assert.notEqual(tabs.hubFor(tab)!.docId, oldDoc);
  assert.equal(recovery.isBlocked(tab), false);
  assert.match(JSON.stringify(tabs.hubFor(tab)!.snapshot), /Isolated recovery fixture/);
  await browser.send(targets.get(tab)!.sessionId, "Emulation.setDeviceMetricsOverride", {
    width: 2560,
    height: 1173,
    deviceScaleFactor: 1,
    mobile: false,
  });
  tabs.hubFor(tab)!.viewport = { w: 2560, h: 1173, dpr: 1 };
  pixels = createScreencast({
    browser,
    hubFor: (id) => tabs?.hubFor(id),
    publish: (message) => messages.push(message),
  });
  await pixels.handle({ t: "mode", tab, mode: "px" });
  await waitFor(
    () => messages.some((message) => message.t === "px" && jpegWidth(message.data) === 2560),
    "full 2560px pixel frame from recovered renderer",
  );
  await pixels.handle({ t: "mode", tab, mode: "dom" });
  const result = {
    ok: true,
    checks: [
      "real Target.targetCrashed observed",
      "dead document cache invalidated",
      "same tab automatically reloaded",
      "fresh recorder document received",
      "full 2560px pixel frame received after recovery",
      "returned to DOM",
    ],
    profile: "isolated temporary fixture",
  };
  await writeFile("artifacts/renderer-recovery-smoke.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error);
  throw error;
} finally {
  pixels?.dispose();
  recovery?.dispose();
  tabs?.dispose();
  await Promise.race([browser.close(), new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
  if (browser.isAlive?.()) await browser.kill?.();
  await rm(profile, { recursive: true, force: true });
  clearTimeout(watchdog);
}

function jpegWidth(base64: string): number {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.readUInt16BE(0) !== 0xffd8) return 0;
  for (let offset = 2; offset + 8 < bytes.length;) {
    if (bytes[offset++] !== 0xff) continue;
    const marker = bytes[offset++];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2)
      return bytes.readUInt16BE(offset + 5);
    if (marker === 0xd8 || marker === 0x01) continue;
    const length = bytes.readUInt16BE(offset);
    if (length < 2) return 0;
    offset += length;
  }
  return 0;
}
