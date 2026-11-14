/** Container-only regression suite. Use a fresh test volume and an internal Docker network;
 * give the container a default route to the internal gateway so Chromium gathers ICE candidates
 * (Docker's internal network must still block external forwarding). Pass a bundled replay
 * fixture with ISOLATION_REPLAY_BUNDLE. Never use a production profile. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
assert.equal(process.env.MIRROR_E2E, "1", "Requires an isolated E2E gateway");
assert.equal(process.env.NODE_ENV, "test", "Never run against production");
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
const require = createRequire("/app/package.json");
const WebSocket = require("ws");
const puppeteer = require("puppeteer-core");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const owner = "isolation-audit";
const base = "http://127.0.0.1:3010";
const headers = { "content-type": "application/json", "x-mirror-e2e-owner": owner };
const results = [];
const clients = [];
const native = [];
const dirs = [];
const log = (label, data) => {
  const row = { test: label, ...data };
  results.push(row);
  console.log(JSON.stringify(row));
};
async function api(path, body, extra = {}) {
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...headers, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  if (!r.ok) throw Error(path + " status " + r.status + " " + text.slice(0, 180));
  return text ? JSON.parse(text) : {};
}
async function evaluate(c, expression) {
  return (await api("/__e2e/evaluate", { sid: c.sid, expression })).value;
}
async function until(label, fn, ms = 15000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < ms) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await delay(150);
  }
  throw Error("Timed out " + label + " " + JSON.stringify(last).slice(0, 180));
}
async function check(name, fn) {
  try {
    log(name, { completed: true, ...(await fn()) });
  } catch (error) {
    log(name, { completed: false, error: error.message });
  }
}
const movingVideo = await new Promise((resolve, reject) => {
  execFile(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=120x80:rate=10",
      "-t",
      "4",
      "-an",
      "-c:v",
      "libvpx",
      "-deadline",
      "realtime",
      "-f",
      "webm",
      "pipe:1",
    ],
    { encoding: "buffer", timeout: 15000 },
    (error, stdout) => (error ? reject(error) : resolve(stdout)),
  );
});
const html = `<!doctype html><html><head><meta charset=utf-8><title>Isolation fixture</title></head><body><canvas id=audit-canvas width=120 height=80></canvas><video id=audit-media src=/moving.webm muted autoplay loop playsinline width=120 height=80></video><script>
window.fixtureReady=true;window.siteSignals=[];
for(const method of ['setRemoteDescription','addIceCandidate']){const original=RTCPeerConnection.prototype[method];RTCPeerConnection.prototype[method]=function(value){window.siteSignals.push({method,value:JSON.parse(JSON.stringify(value))});return original.apply(this,arguments)}}
const canvas=document.querySelector('canvas');const ctx=canvas.getContext('2d');let n=0;setInterval(()=>{ctx.fillStyle=n++%2?'red':'blue';ctx.fillRect(0,0,120,80)},200);document.querySelector('video').play().catch(e=>window.fixturePlayError=e.name);
</script></body></html>`;
const fixture = createServer((req, res) => {
  if (req.url === "/moving.webm") {
    res.writeHead(200, { "content-type": "video/webm", "content-length": movingVideo.length });
    res.end(movingVideo);
    return;
  }
  if (req.url === "/trusted-replay") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><video id="replayed" muted autoplay playsinline></video>');
    return;
  }
  if (req.url === "/sw.js") {
    res.writeHead(200, { "content-type": "application/javascript", "service-worker-allowed": "/" });
    res.end(
      "self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));",
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  res.end(html);
});
await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
const fixtureUrl = "http://127.0.0.1:" + fixture.address().port;
function trackNode(c, v) {
  if (!v || typeof v !== "object") return;
  if (v.tagName === "video" && v.attributes?.id === "audit-media") c.videoNode = v.id;
  if (v.tagName === "canvas" && v.attributes?.id === "audit-canvas") c.canvasNode = v.id;
  for (const x of Object.values(v)) if (x && typeof x === "object") trackNode(c, x);
}
async function client(label) {
  const acquired = await api("/api/client/session", { clientKey: "isolation-" + label });
  const account = await api("/api/accounts", { name: "Audit " + label });
  await api("/api/client/session/" + acquired.sid + "/account", { account: account.id });
  const c = {
    sid: acquired.sid,
    account: account.id,
    label,
    tab: undefined,
    clips: [],
    rtc: [],
    snapshots: 0,
    videoFrames: 0,
  };
  clients.push(c);
  const u = new URL("/ws", base);
  u.protocol = "ws:";
  u.searchParams.set("sid", c.sid);
  u.searchParams.set("e2e-owner", owner);
  u.searchParams.set("connectionKey", randomUUID());
  const ws = new WebSocket(u);
  c.ws = ws;
  c.send = (m) => ws.send(JSON.stringify(m));
  ws.on("error", () => {});
  ws.on("message", (bytes, binary) => {
    if (binary) {
      if (bytes[0] === 0x56) c.videoFrames++;
      return;
    }
    const m = JSON.parse(bytes.toString());
    if (m.t === "tabs") {
      const tab = m.tabs.find((x) => x.active)?.id;
      if (tab && tab !== c.tab) {
        c.tab = tab;
        c.send({ t: "view", tab, w: 900, h: 750, dpr: 1 });
        c.send({ t: "mode", tab, mode: "dom", video: false });
      }
    }
    if (m.t === "snapshot") {
      c.snapshots++;
      trackNode(c, m.data);
      c.send({ t: "view-ack", tab: m.tab, epoch: m.epoch });
    }
    if (m.t === "delta") trackNode(c, m.data);
    if (m.t === "clip") c.clips.push(m.text);
    if (m.t === "rtc-sig") c.rtc.push(m);
  });
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  await until("tab " + label, () => c.tab);
  c.send({ t: "nav", tab: c.tab, action: "go", url: fixtureUrl + "/" + label });
  await until("fixture " + label, () =>
    evaluate(c, "location.origin===" + JSON.stringify(fixtureUrl) + "&&window.fixtureReady===true"),
  );
  return c;
}
const storageSet = (value) =>
  `(async()=>{const value=${JSON.stringify(value)};document.cookie='audit='+value+'; Path=/; SameSite=Lax';localStorage.setItem('audit',value);sessionStorage.setItem('audit',value);await new Promise((resolve,reject)=>{const r=indexedDB.open('audit-db',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>{const db=r.result,t=db.transaction('state','readwrite');t.objectStore('state').put(value,'audit');t.oncomplete=()=>{db.close();resolve()};t.onerror=()=>reject(Error('IDB write'))};r.onerror=()=>reject(r.error)});const cache=await caches.open('audit-cache');await cache.put('/audit-cache-key',new Response(value));return true})()`;
const storageRead = `(async()=>{const idb=await new Promise((resolve,reject)=>{const r=indexedDB.open('audit-db',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>{const db=r.result,t=db.transaction('state');const q=t.objectStore('state').get('audit');q.onsuccess=()=>resolve(q.result??null);q.onerror=()=>reject(q.error);t.oncomplete=()=>db.close()};r.onerror=()=>reject(r.error)});const cache=await caches.open('audit-cache'),hit=await cache.match('/audit-cache-key');return{cookie:document.cookie,local:localStorage.getItem('audit'),session:sessionStorage.getItem('audit'),idb,cache:hit?await hit.text():null,serviceWorkers:(await navigator.serviceWorker.getRegistrations()).map(x=>x.scope)}})()`;
try {
  await until("test gateway health", async () => (await fetch(base + "/healthz")).ok);
  const a = await client("a"),
    b = await client("b");
  log("gateway-two-profiles", {
    completed: true,
    separateProfiles: true,
    fixtureOrigin: fixtureUrl,
  });
  await check("cross-profile-storage", async () => {
    await evaluate(a, storageSet("marker-a"));
    const bBefore = await evaluate(b, storageRead);
    assert.equal(bBefore.local, null);
    assert.equal(bBefore.idb, null);
    assert.equal(bBefore.cache, null);
    assert(!bBefore.cookie.includes("marker-a"));
    await evaluate(b, storageSet("marker-b"));
    const aAfter = await evaluate(a, storageRead),
      bAfter = await evaluate(b, storageRead);
    for (const [x, value] of [
      [aAfter, "marker-a"],
      [bAfter, "marker-b"],
    ]) {
      assert.equal(x.local, value);
      assert.equal(x.session, value);
      assert.equal(x.idb, value);
      assert.equal(x.cache, value);
      assert(x.cookie.includes("audit=" + value));
    }
    return { isolated: true, a: aAfter, b: bAfter };
  });
  await check("service-worker-registration", async () => {
    await evaluate(
      a,
      `navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(()=>true)`,
    );
    const av = await evaluate(a, storageRead),
      bv = await evaluate(b, storageRead);
    assert.equal(av.serviceWorkers.length, 1);
    assert.equal(bv.serviceWorkers.length, 0);
    return {
      isolated: true,
      aRegistrations: av.serviceWorkers.length,
      bRegistrations: bv.serviceWorkers.length,
    };
  });
  await check("wrong-owner-debug-access", async () => {
    const r = await fetch(base + "/__e2e/evaluate", {
      method: "POST",
      headers: { ...headers, "x-mirror-e2e-owner": "different-audit-owner" },
      body: JSON.stringify({ sid: a.sid, expression: "document.cookie" }),
    });
    assert.equal(r.status, 403);
    return { denied: true, status: r.status };
  });
  await check("cross-session-navigation", async () => {
    a.send({ t: "nav", tab: b.tab, action: "go", url: fixtureUrl + "/forged" });
    await delay(700);
    const url = await evaluate(b, "location.href");
    assert.equal(url, fixtureUrl + "/b");
    return { denied: true, otherTabUnchanged: true };
  });
  await check("dom-clipboard-and-delivery", async () => {
    const baselineA = a.clips.length,
      baselineB = b.clips.length;
    await evaluate(a, `navigator.clipboard.writeText('dom-clipboard-a').then(()=>true)`);
    await delay(500);
    const readB = await evaluate(b, "navigator.clipboard.readText()");
    assert.equal(readB, "");
    assert(!b.clips.slice(baselineB).includes("dom-clipboard-a"));
    assert(a.clips.slice(baselineA).includes("dom-clipboard-a"));
    await evaluate(b, `navigator.clipboard.writeText('dom-clipboard-b').then(()=>true)`);
    const readA = await evaluate(a, "navigator.clipboard.readText()");
    assert.equal(readA, "dom-clipboard-a");
    return { isolated: true, otherPageRead: readB, ownerRead: readA, crossViewerDelivery: false };
  });
  await check("page-visible-rtc-signaling", async () => {
    const tracks = await until(
      "video capture",
      () =>
        evaluate(
          a,
          `(()=>{const v=document.querySelector('video');try{return v.readyState>=2&&v.captureStream().getVideoTracks().length}catch{return false}})()`,
        ),
      10000,
    );
    await until("video node", () => a.videoNode);
    a.send({
      t: "rtc-sig",
      tab: a.tab,
      lane: "audit-lane",
      payload: { type: "video", id: a.videoNode },
    });
    await delay(700);
    const helper = await puppeteer.launch({
      executablePath: "/usr/bin/chromium",
      pipe: true,
      headless: true,
      args: ["--disable-dev-shm-usage"],
    });
    let sdp;
    try {
      const p = await helper.newPage();
      await p.goto(fixtureUrl + "/trusted-viewer");
      sdp = await p.evaluate(async () => {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.createDataChannel("fixture");
        const offer = await pc.createOffer();
        pc.close();
        return offer.sdp;
      });
    } finally {
      await helper.close();
    }
    sdp = sdp.replace("c=IN IP4 0.0.0.0", "c=IN IP4 203.0.113.91");
    assert(sdp.includes("203.0.113.91"));
    a.send({
      t: "rtc-sig",
      tab: a.tab,
      lane: "audit-lane",
      payload: { type: "signal", signal: { type: "offer", sdp } },
    });
    await until("isolated media answer", () =>
      a.rtc.some((m) => m.payload?.signal?.type === "answer"),
    );
    const observed = await evaluate(a, "window.siteSignals"),
      other = await evaluate(b, "window.siteSignals");
    assert.equal(observed.length, 0, "Site intercepted private media signaling");
    assert.equal(other.length, 0);
    const publicAnswers = await evaluate(
      a,
      `(async()=>{
      let answers=0;
      const listener=event=>{if(event.data?.type==='rrweb-canvas-webrtc'&&
        event.data.data?.signal?.type==='answer')answers++};
      window.addEventListener('message',listener);
      window.postMessage({type:'rrweb-canvas-webrtc',data:{type:'signal',
        signal:{type:'offer',sdp:${JSON.stringify(sdp)}}}},'*');
      await new Promise(resolve=>setTimeout(resolve,400));
      window.removeEventListener('message',listener);return answers;
    })()`,
    );
    assert.equal(publicAnswers, 0, "Legacy public postMessage media transport was active");
    return {
      validOfferAnswered: true,
      siteObservedReservedCanary: JSON.stringify(observed).includes("203.0.113.91"),
      siteCalls: observed.map((x) => x.method),
      otherProfileCalls: other.length,
      publicPostMessageAnswers: publicAnswers,
      fixtureVideoTracks: tracks,
      reservedCanaryOnly: true,
      validConnectionEstablished: false,
      note: "A valid browser-generated offer was answered in the isolated world; reserved canary only, and site hooks observed no SDP/ICE.",
    };
  });
  await check("isolated-media-live-stream", async () => {
    const source = await readFile(
      process.env.ISOLATION_REPLAY_BUNDLE ?? "/tmp/isolation-replay.js",
      "utf8",
    );
    const helper = await puppeteer.launch({
      executablePath: "/usr/bin/chromium",
      headless: true,
      pipe: true,
      args: ["--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
    });
    try {
      const page = await helper.newPage();
      const viewerErrors = [];
      page.on("pageerror", (error) => viewerErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") viewerErrors.push(message.text());
      });
      await page.goto(fixtureUrl + "/trusted-replay");
      await page.addScriptTag({ content: source });
      await page.evaluate((id) => {
        window.outSignals = [];
        window.signalHistory = [];
        window.replay = new IsolationReplay.RRWebPluginCanvasWebRTCReplay({
          canvasFoundCallback() {},
          signalSendCallback(signal) {
            window.outSignals.push(signal);
            window.signalHistory.push({
              type: signal.type,
              media: signal.sdp?.split("\r\n").filter((line) => line.startsWith("m=")),
            });
          },
        });
        window.replay.initPlugin().getMirror({
          nodeMirror: {
            getNode(node) {
              return node === id ? document.querySelector("video") : null;
            },
          },
        });
      }, a.videoNode);
      a.send({ t: "rtc-sig", tab: a.tab, lane: "audit-lane", payload: { type: "close" } });
      const lane = "live-stream-lane";
      let cursor = a.rtc.length;
      a.send({ t: "rtc-sig", tab: a.tab, lane, payload: { type: "video", id: a.videoNode } });
      try {
        await until(
          "decoded media frames",
          async () => {
            while (cursor < a.rtc.length) {
              const message = a.rtc[cursor++];
              if (message.lane === lane && message.payload?.type === "signal")
                await page.evaluate(
                  (signal) => window.replay.signalReceive(signal),
                  message.payload.signal,
                );
            }
            for (const signal of await page.evaluate(() => window.outSignals.splice(0)))
              a.send({ t: "rtc-sig", tab: a.tab, lane, payload: { type: "signal", signal } });
            return page.evaluate(
              () => document.querySelector("video").getVideoPlaybackQuality().totalVideoFrames >= 3,
            );
          },
          25000,
        );
      } catch (error) {
        const state = await page.evaluate(async () => ({
          peer: !!window.replay.peer,
          ice: window.replay.peer?._pc?.iceConnectionState,
          connection: window.replay.peer?._pc?.connectionState,
          streams: window.replay.streams.size,
          mappings: window.replay.streamNodeMap.size,
          video: {
            state: document.querySelector("video").readyState,
            tracks: document
              .querySelector("video")
              .srcObject?.getTracks()
              .map((t) => ({ kind: t.kind, state: t.readyState })),
          },
          stats: window.replay.peer?._pc
            ? [...(await window.replay.peer._pc.getStats())]
                .map((x) => x[1])
                .filter((x) => ["candidate-pair", "inbound-rtp"].includes(x.type))
                .map((x) => ({
                  type: x.type,
                  state: x.state,
                  bytesReceived: x.bytesReceived,
                  framesDecoded: x.framesDecoded,
                }))
            : [],
        }));
        const signals = a.rtc
          .filter((x) => x.lane === lane)
          .map((x) => ({
            type: x.payload.type,
            notice: x.payload.notice,
            signal: x.payload.signal?.type,
            candidate: !!x.payload.signal?.candidate,
          }));
        const negotiation = await page.evaluate(() => ({
          remote: window.replay.peer?._pc?.remoteDescription?.type,
          local: window.replay.peer?._pc?.localDescription?.type,
          signaling: window.replay.peer?._pc?.signalingState,
          pending: window.outSignals.map((s) => s.type),
          history: window.signalHistory,
          trickle: window.replay.peer?.trickle,
          remoteMedia: window.replay.peer?._pc?.remoteDescription?.sdp
            .split("\r\n")
            .filter((line) => line.startsWith("m=")),
          localMedia: window.replay.peer?._pc?.localDescription?.sdp
            .split("\r\n")
            .filter((line) => line.startsWith("m=")),
          peerError: window.replay.peer?.destroyed,
        }));
        const source = await evaluate(
          a,
          `(()=>{const v=document.querySelector('video');return{ready:v.readyState,paused:v.paused,time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames}})()`,
        );
        throw Error(
          error.message +
            " " +
            JSON.stringify({ state, signals, negotiation, source, viewerErrors }),
        );
      }
      const frames = await page.evaluate(
        () => document.querySelector("video").getVideoPlaybackQuality().totalVideoFrames,
      );
      const siteCalls = await evaluate(a, "window.siteSignals.length");
      assert.equal(siteCalls, 0);
      a.send({ t: "rtc-sig", tab: a.tab, lane, payload: { type: "close" } });
      return {
        decodedFrames: frames,
        validConnectionEstablished: true,
        siteSignalCalls: siteCalls,
      };
    } finally {
      await helper.close();
    }
  });

  // Fresh native browsers use the actual gateway profiles' separate displays and authority files.
  await check("native-system-clipboard", async () => {
    const configurations = new Map();
    for (const pid of await readdir("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const argv = (await readFile("/proc/" + pid + "/cmdline", "utf8"))
          .split("\0")
          .filter(Boolean);
        if (!argv[0]?.endsWith("/chromium") || argv.some((x) => x.startsWith("--type="))) continue;
        const profile = argv.find((x) => x.startsWith("--user-data-dir="));
        const client = clients.find((c) => profile?.endsWith("/" + c.account));
        if (!client) continue;
        const env = Object.fromEntries(
          (await readFile("/proc/" + pid + "/environ", "utf8"))
            .split("\0")
            .filter((x) => /^(DISPLAY|XAUTHORITY)=/.test(x))
            .map((x) => {
              const i = x.indexOf("=");
              return [x.slice(0, i), x.slice(i + 1)];
            }),
        );
        configurations.set(client.account, {
          env,
          args: argv
            .slice(1)
            .filter(
              (x) =>
                x.startsWith("--") &&
                !x.startsWith("--user-data-dir=") &&
                !x.startsWith("--remote-debugging-"),
            ),
        });
      } catch {}
    }
    const configs = clients.map((c) => configurations.get(c.account));
    for (let i = 0; i < clients.length; i++) clients[i].display = configs[i]?.env.DISPLAY;
    assert(configs.every(Boolean), "Missing account display configuration");
    assert.notEqual(configs[0].env.DISPLAY, configs[1].env.DISPLAY, "Account displays shared");
    const crossDenied = await new Promise((r) =>
      execFile(
        "xdpyinfo",
        [],
        {
          env: { ...process.env, ...configs[0].env, XAUTHORITY: configs[1].env.XAUTHORITY },
          timeout: 1500,
        },
        (e) => r(!!e),
      ),
    );
    assert(crossDenied, "Foreign display authorization accepted");
    for (const config of configs) {
      const dir = await mkdtemp("/tmp/native-isolation-");
      dirs.push(dir);
      const browser = await puppeteer.launch({
        executablePath: "/usr/bin/chromium",
        userDataDir: dir,
        headless: false,
        pipe: true,
        ignoreDefaultArgs: true,
        args: config.args,
        env: { ...process.env, ...config.env },
        defaultViewport: null,
      });
      native.push(browser);
    }
    const pages = [];
    const roots = [];
    for (const browser of native) {
      const p = await browser.newPage();
      await p.goto(fixtureUrl + "/native", { waitUntil: "load" });
      pages.push(p);
      roots.push(await browser.target().createCDPSession());
    }
    const before = await pages[1].evaluate(() =>
      navigator.permissions.query({ name: "clipboard-read" }).then((x) => x.state),
    );
    await roots[0].send("Browser.grantPermissions", {
      origin: fixtureUrl,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    const otherPermission = await pages[1].evaluate(() =>
      navigator.permissions.query({ name: "clipboard-read" }).then((x) => x.state),
    );
    assert.equal(otherPermission, before);
    await roots[1].send("Browser.grantPermissions", {
      origin: fixtureUrl,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await pages[0].bringToFront();
    await until("native A focus", () => pages[0].evaluate(() => document.hasFocus()));
    await pages[0].evaluate(() => navigator.clipboard.writeText("native-system-a"));
    await pages[1].bringToFront();
    await until("native B focus", () => pages[1].evaluate(() => document.hasFocus()));
    const bRead = await pages[1].evaluate(() => navigator.clipboard.readText());
    assert.equal(bRead, "", "Foreign account clipboard was visible");
    await pages[1].evaluate(() => navigator.clipboard.writeText("native-system-b"));
    await pages[0].bringToFront();
    const aRead = await pages[0].evaluate(() => navigator.clipboard.readText());
    assert.equal(aRead, "native-system-a", "Foreign account write replaced clipboard");
    await pages[0].evaluate(() => navigator.clipboard.writeText(""));
    return {
      profilePermissionsSeparate: true,
      bPermissionBefore: before,
      bPermissionAfterGrantingA: otherPermission,
      sharedSystemClipboard: bRead === "native-system-a" && aRead === "native-system-b",
      bRead,
      aRead,
      requiresExplicitReadPermission: true,
      separateChromeProcesses: true,
      privateDisplays: configs.map((x) => x.env.DISPLAY),
      crossDisplayAuthorizationDenied: crossDenied,
    };
  });
  await check("private-display-pixel-grab", async () => {
    const before = a.videoFrames;
    a.send({ t: "mode", tab: a.tab, mode: "px", video: true });
    await until("pixel video frames", () => a.videoFrames > before + 2, 15000);
    let ownCapture = false;
    for (const pid of await readdir("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
        if (
          args[0]?.endsWith("ffmpeg") &&
          args.includes("x11grab") &&
          args.some((value) => value.startsWith(a.display + "+"))
        )
          ownCapture = true;
      } catch {}
    }
    assert(ownCapture, "Pixel encoder did not capture the owning account display");
    a.send({ t: "mode", tab: a.tab, mode: "dom", video: false });
    return { receivedVideoFrames: a.videoFrames - before, owningDisplayCaptured: true };
  });
} catch (error) {
  log("setup-failure", { completed: false, error: error.message });
} finally {
  for (const c of clients) c.ws?.close();
  for (const b of native) await b.close().catch(() => {});
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  fixture.closeAllConnections();
  await new Promise((r) => fixture.close(r));
  console.log(JSON.stringify({ summary: true, results }));
  if (results.some((x) => !x.completed)) process.exitCode = 1;
}
