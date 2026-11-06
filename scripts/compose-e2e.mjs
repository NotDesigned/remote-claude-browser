/**
 * Logs in to a running server and checks that a page is mirrored and that its script ran on the
 * server, not here. Needs SMOKE_ORIGIN, SMOKE_PASSWORD and CHROME_PATH.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const origin = process.env.SMOKE_ORIGIN;
const password = process.env.SMOKE_PASSWORD;
assert.ok(origin && password, "Set SMOKE_ORIGIN and SMOKE_PASSWORD");

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
) => `<!doctype html><meta charset="utf-8"><input type="checkbox" id="${tag}-box"><p id="${tag}-log">0</p><p id="${tag}-ticks">0</p><script>
let n = 0; const box = document.getElementById("${tag}-box");
box.addEventListener("change", () => { document.getElementById("${tag}-log").textContent = String(box.checked); });
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
  await address.fill(`data:text/html;charset=utf-8,${encodeURIComponent(MOVED_PAGE)}`);
  await address.press("Enter");
  const find = (id) =>
    page.evaluate((id) => {
      const visit = (doc, x, y) => {
        const found = doc.getElementById(id);
        if (found) {
          const r = found.getBoundingClientRect();
          return {
            text: found.textContent,
            checked: found.checked,
            x: x + r.left + r.width / 2,
            y: y + r.top + r.height / 2,
          };
        }
        for (const frame of doc.querySelectorAll("iframe")) {
          const inner = frame.contentDocument;
          if (!inner) continue;
          const r = frame.getBoundingClientRect();
          const got = visit(inner, x + r.left, y + r.top);
          if (got) return got;
        }
        return null;
      };
      const top = document.querySelector("#mirror-host .mirror-stage:not([data-parked]) iframe");
      const o = top.getBoundingClientRect();
      return top.contentDocument ? visit(top.contentDocument, o.left, o.top) : null;
    }, id);
  // Past the move, and past when a report would arrive.
  await page.waitForTimeout(8_000);
  for (const tag of ["a", "b"]) {
    const before = await find(`${tag}-ticks`);
    assert.ok(before, `Moved frame ${tag}'s content is missing from the mirror`);
    await page.waitForTimeout(2_000);
    const after = await find(`${tag}-ticks`);
    assert.ok(Number(after?.text) > Number(before.text), `Moved frame ${tag} stopped updating`);
    const box = await find(`${tag}-box`);
    console.log("DBG box", tag, JSON.stringify(box));
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(2_000);
    console.log("DBG after", tag, JSON.stringify(await find(`${tag}-log`)), JSON.stringify(await find(`${tag}-box`)));
    assert.equal(
      (await find(`${tag}-log`))?.text,
      "true",
      `A press did not reach moved frame ${tag}`,
    );
    assert.equal(
      (await find(`${tag}-box`))?.checked,
      true,
      `The mirror did not show moved frame ${tag}'s check`,
    );
  }
  console.log("Frames moved without reloading stay in the mirror, live and usable.");
}

/** A long document in frames which may share a process with their parent, as Claude's documents do. */
const longDocument = (tag) => {
  let rows = "";
  for (let i = 0; i < 60; i++)
    rows += `<p id="${tag}-row${i}" style="height:40px;margin:0">row ${i}</p>`;
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}</style><div id="${tag}-state" style="position:fixed;top:0;right:0">0/none</div>${rows}<script>
const state = document.getElementById("${tag}-state");
let pressed = "none";
const show = () => { state.textContent = Math.round(scrollY) + "/" + pressed; };
addEventListener("scroll", show);
addEventListener("mousedown", (event) => { pressed = event.target.id || event.target.tagName; show(); });
</script>`;
};
const quoted = (html) => html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const sandboxed = (html, style) =>
  `<iframe sandbox="allow-scripts" style="${style}" srcdoc="${quoted(html)}"></iframe>`;
const NESTED_PAGE = `<!doctype html><meta charset="utf-8"><title>Nested</title><body style="margin:6px;display:flex;gap:6px">
${sandboxed(longDocument("single"), "width:330px;height:340px")}
<iframe style="width:330px;height:340px" src="data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><meta charset="utf-8"><body style="margin:0">${sandboxed(longDocument("indata"), "width:300px;height:300px;display:block")}`,
)}"></iframe>
${sandboxed(
  `<!doctype html><meta charset="utf-8"><body style="margin:0">${sandboxed(longDocument("insandbox"), "width:300px;height:300px;display:block")}`,
  "width:330px;height:340px",
)}`;

async function checkNestedFrames(page, address) {
  await address.fill(`data:text/html;charset=utf-8,${encodeURIComponent(NESTED_PAGE)}`);
  await address.press("Enter");
  const find = (id) =>
    page.evaluate((id) => {
      const visit = (doc, x, y) => {
        const found = doc.getElementById(id);
        if (found) {
          const r = found.getBoundingClientRect();
          return { text: found.textContent, x: x + r.left + 20, y: y + r.top + r.height / 2 };
        }
        for (const frame of doc.querySelectorAll("iframe")) {
          if (!frame.contentDocument) continue;
          const r = frame.getBoundingClientRect();
          const got = visit(frame.contentDocument, x + r.left, y + r.top);
          if (got) return got;
        }
        return null;
      };
      const top = document.querySelector("#mirror-host .mirror-stage:not([data-parked]) iframe");
      const o = top.getBoundingClientRect();
      return top.contentDocument ? visit(top.contentDocument, o.left, o.top) : null;
    }, id);
  await page.waitForTimeout(6_000);
  for (const tag of ["single", "indata", "insandbox"]) {
    const near = await find(`${tag}-row2`);
    assert.ok(near, `The ${tag} document is missing from the mirror`);
    await page.mouse.move(near.x, near.y);
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(2_500);
    const state = await find(`${tag}-state`);
    assert.equal(
      state?.text.split("/")[0],
      "800",
      `The ${tag} document did not scroll on the remote page`,
    );
    const row = await find(`${tag}-row24`);
    await page.mouse.click(row.x, row.y);
    await page.waitForTimeout(1_500);
    assert.equal(
      (await find(`${tag}-state`))?.text,
      `800/${tag}-row24`,
      `A press in the ${tag} document went astray`,
    );
  }
  console.log("Scrolling and pressing reach the right place in nested frames.");
}

async function checkForm(page, address, mirrored) {
  await address.fill(`data:text/html,${encodeURIComponent(FORM_PAGE)}`);
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
  await address.fill(`data:text/html,${encodeURIComponent(VIDEO_PAGE)}`);
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

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
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

  await page.goto(origin);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector("#shell-bar", { timeout: 60_000 });

  const html =
    '<!doctype html><meta charset="utf-8"><title>Mirror check</title><p id="ran">not run</p>' +
    "<script>document.getElementById('ran').textContent = navigator.userAgent.includes('Chrome') ? 'ran' : 'odd';</script>";
  // The address bar is disabled until a tab exists.
  await page
    .locator('#urlbar button[aria-label="Reload"]:not([disabled])')
    .waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector("#urlbar input")?.value !== "");
  const address = page.locator("#urlbar input");
  await address.fill(`data:text/html,${encodeURIComponent(html)}`);
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
  await address.fill(`data:text/html,${encodeURIComponent(moving)}`);
  await address.press("Enter");
  await showsBlank();
  await address.fill(`data:text/html,${encodeURIComponent(moving)}`);
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

  if (process.env.SMOKE_VIDEO === "1") await checkVideo(page, address);

  // Picture mode, in a session of its own. Its canvas only appears once a frame has arrived.
  const pictureContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const picture = await pictureContext.newPage();
  await picture.goto(origin);
  await picture.locator('input[name="password"]').fill(password);
  await picture.locator('button[type="submit"]').click();
  await picture.waitForSelector("#shell-bar", { timeout: 60_000 });
  // A title in Chinese, which picture mode has to read to find the window. The check on the gateway's
  // log in compose-smoke.sh sees it fail.
  await picture.waitForFunction(() => new URL(location.href).searchParams.has("sid"));
  const pictureAddress = picture.locator("#urlbar input");
  await picture
    .locator('#urlbar button[aria-label="Reload"]:not([disabled])')
    .waitFor({ timeout: 60_000 });
  await pictureAddress.fill(
    `data:text/html,${encodeURIComponent('<!doctype html><meta charset="utf-8"><title>中文标题</title><p>画面</p>')}`,
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
} finally {
  await browser.close();
}
