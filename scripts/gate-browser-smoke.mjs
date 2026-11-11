// Real browser form submission; block workspace admission and stop the landing SPA immediately
// after its login response, then show a local fixture. Run via limited-run.sh, serially.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { readProbeCredentials } from "./probe-session.mjs";

if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");

if (!process.env.MIRROR_ORIGIN)
  throw new Error("Set MIRROR_ORIGIN to the service's public address");
const origin = new URL(process.env.MIRROR_ORIGIN).origin;
// The administrator this probe signs in as; an existing database keeps the name it was created with.
const administrator = process.env.MIRROR_ADMIN_USERNAME ?? "admin";
const logoutOrigin = process.env.MIRROR_PUBLIC_ORIGIN || origin;
const policies = new Set([
  "no-referrer",
  "no-referrer-when-downgrade",
  "origin",
  "origin-when-cross-origin",
  "same-origin",
  "strict-origin",
  "strict-origin-when-cross-origin",
  "unsafe-url",
]);
const report = {
  passed: false,
  gateStatus: null,
  responseReferrerPolicy: null,
  metaReferrerPolicy: null,
  formStatus: null,
  formIsNavigation: false,
  formOrigin: null,
  secFetchSite: null,
  secFetchMode: null,
  secFetchDest: null,
  sourceRejected: false,
  redirectDocumentIntercepted: false,
  localFixtureReady: false,
  workspaceAllocationGuardInstalled: false,
  authenticatedStatus: null,
  authenticatedAdministrator: false,
  workspaceRequestsBlocked: 0,
  pageErrors: 0,
  logoutStatus: null,
  deadlineExpired: false,
};
let browser, context, page, watchdog, failure;
const fixture =
  '<!doctype html><html><head><title>Form submission complete</title><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;"></head><body><main id="gate-form-success">Form submission complete</main></body></html>';

class SmokeFailure extends Error {}
function check(name, condition) {
  if (!condition) throw new SmokeFailure(name);
}
function policy(value) {
  if (!value) return null;
  const values = value.split(",").map((part) => part.trim().toLowerCase());
  return values.every((part) => policies.has(part)) ? values.join(", ") : "other";
}
function enumHeader(value, allowed) {
  if (value === undefined) return null;
  return allowed.includes(value) ? value : "other";
}
function originHeader(value) {
  if (value === undefined) return null;
  if (value === "null") return "null";
  try {
    // URL.origin cannot contain credentials, paths, queries, or fragments.
    return new URL(value).origin;
  } catch {
    return "other";
  }
}

try {
  const credentials = await readProbeCredentials();
  check("expectedAdministratorCredential", credentials.username === administrator);
  browser = await chromium.launch({
    executablePath: process.env.MIRROR_TEST_CHROME_PATH ?? "/opt/claude-test-chrome/chrome",
    headless: true,
    timeout: 20000,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--renderer-process-limit=1"],
  });
  context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  context.setDefaultTimeout(20000);
  context.setDefaultNavigationTimeout(25000);
  page = await context.newPage();
  page.on("pageerror", () => report.pageErrors++);
  watchdog = setTimeout(() => {
    report.deadlineExpired = true;
    // Leave the context alive so finally can still revoke its login with context.request.
    void page?.close({ runBeforeUnload: false }).catch(() => {});
  }, 75000);
  watchdog.unref?.();
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname === "/api/client/session") {
      report.workspaceRequestsBlocked++;
      return route.abort("blockedbyclient");
    }
    if (
      url.origin === origin &&
      url.pathname === "/" &&
      request.method() === "GET" &&
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame()
    ) {
      report.redirectDocumentIntercepted = true;
      return route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: { "cache-control": "no-store", "content-security-policy": "default-src 'none'" },
        body: fixture,
      });
    }
    return route.continue();
  });
  report.workspaceAllocationGuardInstalled = true;
  const gate = await page.goto(new URL("/gate", origin).href, { waitUntil: "load" });
  report.gateStatus = gate?.status() ?? null;
  report.responseReferrerPolicy = policy((await gate?.allHeaders())?.["referrer-policy"]);
  report.metaReferrerPolicy = policy(
    await page
      .locator('meta[name="referrer" i]')
      .evaluateAll((nodes) => nodes[0]?.getAttribute("content") ?? null),
  );
  check("gateDocumentLoaded", report.gateStatus === 200);
  const form = page.locator('form[method="post" i][action="/gate"]');
  await form.locator('input[name="username"]').fill(credentials.username);
  await form.locator('input[name="password"]').fill(credentials.password);
  const submitted = page.waitForResponse(
    (response) => {
      const request = response.request();
      const url = new URL(response.url());
      return (
        url.origin === origin &&
        url.pathname === "/gate" &&
        request.method() === "POST" &&
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      );
    },
    { timeout: 25000 },
  );
  // Do not inject headers, call form.submit(), or use request.post() here. The browser must
  // generate Origin and Fetch Metadata from the actual served page's referrer policy.
  const [response] = await Promise.all([
    submitted,
    form.locator('button[type="submit"]').click({ noWaitAfter: true }),
  ]);
  const request = response.request();
  const headers = await request.allHeaders();
  report.formStatus = response.status();
  report.formIsNavigation = request.isNavigationRequest();
  report.formOrigin = originHeader(headers.origin);
  report.secFetchSite = enumHeader(headers["sec-fetch-site"], [
    "same-origin",
    "same-site",
    "cross-site",
    "none",
  ]);
  report.secFetchMode = enumHeader(headers["sec-fetch-mode"], [
    "navigate",
    "same-origin",
    "cors",
    "no-cors",
    "websocket",
  ]);
  report.secFetchDest = enumHeader(headers["sec-fetch-dest"], ["document", "iframe", "empty"]);
  report.sourceRejected = response.status() === 403;
  check("formLoginRedirect", report.formStatus === 303 && report.formIsNavigation);
  check(
    "browserSentSameOrigin",
    report.formOrigin === origin &&
      (report.secFetchSite === null || report.secFetchSite === "same-origin"),
  );
  // Redirect-chain continuations may bypass Playwright routes. Cancel the actual landing
  // document rather than relying on interception; any admission requests before this point
  // were aborted above. Their count is evidence of prevention, not a test failure.
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  await page.setContent(fixture, { waitUntil: "domcontentloaded" });
  await page.locator("#gate-form-success").waitFor({ state: "visible" });
  report.localFixtureReady = true;
  const authenticated = await context.request.get(new URL("/api/me", origin).href, {
    timeout: 15000,
    maxRedirects: 0,
  });
  report.authenticatedStatus = authenticated.status();
  const identity = await authenticated.json().catch(() => null);
  report.authenticatedAdministrator =
    identity?.user?.username === administrator && identity?.user?.role === "admin";
  check(
    "formIssuedAuthenticatedLogin",
    report.authenticatedStatus === 200 && report.authenticatedAdministrator,
  );
  check("workspaceAllocationGuardInstalled", report.workspaceAllocationGuardInstalled);
} catch (error) {
  // Playwright error messages can include a rendered form or a request; only fixed codes escape.
  failure = error instanceof SmokeFailure ? error.message : "browserOrNetworkFailure";
} finally {
  if (watchdog) clearTimeout(watchdog);
  if (context) {
    try {
      const logout = await context.request.post(new URL("/logout", origin).href, {
        headers: { Origin: logoutOrigin },
        maxRedirects: 0,
        timeout: 15000,
      });
      report.logoutStatus = logout.status();
      if (report.logoutStatus !== 204) failure ??= "logoutFailed";
      await logout.dispose();
    } catch {
      failure ??= "logoutFailed";
    }
    await context.close().catch(() => {
      failure ??= "contextCloseFailed";
    });
  }
  await browser?.close().catch(() => {
    failure ??= "browserCloseFailed";
  });
  report.passed = failure === undefined && !report.deadlineExpired && report.logoutStatus === 204;
  await mkdir("artifacts", { recursive: true });
  const artifact = "artifacts/gate-browser-smoke.json";
  await writeFile(artifact, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  await chmod(artifact, 0o600);
  console.log(JSON.stringify(report));
  if (!report.passed) {
    console.error(`Gate browser form smoke failed: ${failure ?? "deadlineExpired"}`);
    process.exitCode = 1;
  }
}
