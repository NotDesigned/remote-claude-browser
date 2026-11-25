/**
 * Logs in to a running server and checks that a page is mirrored and that its script ran on the
 * server, not here. Needs SMOKE_ORIGIN, SMOKE_PASSWORD and CHROME_PATH.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const origin = process.env.SMOKE_ORIGIN;
const password = process.env.SMOKE_PASSWORD;
const username = process.env.SMOKE_USERNAME ?? process.env.MIRROR_ADMIN_USERNAME ?? "admin";
const fixtureOrigin = process.env.SMOKE_FIXTURE_ORIGIN;
assert.ok(
  origin && password && fixtureOrigin,
  "Set SMOKE_ORIGIN, SMOKE_PASSWORD and SMOKE_FIXTURE_ORIGIN",
);

const fixturePage = (html) => `${fixtureOrigin}/?html=${Buffer.from(html).toString("base64url")}`;

/** What the mirror shows of an element, and how far each of its frames is scrolled. */
const describeMirror = (page, id) =>
  page
    .evaluate((id) => {
      const frames = [];
      let found = "absent";
      const visit = (frame, path) => {
        const doc = frame.contentDocument;
        if (!doc) return frames.push(`${path}:no document`);
        frames.push(`${path}:${Math.round(doc.defaultView?.scrollY ?? -1)}`);
        const node = doc.getElementById(id);
        if (node) found = JSON.stringify(node.textContent);
        doc.querySelectorAll("iframe").forEach((child, index) => visit(child, `${path}.${index}`));
      };
      const root = document.querySelector("#mirror-host .mirror-stage:not([data-parked]) iframe");
      if (root) visit(root, "top");
      return `#${id} is ${found}; frames scrolled to ${frames.join(" ")}`;
    }, id)
    .catch((error) => `the mirror could not be read: ${error.message}`);

async function mirrorElement(page, id, { text, inset } = {}) {
  const waiting = page.waitForFunction(
    ({ id, text, inset }) => {
      const root = document.querySelector("#mirror-host .mirror-stage:not([data-parked]) iframe");
      const visit = (frame, x, y, sx, sy) => {
        const doc = frame.contentDocument;
        if (!doc) return null;
        const box = frame.getBoundingClientRect();
        const childX = sx * (box.width / frame.offsetWidth);
        const childY = sy * (box.height / frame.offsetHeight);
        const left = x + box.left * sx + frame.clientLeft * childX;
        const top = y + box.top * sy + frame.clientTop * childY;
        const node = doc.getElementById(id);
        if (node && (text === undefined || node.textContent === text)) {
          const rect = node.getBoundingClientRect();
          return {
            text: node.textContent,
            checked: node.checked,
            x: left + (rect.left + (inset ?? rect.width / 2)) * childX,
            y: top + (rect.top + rect.height / 2) * childY,
          };
        }
        for (const child of doc.querySelectorAll("iframe")) {
          const result = visit(child, left, top, childX, childY);
          if (result) return result;
        }
        return null;
      };
      return root ? visit(root, 0, 0, 1, 1) : null;
    },
    { id, text, inset },
    { timeout: 15_000 },
  );
  const match = await waiting.catch(async (error) => {
    const wanted = text === undefined ? "" : ` showing ${JSON.stringify(text)}`;
    throw new Error(`#${id}${wanted} not in the mirror: ${await describeMirror(page, id)}`, {
      cause: error,
    });
  });
  return match.jsonValue();
}

/**
 * Records a moment of picture and tone, and plays it from a blob as a site's player would: the mirror
 * then takes it over WebRTC, through the same capture of a media element that a real site's video gets.
 */
const VIDEO_PAGE = `<!doctype html><meta charset="utf-8"><title>Video check</title>
<video id="film" loop autoplay width="320" height="180"></video>
<script>
(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const paint = canvas.getContext("2d");
  let hue = 0;
  const painting = setInterval(() => {
    paint.fillStyle = "hsl(" + (hue = (hue + 9) % 360) + ",80%,50%)";
    paint.fillRect(0, 0, 320, 180);
  }, 40);
  const sound = new AudioContext();
  await sound.resume();
  const tone = sound.createOscillator();
  const out = sound.createMediaStreamDestination();
  tone.connect(out);
  tone.start();
  const tracks = [...canvas.captureStream(25).getTracks(), ...out.stream.getTracks()];
  const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: "video/webm;codecs=vp8,opus" });
  const parts = [];
  recorder.ondataavailable = (event) => parts.push(event.data);
  recorder.onstop = () => {
    clearInterval(painting);
    const film = document.getElementById("film");
    film.src = URL.createObjectURL(new Blob(parts, { type: "video/webm" }));
    film.play();
  };
  recorder.start();
  setTimeout(() => recorder.stop(), 4000);
})();
</script>`;

const FORM_PAGE = `<!doctype html><meta charset="utf-8"><title>表单检查</title>
<label><input id="box" type="checkbox" style="width:24px;height:24px"> 待办</label>
<button id="save" style="font-size:20px">保存</button><pre id="log"></pre>
<script>
const box = document.getElementById("box");
const seen = { click: 0, change: 0 };
const show = () => (document.getElementById("log").textContent = JSON.stringify({ ...seen, checked: box.checked }));
box.addEventListener("click", () => { seen.click++; show(); });
box.addEventListener("change", () => { seen.change++; show(); });
document.getElementById("save").addEventListener("click", () => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(["# 标题\\n- [x] 完成\\n"], { type: "text/markdown;charset=utf-8" }));
  link.download = "中文笔记.md";
  document.body.append(link);
  link.click();
});
show();
</script>`;

/**
 * Frames with their own recorders, which moveBefore moves without reloading, as Claude's documents do.
 * Two at once, since each move also has the frames above report again, which is where it went wrong.
 */
const movedChild = (
  tag,
) => `<!doctype html><meta charset="utf-8"><input type="checkbox" id="${tag}-box"><p id="${tag}-log">0</p><p id="${tag}-hover"></p><p id="${tag}-ticks">0</p><script>
let n = 0; const box = document.getElementById("${tag}-box");
box.addEventListener("change", () => { document.getElementById("${tag}-log").textContent = String(box.checked); });
box.addEventListener("mousemove", () => { document.getElementById("${tag}-hover").textContent = "hovered"; });
setInterval(() => { document.getElementById("${tag}-ticks").textContent = ++n; }, 500);
</script>`;
const movedParent = (
  tag,
) => `<!doctype html><meta charset="utf-8"><div id="first"><iframe id="frame" sandbox="allow-scripts" style="width:300px;height:140px"
 srcdoc="${movedChild(tag).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe></div><div id="second"></div><script>
setTimeout(() => document.getElementById("second").moveBefore(document.getElementById("frame"), null), 3000);
</script>`;
const MOVED_PAGE = `<!doctype html><meta charset="utf-8"><title>Moved frames</title>${["a", "b"]
  .map(
    (tag) => `<iframe style="width:360px;height:380px"
 src="data:text/html;charset=utf-8,${encodeURIComponent(movedParent(tag))}"></iframe>`,
  )
  .join("")}`;

async function checkMovedFrame(page, address) {
  await address.fill(fixturePage(MOVED_PAGE));
  await address.press("Enter");
  // The fixture moves its inner frames three seconds after loading.
  await page.waitForTimeout(8_000);
  await page.waitForFunction(
    () => document.getElementById("mirror-host").dataset.inputReady === "true",
  );
  for (const tag of ["a", "b"]) {
    const before = await mirrorElement(page, `${tag}-ticks`);
    await page.waitForTimeout(2_000);
    const after = await mirrorElement(page, `${tag}-ticks`);
    assert.ok(Number(after.text) > Number(before.text), `Moved frame ${tag} stopped updating`);
    const box = await mirrorElement(page, `${tag}-box`);
    await page.mouse.move(box.x, box.y);
    await mirrorElement(page, `${tag}-hover`, { text: "hovered" });
    await page.mouse.click(box.x, box.y);
    await mirrorElement(page, `${tag}-log`, { text: "true" });
    assert.equal((await mirrorElement(page, `${tag}-box`)).checked, true);
  }
  console.log("Frames moved without reloading stay in the mirror, live and usable.");
}

/** A long document in frames which may share a process with their parent, as Claude's documents do. */
const longDocument = (tag) => {
  let rows = "";
  for (let i = 0; i < 60; i++)
    rows += `<p id="${tag}-row${i}" style="height:40px;margin:0">row ${i}</p>`;
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}</style><div style="position:fixed;top:0;right:0"><span id="${tag}-state">0/none</span><span id="${tag}-hover"></span></div>${rows}<script>
const state = document.getElementById("${tag}-state");
const hover = document.getElementById("${tag}-hover");
let pressed = "none";
const show = () => { state.textContent = Math.round(scrollY) + "/" + pressed; };
addEventListener("scroll", show);
addEventListener("mousemove", (event) => { hover.textContent = event.target.id; });
addEventListener("mousedown", (event) => { pressed = event.target.id || event.target.tagName; show(); });
</script>`;
};
const quoted = (html) => html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const sandboxed = (html, style) =>
  `<iframe sandbox="allow-scripts" style="${style}" srcdoc="${quoted(html)}"></iframe>`;
// The frame sits in a same-origin document, filled by script, below the recorder of a cross-origin
// frame: Claude's documents have this between the artifact and its text.
const belowSameOrigin = (
  html,
) => `<!doctype html><meta charset="utf-8"><body style="margin:0"><iframe id="holder" style="width:320px;height:320px;border:0;display:block"></iframe><script>
const holder = document.getElementById("holder").contentDocument;
holder.body.style.margin = "0";
const inner = holder.createElement("iframe");
inner.setAttribute("sandbox", "allow-scripts");
inner.style.cssText = "width:300px;height:300px;display:block";
inner.srcdoc = ${JSON.stringify(html).replace(/</g, "\\u003c")};
holder.body.append(inner);
</script>`;
const NESTED_PAGE = `<!doctype html><meta charset="utf-8"><title>Nested</title><body style="margin:6px;display:flex;gap:6px">
<iframe style="width:330px;height:340px" src="data:text/html;charset=utf-8,${encodeURIComponent(belowSameOrigin(longDocument("deep")))}"></iframe>
${sandboxed(longDocument("single"), "width:330px;height:340px")}
<iframe style="width:330px;height:340px" src="data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><meta charset="utf-8"><body style="margin:0">${sandboxed(longDocument("indata"), "width:300px;height:300px;display:block")}`,
)}"></iframe>
${sandboxed(
  `<!doctype html><meta charset="utf-8"><body style="margin:0">${sandboxed(longDocument("insandbox"), "width:300px;height:300px;display:block")}`,
  "width:330px;height:340px",
)}`;

async function checkNestedFrames(page, address) {
  await address.fill(fixturePage(NESTED_PAGE));
  await address.press("Enter");
  for (const tag of ["deep", "single", "indata", "insandbox"]) {
    const near = await mirrorElement(page, `${tag}-row2`, { inset: 20 });
    await page.mouse.move(near.x, near.y);
    await mirrorElement(page, `${tag}-hover`, { text: `${tag}-row2` });
    await page.mouse.wheel(0, 800);
    await mirrorElement(page, `${tag}-state`, { text: "800/none" });
    const row = await mirrorElement(page, `${tag}-row24`, { inset: 20 });
    await page.mouse.move(row.x, row.y);
    await mirrorElement(page, `${tag}-hover`, { text: `${tag}-row24` });
    await page.mouse.click(row.x, row.y);
    await mirrorElement(page, `${tag}-state`, { text: `800/${tag}-row24` });
  }
  console.log("Scrolling and pressing reach the right place in nested frames.");
}

/** A session whose viewers are all hidden sleeps its pages, and wakes them when one shows again. */
async function checkPageSleep(page, address) {
  const target = `${fixturePage("<!doctype html><h1>Session restore</h1>")}#background-restore`;
  const sid = new URL(page.url()).searchParams.get("sid");
  const setHidden = (hidden) =>
    page.evaluate((hidden) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event("visibilitychange"));
      if (!hidden) delete document.hidden;
    }, hidden);
  await address.fill(target);
  await address.press("Enter");
  const restored = () =>
    page.waitForFunction(() => {
      const host = document.getElementById("mirror-host");
      const frame = host?.querySelector(".mirror-stage:not([data-parked]) iframe");
      return (
        host?.dataset.inputReady === "true" &&
        frame?.contentDocument?.querySelector("h1")?.textContent === "Session restore"
      );
    });
  await restored();
  await setHidden(true);
  const clientCount = async () =>
    (await (await page.request.get(origin + "/healthz")).json()).clients;
  const deadline = Date.now() + 80_000;
  while ((await clientCount()) !== 0 && Date.now() < deadline) await page.waitForTimeout(1_000);
  await page.waitForTimeout(1500);
  assert.equal(await clientCount(), 0, "The hidden session did not release its runtime");
  await setHidden(false);
  await page.waitForFunction(
    () => document.querySelector("[data-connection]")?.getAttribute("data-connection") === "open",
  );
  await restored();
  assert.equal(await address.inputValue(), target);
  assert.equal(new URL(page.url()).searchParams.get("sid"), sid);
  console.log("Background pages release their runtime and reconnect to the same URL and session.");
}

/** Accounts are separate Chromes: a cookie set in one is not there in another, and stays in its own. */
async function checkAccounts(page) {
  // From the page, as the viewer itself asks: its cookies are Secure, which only it sends to plain http.
  const call = (method, path, body) =>
    page.evaluate(
      async ({ method, path, body }) => {
        const response = await fetch(path, {
          method,
          credentials: "same-origin",
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
        return { status: response.status, json: await response.json().catch(() => null) };
      },
      { method, path, body },
    );
  const sid = new URL(page.url()).searchParams.get("sid");
  assert.ok(sid, "The page has no session");
  const ready = async () => {
    await page.waitForSelector("#shell-bar", { timeout: 60_000 });
    await page
      .locator('#urlbar button[aria-label="Reload"]:not([disabled])')
      .waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector("#urlbar input")?.value !== "");
  };
  const cookiesAfter = async (path) => {
    const address = page.locator("#urlbar input");
    await address.fill(`${fixtureOrigin}${path}`);
    await address.press("Enter");
    return page
      .frameLocator("#mirror-host .mirror-stage:not([data-parked]) iframe")
      .locator("#cookies")
      .innerText();
  };

  assert.match(await cookiesAfter("/cookies/set?mirror=first"), /"mirror":\s*"first"/);
  const { accounts, current } = (await call("GET", `/api/accounts?sid=${sid}`)).json;
  const proxyId = accounts.find((account) => account.id === current).proxyId;
  const made = (await call("POST", "/api/accounts", { name: "第二个", proxyId })).json;
  assert.ok(made?.id, "The account was not created");
  const switched = await call("POST", `/api/client/session/${sid}/account`, { account: made.id });
  assert.equal(switched.status, 200, "Switching the session failed");
  await page.reload();
  await ready();
  const listed = (await call("GET", `/api/accounts?sid=${sid}`)).json;
  assert.equal(listed.current, made.id, "The session is not on the new account");
  assert.equal(listed.accounts.find((account) => account.id === made.id)?.running, true);
  assert.doesNotMatch(
    await cookiesAfter("/cookies"),
    /mirror/,
    "The new account sees the other's cookie",
  );

  await call("POST", `/api/client/session/${sid}/account`, { account: "default" });
  await page.reload();
  await ready();
  assert.match(
    await cookiesAfter("/cookies"),
    /"mirror":\s*"first"/,
    "The first account lost its cookie",
  );
  const removed = await call("DELETE", `/api/accounts/${made.id}`);
  assert.equal(removed.status, 204, "Deleting the account failed");
  const after = (await call("GET", `/api/accounts?sid=${sid}`)).json;
  assert.ok(
    !after.accounts.some((account) => account.id === made.id),
    "The account is still listed",
  );
  console.log("Accounts keep their cookies apart.");
}

async function checkForm(page, address, mirrored) {
  await address.fill(fixturePage(FORM_PAGE));
  await address.press("Enter");
  await mirrored.locator("#box").waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
  );
  const log = async () => JSON.parse(await mirrored.locator("#log").innerText());

  // One press is one click and one change on the remote page, and the mirror shows the outcome.
  await mirrored.locator("#box").click({ force: true });
  await page.waitForTimeout(2_000);
  assert.deepEqual(
    await log(),
    { click: 1, change: 1, checked: true },
    "A press toggled more than once",
  );
  assert.equal(
    await mirrored.locator("#box").isChecked(),
    true,
    "The mirror did not show the check",
  );
  await mirrored.getByText("待办").click({ force: true });
  await page.waitForTimeout(2_000);
  assert.deepEqual(
    await log(),
    { click: 2, change: 2, checked: false },
    "A press on the label went wrong",
  );
  assert.equal(
    await mirrored.locator("#box").isChecked(),
    false,
    "The mirror did not show the uncheck",
  );
  console.log("A checkbox toggles once per press, and the mirror follows it.");

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    mirrored.locator("#save").click(),
  ]);
  assert.equal(download.suggestedFilename(), "中文笔记.md", "The download lost its name");
  const content = await readFile(await download.path(), "utf8");
  assert.equal(content, "# 标题\n- [x] 完成\n", "The download's content changed");
  console.log("A Markdown download keeps its Chinese name and its content.");
}

const CANVAS_CHILD = `<!doctype html><meta charset="utf-8"><body style="margin:0"><canvas id="painted" width="160" height="90"></canvas><script>
const paint = document.getElementById("painted").getContext("2d");
let red = true;
setInterval(() => { paint.fillStyle = red ? "rgb(255,0,0)" : "rgb(0,0,255)"; paint.fillRect(0, 0, 160, 90); red = !red; }, 700);
</script>`;
const CANVAS_PAGE = `<!doctype html><meta charset="utf-8"><title>Canvas</title><iframe style="width:200px;height:120px"
 src="data:text/html;charset=utf-8,${encodeURIComponent(CANVAS_CHILD)}"></iframe>`;

/** With MIRROR_CANVAS_SITES=*, a canvas in a cross-origin frame shows, and keeps changing. */
async function checkCanvas(page, address) {
  await address.fill(fixturePage(CANVAS_PAGE));
  await address.press("Enter");
  const colour = () =>
    page.evaluate(() => {
      const top = document.querySelector("#mirror-host .mirror-stage:not([data-parked]) iframe");
      const canvas = top?.contentDocument
        ?.querySelector("iframe")
        ?.contentDocument?.querySelector("canvas");
      if (!canvas) return "missing";
      const [r, g, b, a] = canvas.getContext("2d").getImageData(80, 45, 1, 1).data;
      return a === 0
        ? "blank"
        : r > 200 && b < 60
          ? "red"
          : b > 200 && r < 60
            ? "blue"
            : `other ${r},${g},${b},${a}`;
    });
  const seen = new Set();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !(seen.has("red") && seen.has("blue"))) {
    seen.add(await colour());
    await page.waitForTimeout(200);
  }
  assert.ok(
    seen.has("red") && seen.has("blue"),
    `The mirrored canvas showed: ${[...seen].join(", ")}`,
  );
  console.log("A canvas in a cross-origin frame shows in the page view, and keeps up.");
}

async function checkVideo(page, address) {
  await page.evaluate(() => {
    const Native = window.RTCPeerConnection;
    window.__peers = [];
    window.RTCPeerConnection = class extends Native {
      constructor(...args) {
        super(...args);
        window.__peers.push(this);
      }
    };
  });
  await address.fill(fixturePage(VIDEO_PAGE));
  await address.press("Enter");
  const read = () =>
    page.evaluate(async () => {
      const frame = document.querySelector("#mirror-host .mirror-stage:not([data-parked]) iframe");
      const video = frame?.contentDocument?.querySelector("video");
      const state = {
        tracks:
          video?.srcObject
            ?.getTracks?.()
            .map((track) => track.kind[0])
            .join("") ?? null,
        muted: video?.muted,
        width: video?.videoWidth,
        frames: 0,
        energy: 0,
      };
      for (const peer of window.__peers) {
        if (peer.connectionState === "closed") continue;
        state.connection = peer.connectionState;
        (await peer.getStats()).forEach((entry) => {
          if (entry.type !== "inbound-rtp") return;
          if (entry.kind === "video") state.frames = entry.framesDecoded;
          if (entry.kind === "audio") state.energy = entry.totalAudioEnergy ?? 0;
        });
      }
      return state;
    });
  const deadline = Date.now() + 60_000;
  let state;
  do {
    await new Promise((resolve) => setTimeout(resolve, 500));
    state = await read();
  } while (Date.now() < deadline && !(state.frames > 30 && state.energy > 0.001));
  console.log("Video state:", JSON.stringify(state));
  assert.equal(state.muted, false, "The mirrored video is muted");
  assert.ok(state.frames > 30, "No picture arrived over WebRTC");
  assert.ok(state.energy > 0.001, "No sound arrived over WebRTC");
  console.log("Picture and sound arrived over WebRTC.");
}

async function openDefaultBrowser(page) {
  await page.goto(origin);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.locator("button.profile-card").filter({ hasText: "默认账号" }).click();
  await page.waitForSelector("#shell-bar", { timeout: 60_000 });
}

async function checkWorkspace(page, address) {
  const html =
    '<!doctype html><meta charset="utf-8"><title>Mirror check</title><p id="ran">not run</p><output id="geometry"></output>' +
    `<script>
document.getElementById('ran').textContent = navigator.userAgent.includes('Chrome') ? 'ran' : 'odd';
const geometry = document.getElementById('geometry');
const report = () => geometry.textContent = JSON.stringify([innerWidth, innerHeight, screen.width, screen.height]);
addEventListener('resize', report);
report();
</script>`;
  await address.fill(fixturePage(html));
  await address.press("Enter");

  const mirrored = page.frameLocator("#mirror-host .mirror-stage:not([data-parked]) iframe");
  await mirrored.locator("#ran").waitFor({ timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const frame = document.querySelector("#mirror-host .mirror-stage:not([data-parked]) iframe");
      return frame?.contentDocument?.querySelector("#ran")?.textContent === "ran";
    },
    undefined,
    { timeout: 30_000 },
  );
  // The mirror holds what the script wrote, and none of the script's code could have run in it.
  const scripts = await mirrored.locator("script:not([type='text/plain'])").count();
  console.log(`Mirrored a page from ${origin}; live scripts in the mirror: ${scripts}.`);

  const [, , screenWidth, screenHeight] = JSON.parse(
    await mirrored.locator("#geometry").innerText(),
  );
  await page.setViewportSize({ width: 3200, height: 2000 });
  await page.waitForFunction(
    ([screenWidth, screenHeight]) => {
      const host = document.getElementById("mirror-host");
      const frame = host.querySelector(".mirror-stage:not([data-parked]) [data-fit] iframe");
      const geometry = frame?.contentDocument?.getElementById("geometry");
      if (!geometry?.textContent || host.dataset.inputReady !== "true") return false;
      const [w, h, sw, sh] = JSON.parse(geometry.textContent);
      return (
        sw === screenWidth && sh === screenHeight && (w === sw || h === sh) && w <= sw && h <= sh
      );
    },
    [screenWidth, screenHeight],
  );
  console.log("An oversized workbench fits the page while keeping the remote screen size.");
  await page.setViewportSize({ width: 1280, height: 900 });

  // A page's address changing shows in the bar, unless someone is typing there.
  const moving =
    "<!doctype html><title>Moving</title><script>setTimeout(() => (location.href = 'about:blank'), 3000);</script>";
  const showsBlank = () =>
    page.waitForFunction(
      () => document.querySelector("#urlbar input")?.value === "about:blank",
      undefined,
      {
        timeout: 20_000,
      },
    );
  await address.fill(fixturePage(moving));
  await address.press("Enter");
  await showsBlank();
  await address.fill(fixturePage(moving));
  await address.press("Enter");
  await address.fill("still typing");
  await page.waitForTimeout(8_000);
  assert.equal(
    await address.inputValue(),
    "still typing",
    "The page's address replaced the typing",
  );
  console.log("The address bar follows the page, and keeps what is being typed.");

  await checkForm(page, address, mirrored);
  await checkMovedFrame(page, address);
  await checkNestedFrames(page, address);
  await checkPageSleep(page, address);
  await checkAccounts(page);
}

async function checkPicture(browser) {
  // Picture mode, in a session of its own. Its canvas only appears once a frame has arrived.
  const pictureContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const picture = await pictureContext.newPage();
  await openDefaultBrowser(picture);
  // A title in Chinese, which picture mode has to read to find the window. The check on the gateway's
  // log in compose-smoke.sh sees it fail.
  await picture.waitForFunction(() => new URL(location.href).searchParams.has("sid"));
  const pictureAddress = picture.locator("#urlbar input");
  await picture
    .locator('#urlbar button[aria-label="Reload"]:not([disabled])')
    .waitFor({ timeout: 60_000 });
  await pictureAddress.fill(
    fixturePage('<!doctype html><meta charset="utf-8"><title>中文标题</title><p>画面</p>'),
  );
  await pictureAddress.press("Enter");
  await picture.waitForTimeout(2_000);
  // After the login, whose redirect does not keep the address's query.
  const session = new URL(picture.url()).searchParams.get("sid");
  await picture.goto(`${origin}/?mode=px&sid=${session}`);
  await picture.waitForFunction(() => document.querySelector(".px-canvas")?.width > 0, undefined, {
    timeout: 60_000,
  });
  console.log("Picture mode shows frames.");
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
  // Offer this machine's address instead of an mDNS name: the server cannot resolve .local
  // names, and when the runner's DNS also fails to resolve the STUN server, WebRTC has no path.
  args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    // The first about:blank document has an opaque origin and no storage.
    try {
      localStorage.setItem("mirror.view-mode", "dom");
    } catch {}
  });
  const page = await context.newPage();

  const refused = await context.request.get(`${origin}/api/client/session`, { maxRedirects: 0 });
  assert.notEqual(refused.status(), 200, "The API answered without logging in");

  await openDefaultBrowser(page);

  // The address bar is disabled until a tab exists.
  await page
    .locator('#urlbar button[aria-label="Reload"]:not([disabled])')
    .waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector("#urlbar input")?.value !== "");
  const address = page.locator("#urlbar input");
  if (process.env.SMOKE_VIDEO === "1" || process.env.SMOKE_CANVAS === "1") {
    if (process.env.SMOKE_VIDEO === "1") await checkVideo(page, address);
    if (process.env.SMOKE_CANVAS === "1") await checkCanvas(page, address);
  } else {
    await checkWorkspace(page, address);
    await checkPicture(browser);
  }
} finally {
  await browser.close();
}
