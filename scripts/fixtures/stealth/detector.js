/*
 * The page's own view of a recorder: the first script in every stealth fixture's <head>.
 *
 * It looks only at what any website can look at, and reports a flat fingerprint of strings,
 * numbers and booleans (packages/gateway/src/browser/stealth.accept.ts compares a run with the
 * recorder against one without). It never reports what the page shows or what was typed.
 */
(() => {
  "use strict";
  const FX = (globalThis.__fx = {});
  const isTop = window.parent === window;
  const marks = {
    foreignIframe: false,
    foreignNodes: [],
    extraFrames: 0,
    messageLiteral: false,
    messageAny: false,
    untrustedWheel: false,
    wheelUp: 0,
    untrustedValue: false,
    editableWithoutKey: false,
  };

  // ---- dom.foreign: frames and nodes the page did not create.
  const watchedTags = new Set(["IFRAME", "FRAME", "OBJECT", "EMBED", "SCRIPT", "STYLE", "LINK"]);
  const ownedFrames = () => document.querySelectorAll("iframe[data-fx]").length;
  const inspectAdded = (node) => {
    if (node.nodeType !== 1 || !watchedTags.has(node.tagName)) return;
    if (node.hasAttribute("data-fx")) return;
    if (node.tagName === "IFRAME" || node.tagName === "FRAME") marks.foreignIframe = true;
    else if (!marks.foreignNodes.includes(node.tagName)) marks.foreignNodes.push(node.tagName);
  };
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) inspectAdded(node);
  }).observe(document, { childList: true, subtree: true });
  const sampleFrames = () => {
    const extra = window.length - ownedFrames();
    if (extra > marks.extraFrames) marks.extraFrames = extra;
  };
  setInterval(sampleFrames, 20);
  const frameLoop = () => {
    sampleFrames();
    requestAnimationFrame(frameLoop);
  };
  requestAnimationFrame(frameLoop);

  // ---- msg.literal / msg.any: messages the fixture did not send.
  window.addEventListener(
    "message",
    (event) => {
      const data = event.data;
      if (data !== null && typeof data === "object" && data.fx !== undefined) return;
      marks.messageAny = true;
      const type = data !== null && typeof data === "object" ? data.type : undefined;
      if (typeof type === "string" && (/^@mirror\//.test(type) || type === "rrweb"))
        marks.messageLiteral = true;
    },
    true,
  );

  // ---- trust.*: events no person caused.
  let keyed = false;
  const editableOf = (target) =>
    target && target.nodeType === 1 && target.isContentEditable === true;
  window.addEventListener(
    "wheel",
    (event) => {
      if (!event.isTrusted) marks.untrustedWheel = true;
      if (event.deltaY < 0) marks.wheelUp++;
    },
    { capture: true, passive: true },
  );
  for (const type of ["keydown", "beforeinput"])
    window.addEventListener(type, () => (keyed = true), true);
  for (const type of ["input", "change", "click"])
    window.addEventListener(
      type,
      (event) => {
        if (!event.isTrusted) marks.untrustedValue = true;
        if (type === "input" && editableOf(event.target) && !keyed) marks.editableWithoutKey = true;
        if (type === "input") keyed = false;
      },
      true,
    );

  // ---- Probes run at collection time, on what the page sees then.
  const toStr = (f) => {
    try {
      return Function.prototype.toString.call(f);
    } catch (error) {
      return "throws:" + error.name;
    }
  };
  const sig = (f) => {
    if (typeof f !== "function") return typeof f;
    let constructible = false;
    try {
      Reflect.construct(Object, [], f);
      constructible = true;
    } catch {}
    const keys = Reflect.ownKeys(f).map(String).sort().join(",");
    return [keys, f.name, f.length, toStr(f), "prototype" in f, constructible].join("|");
  };
  const describe = (owner, key) => {
    if (owner === undefined || owner === null) return "no-owner";
    const d = Object.getOwnPropertyDescriptor(owner, key);
    if (d === undefined) return "absent";
    if ("value" in d)
      return ["value", d.writable, d.enumerable, d.configurable, sig(d.value)].join("/");
    return ["accessor", d.enumerable, d.configurable, sig(d.get), sig(d.set)].join("/");
  };
  // Chrome has no global FontFaceSet; its prototype is the one document.fonts has.
  const proto = (name) =>
    name === "FontFaceSet"
      ? Object.getPrototypeOf(document.fonts)
      : globalThis[name]
        ? globalThis[name].prototype
        : undefined;
  const membersOf = (owner) =>
    owner === undefined
      ? "no-owner"
      : Object.getOwnPropertyNames(owner)
          .sort()
          .map((key) => key + "=" + describe(owner, key))
          .join(";");

  function natShape() {
    const out = {};
    const add = (key, value) => (out["nat.shape:" + key] = value);
    for (const [name, keys] of [
      ["HTMLInputElement", ["value", "checked"]],
      ["HTMLTextAreaElement", ["value"]],
      ["HTMLSelectElement", ["value", "selectedIndex"]],
      ["HTMLOptionElement", ["selected"]],
      [
        "CSSStyleSheet",
        ["insertRule", "deleteRule", "replace", "replaceSync", "addRule", "removeRule"],
      ],
      ["CSSGroupingRule", ["insertRule", "deleteRule"]],
      ["CSSMediaRule", ["insertRule", "deleteRule"]],
      ["CSSSupportsRule", ["insertRule", "deleteRule"]],
      ["CSSStyleDeclaration", ["setProperty", "removeProperty"]],
      ["Element", ["attachShadow", "shadowRoot"]],
      ["ShadowRoot", ["mode", "adoptedStyleSheets"]],
      ["Document", ["adoptedStyleSheets", "hidden", "visibilityState", "hasFocus"]],
      ["HTMLCanvasElement", ["getContext"]],
      ["FontFaceSet", ["add"]],
      ["CustomElementRegistry", ["define"]],
      ["AudioNode", ["connect", "disconnect"]],
      ["AudioContext", ["createMediaElementSource"]],
      ["HTMLMediaElement", ["play"]],
      ["Clipboard", ["writeText", "readText", "write", "read"]],
      ["Permissions", ["query"]],
      ["ServiceWorkerRegistration", ["showNotification", "getNotifications"]],
      ["Function", ["toString"]],
    ])
      for (const key of keys) add(name + "." + key, describe(proto(name), key));
    // The functions a page reaches through instances, wherever they live.
    add("document.fonts.add", sig(document.fonts.add));
    add("customElements.define", sig(customElements.define));
    if (navigator.clipboard)
      for (const key of ["writeText", "readText", "write", "read"])
        add("navigator.clipboard." + key, sig(navigator.clipboard[key]));
    add("navigator.permissions.query", sig(navigator.permissions.query));
    add("window.FontFace", sig(window.FontFace));
    add("window.Notification", sig(window.Notification));
    add("Notification.requestPermission", sig(window.Notification?.requestPermission));
    // The drawing methods a canvas recorder may wrap, one entry per interface.
    for (const name of [
      "CanvasRenderingContext2D",
      "WebGLRenderingContext",
      "WebGL2RenderingContext",
    ])
      add(name + ".*", membersOf(proto(name)));
    return out;
  }

  const ownNames = (value) =>
    value === undefined || value === null
      ? "none"
      : Reflect.ownKeys(value)
          .map((key) => (typeof key === "symbol" ? "@" + (key.description ?? "") : key))
          .sort()
          .join(",");

  function instExpando(extra) {
    const out = {};
    const add = (key, value) => (out["inst.expando:" + key] = value);
    add("window", ownNames(window));
    add("document", ownNames(document));
    add("document.fonts", ownNames(document.fonts));
    add("customElements", ownNames(customElements));
    add("navigator.clipboard", ownNames(navigator.clipboard));
    add("navigator.permissions", ownNames(navigator.permissions));
    add("document.adoptedStyleSheets", describe(document, "adoptedStyleSheets"));
    for (const [name, value] of Object.entries(extra)) add(name, value);
    const face = new FontFace("x", "url(x)");
    add("FontFace.instanceof", face instanceof FontFace);
    let marked = false;
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.getAttributeNames())
        if (/^(rr-|__rrweb)/i.test(attribute)) marked = true;
      for (const name of element.classList) if (/^(rr-|__rrweb)/i.test(name)) marked = true;
    }
    add("rr-markers", marked);
    return out;
  }

  function timerGap() {
    const noop = () => {};
    const out = {};
    const input = document.createElement("input");
    let a = setTimeout(noop);
    input.value = "x";
    let b = setTimeout(noop);
    out["timer.gap:value"] = b - a;
    clearTimeout(a);
    clearTimeout(b);
    const host = document.createElement("div");
    host.setAttribute("data-fx", "");
    document.body.append(host);
    a = setTimeout(noop);
    host.attachShadow({ mode: "open" });
    b = setTimeout(noop);
    out["timer.gap:attachShadow"] = b - a;
    clearTimeout(a);
    clearTimeout(b);
    host.remove();
    return out;
  }

  /** Masked functions called on something they do not belong to. */
  function stackShape() {
    const calls = [
      () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call({}, ""),
      () => CSSStyleSheet.prototype.insertRule.call({}, "a{}"),
      () => Element.prototype.attachShadow.call({}, { mode: "open" }),
      () => proto("FontFaceSet").add.call({}, null),
      () => HTMLCanvasElement.prototype.getContext.call({}, "2d"),
    ];
    return calls
      .map((call) => {
        try {
          call();
          return "ok";
        } catch (error) {
          const frames = String(error.stack).split("\n").slice(1);
          const anonymous = frames.filter((frame) => !/https?:\/\//.test(frame)).length;
          return frames.length + "/" + anonymous;
        }
      })
      .join(",");
  }

  /** Another realm's toString on this realm's functions: hidden and visible blank frames, srcdoc. */
  async function crossRealm() {
    const targets = [
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set,
      CSSStyleSheet.prototype.insertRule,
      Element.prototype.attachShadow,
      Object.getOwnPropertyDescriptor(Element.prototype, "shadowRoot").get,
      proto("FontFaceSet").add,
      Function.prototype.toString,
    ];
    const out = {};
    for (const kind of ["hidden", "visible", "srcdoc"]) {
      const frame = document.createElement("iframe");
      frame.setAttribute("data-fx", "");
      if (kind === "hidden") frame.style.display = "none";
      if (kind === "srcdoc") frame.srcdoc = "<!doctype html><p>x</p>";
      document.body.append(frame);
      if (kind === "srcdoc")
        await new Promise((resolve) => frame.addEventListener("load", resolve));
      const other = frame.contentWindow.Function.prototype.toString;
      out["xrealm.tostring:" + kind] = targets
        .map((f) => {
          try {
            return other.call(f);
          } catch (error) {
            return "throws:" + error.name;
          }
        })
        .join("|");
      frame.remove();
    }
    return out;
  }

  function longTask() {
    return new Promise((resolve) => {
      let longest = 0;
      let observer = null;
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longest = Math.max(longest, entry.duration);
        });
        observer.observe({ type: "longtask" });
      } catch {}
      const box = document.createElement("div");
      box.setAttribute("data-fx", "");
      for (let i = 0; i < 5000; i++) box.append(document.createElement("span"));
      document.body.append(box);
      setTimeout(() => {
        box.remove();
        setTimeout(() => {
          observer?.disconnect();
          resolve(Math.round(longest));
        }, 200);
      }, 200);
    });
  }

  // ---- Child frames answer the top document's collection request.
  const childReports = new Map();
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data === null || typeof data !== "object") return;
    if (data.fx === "collect" && !isTop) {
      collect({}).then((report) => event.source.postMessage({ fx: "report", report }, "*"));
    } else if (data.fx === "report") {
      childReports.get(event.source)?.(data.report);
    }
  });
  function askFrame(frame) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ "fixture:child": "no-answer" }), 5000);
      childReports.set(frame.contentWindow, (report) => {
        clearTimeout(timer);
        resolve(report);
      });
      frame.contentWindow.postMessage({ fx: "collect" }, "*");
    });
  }

  /** `extra`: the fixture's own instance probes, such as its shadow roots. */
  async function collect(extra) {
    sampleFrames();
    return {
      ...natShape(),
      ...instExpando(extra),
      ...timerGap(),
      "dom.foreign:iframe": marks.foreignIframe,
      "dom.foreign:nodes": marks.foreignNodes.sort().join(","),
      "dom.foreign:frames": marks.extraFrames > 0,
      "msg.literal": marks.messageLiteral,
      "msg.any": marks.messageAny,
      "trust.wheel": marks.untrustedWheel,
      "trust.value": marks.untrustedValue,
      "trust.editable": marks.editableWithoutKey,
    };
  }

  FX.marks = marks;
  /** Everything at once, for the harness: this document, its probes and its child frames. */
  FX.collect = async (options = {}) => {
    const extra = typeof FX.extra === "function" ? FX.extra() : {};
    const own = await collect(extra);
    const frames = {};
    for (const frame of document.querySelectorAll("iframe[data-fx-child]"))
      frames[frame.getAttribute("data-fx-child")] = await askFrame(frame);
    const deep = options.deep
      ? {
          "stack.shape": stackShape(),
          ...(await crossRealm()),
          "shadow.composed": typeof FX.composedPath === "function" ? FX.composedPath() : "n/a",
          "perf.longtask:ms": await longTask(),
        }
      : {};
    return { own: { ...own, ...deep }, frames };
  };
})();
