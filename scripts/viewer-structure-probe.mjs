// Passive viewer inspection: no remote input, viewport, mode, navigation, or resync commands.
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");
const watchdog = setTimeout(() => process.exit(124), 70000);
const origin = process.env.MIRROR_ORIGIN ?? "http://127.0.0.1:3010";
const password = (await readFile("/etc/claude-browser/agent.env", "utf8"))
  .split("\n")
  .find((line) => line.startsWith("MIRROR_ACCESS_PASSWORD="))
  .slice("MIRROR_ACCESS_PASSWORD=".length);
const browser = await chromium.launch({
  executablePath: "/opt/claude-test-chrome/chrome",
  headless: true,
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        if (JSON.parse(data).t === "ping") return send.call(this, data);
      } catch {}
    };
  });
  const auth = await context.request.post(origin + "/gate", {
    form: { password },
    maxRedirects: 0,
  });
  if (auth.status() !== 303) throw new Error("Gateway authentication failed");
  const page = await context.newPage();
  const failures = [];
  page.on("requestfailed", (r) =>
    failures.push({
      kind: r.resourceType(),
      origin: new URL(r.url()).origin,
      error: r.failure()?.errorText,
    }),
  );
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(12000);
  const report = await page.evaluate(() => {
    const f = document.querySelector("iframe");
    const doc = f?.contentDocument;
    if (!doc) return { iframe: false, canvas: !!document.querySelector("canvas") };
    const view = doc.defaultView;
    const style = (el) => {
      const s = view.getComputedStyle(el),
        r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        namespace: el.namespaceURI,
        attrs: Object.fromEntries(
          [...el.attributes]
            .filter((a) => ["class", "style", "data-testid", "aria-hidden"].includes(a.name))
            .map((a) => [a.name, a.value]),
        ),
        box: { x: r.x, y: r.y, w: r.width, h: r.height },
        css: Object.fromEntries(
          [
            "display",
            "visibility",
            "opacity",
            "font-family",
            "font-size",
            "font-weight",
            "color",
            "background-image",
            "mask-image",
            "content",
          ].map((k) => [k, s.getPropertyValue(k)]),
        ),
        iconCodepoints:
          el.matches('[aria-hidden="true"]') && el.childElementCount === 0
            ? [...el.textContent].slice(0, 4).map((c) => c.codePointAt(0))
            : undefined,
      };
    };
    const controls = [
      ...doc.querySelectorAll(
        'button[data-testid="chat-input-send"],button[data-testid="user-menu-button"],aside',
      ),
    ].map((el) => ({
      element: style(el),
      children: [...el.querySelectorAll('[aria-hidden="true"],svg')].slice(0, 25).map(style),
    }));
    const faces = [...doc.fonts].map((f) => ({
      family: f.family,
      status: f.status,
      weight: f.weight,
    }));
    const fontRules = [];
    const visit = (rules) => {
      for (const rule of rules || []) {
        if (rule.type === 5)
          fontRules.push({
            family: rule.style.fontFamily,
            sourceKind: rule.style.getPropertyValue("src").includes("/s/")
              ? "proxy"
              : rule.style.getPropertyValue("src").slice(0, 100),
          });
        if (rule.cssRules) visit(rule.cssRules);
      }
    };
    let inaccessibleStyles = 0;
    for (const sheet of doc.styleSheets) {
      try {
        visit(sheet.cssRules);
      } catch {
        inaccessibleStyles++;
      }
    }
    return {
      iframe: true,
      nodeCount: doc.querySelectorAll("*").length,
      svg: doc.querySelectorAll("svg").length,
      controls,
      faces,
      fontRules,
      inaccessibleStyles,
      fontsStatus: doc.fonts.status,
    };
  });
  report.failures = failures;
  report.layout = await page.evaluate(() =>
    [
      ...document.querySelectorAll("iframe,.replayer-wrapper,.replayer-mouse,.mirror-stage,canvas"),
    ].map((el) => ({
      tag: el.tagName,
      class: el.className,
      style: el.getAttribute("style"),
      box: (() => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })(),
    })),
  );
  await page.screenshot({ path: "artifacts/viewer-current.png" });
  await writeFile("artifacts/viewer-structure.json", JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify(
      {
        iframe: report.iframe,
        nodeCount: report.nodeCount,
        icons: report.faces?.filter((f) => f.family.includes("icons")),
        failures,
        layout: report.layout,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  clearTimeout(watchdog);
}
