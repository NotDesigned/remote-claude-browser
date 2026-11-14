/** Browser contract test: viewer audio stays isolated without invented Web API objects. */
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(
  process.env.VOICE_TEST_REQUIRE_BASE ?? resolve(workspace, "packages/gateway/package.json"),
);
const puppeteer = await import(pathToFileURL(require.resolve("puppeteer-core")).href);
const fixtureSource = process.env.VOICE_FIXTURE_SOURCE
  ? await readFile(process.env.VOICE_FIXTURE_SOURCE, "utf8")
  : (
      await require("esbuild").build({
        entryPoints: [resolve(workspace, "packages/agent/src/voice.ts")],
        bundle: true,
        platform: "browser",
        format: "iife",
        globalName: "VoiceFixture",
        write: false,
      })
    ).outputFiles[0].text;
let executablePath;
for (const path of [
  process.env.CHROME_PATH,
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/opt/claude-test-chrome/chrome",
].filter(Boolean)) {
  try {
    await access(path);
    executablePath = path;
    break;
  } catch {}
}
assert(executablePath, "Set CHROME_PATH to run voice acceptance");
const browser = await puppeteer.launch({
  executablePath,
  pipe: true,
  headless: !process.env.DISPLAY,
  args: [
    "--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
  ],
});
try {
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const page = await browser.newPage();
    pages.push(page);
    await page.setRequestInterception(true);
    page.on(
      "request",
      (request) =>
        void request.respond({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><body>Voice fixture</body>",
        }),
    );
    await page.goto("https://voice-fixture.test/", { waitUntil: "load" });
    await page.evaluate((source) => {
      window.fixtureOriginals = {
        enumerate: navigator.mediaDevices.enumerateDevices,
        query: navigator.permissions.query,
      };
      window.fixtureAllow = false;
      window.fixtureEvents = [];
      // The fixture owns this page and bridge; production has no fixture globals.
      window.eval(
        source +
          `\nwindow.fixtureBridge=VoiceFixture.installVoiceBridge(window,message=>{
        window.fixtureEvents.push(message);
        if(message.mic)queueMicrotask(()=>window.fixtureBridge.receive({state:window.fixtureAllow}));
      });`,
      );
    }, fixtureSource);
    const result = await page.evaluate(async () => ({
      enumerationPreserved:
        navigator.mediaDevices.enumerateDevices === window.fixtureOriginals.enumerate,
      permissionsPreserved: navigator.permissions.query === window.fixtureOriginals.query,
      permissionBrand: Object.prototype.toString.call(
        await navigator.permissions.query({ name: "microphone" }),
      ),
      devices: (await navigator.mediaDevices.enumerateDevices()).map((d) => ({
        brand: Object.prototype.toString.call(d),
        groupId: d.groupId,
      })),
      denied: await navigator.mediaDevices.getUserMedia({ audio: true }).then(
        () => null,
        (error) => error.name,
      ),
    }));
    assert.equal(result.enumerationPreserved, true);
    assert.equal(result.permissionsPreserved, true);
    assert.equal(result.permissionBrand, "[object PermissionStatus]");
    assert.equal(result.denied, "NotAllowedError");
    assert(result.devices.every((d) => d.groupId !== "viewer" && d.brand !== "[object Object]"));
  }
  const granted = await pages[0].evaluate(async () => {
    window.fixtureAllow = true;
    window.fixtureStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return {
      stream: window.fixtureStream instanceof MediaStream,
      track: window.fixtureStream.getAudioTracks()[0] instanceof MediaStreamTrack,
      state: window.fixtureStream.getAudioTracks()[0].readyState,
    };
  });
  assert.deepEqual(granted, { stream: true, track: true, state: "live" });
  assert.equal(
    await pages[1].evaluate(() =>
      navigator.mediaDevices.getUserMedia({ audio: true }).then(
        () => null,
        (e) => e.name,
      ),
    ),
    "NotAllowedError",
  );
  assert.equal(
    await pages[0].evaluate(() => window.fixtureStream.getAudioTracks()[0].readyState),
    "live",
  );
  await pages[0].evaluate(() => window.fixtureStream.getTracks().forEach((track) => track.stop()));
  console.log(
    "Voice native interfaces, denied/granted capture, real tracks and two-page isolation passed",
  );
} finally {
  await browser.close();
}
