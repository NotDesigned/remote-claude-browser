import "./chat-view.css";
import { renderChatText } from "./chat-render";
import { CHAT_VIEW_MARKUP } from "./chat-markup";
import { ANCHOR_BLOCKS, blockStart } from "./page-look";
import { DOWNLOAD_NOTICE_MS, startClientDownload } from "./auto-download";

const RENDER_MAX_INTERVAL_MS = 1000;
const MORE_AREA_PX = 30;
const NOTICE_DELAY_MS = 4_000;
const TITLE_BAR_PX = 48;
const VOICE_ICON =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.6 9.6v.8M6.8 7.6v4.8M10 3.6v12.8M13.2 7.6v4.8M16.4 9.6v.8"/></svg>';

/**
 * Text chat, mounted inside the unified page. Returns a dispose function that closes the chat
 * stream, stops every timer and removes every global listener, so the page can switch between
 * chat and the browser views without reloading.
 *
 * @param {HTMLElement} root
 * @param {{ sid: string | null, tab?: string | null, connectionKey: string,
 *   onStatus?: (status: { text: string, connected: boolean }) => void,
 *   onLocation?: (location: { url: string, title: string }) => void,
 *   onOpenBrowser?: () => void,
 *   pageLook?: import("./page-look").PageLook | null,
 *   pageView?: import("./page-look").PageView | null }} options
 * @returns {() => void}
 */
export function mountChatView(root, options) {
  const cleanups = [];
  const listen = (target, type, handler, listenOptions) => {
    if (!target) return;
    target.addEventListener(type, handler, listenOptions);
    cleanups.push(() => target.removeEventListener(type, handler, listenOptions));
  };
  root.innerHTML = CHAT_VIEW_MARKUP;
  const $ = (id) => root.querySelector(`#${id}`);
  const sid = options.sid ?? null;
  const apiBase = sid ? `/s/${encodeURIComponent(sid)}/api/claude` : "/api/claude";
  const connectionKey = options.connectionKey;
  const storageScope = sid ? `:${sid}` : "";
  const legacyDraftKey = `remote-claude.draft.v1${storageScope}`;
  const draftPrefix = `remote-claude.draft.v2${storageScope}:`;
  const pendingKey = `remote-claude.pending.v1${storageScope}`;
  const pendingDetailsKey = `${pendingKey}.details`;
  const setConnectionText = (text) => {
    $("connection").textContent = text;
    options.onStatus?.({ text, connected });
  };
  let state = null,
    controller = null,
    sequence = 0,
    connected = false,
    busy = false;
  let prepareController = null;
  let uploadController = null,
    uploadPick = null,
    preparingUpload = false;
  let pending = sessionStorage.getItem(pendingKey);
  let pendingDetails;
  try {
    pendingDetails = JSON.parse(sessionStorage.getItem(pendingDetailsKey) || "null");
  } catch {
    pendingDetails = null;
  }
  if (pendingDetails?.id !== pending) pendingDetails = null;
  let source;
  let retry;
  let leaving = false;
  let retired = false;
  let actionController = null;
  let reconcileTimer;
  let retryAttempt = 0;
  const maxRetryAttempts = 5;
  const tab = options.tab ?? null;
  const phone = matchMedia("(max-width:760px)");
  const look = options.pageLook ?? null;
  const pageView = options.pageView ?? null;
  let anchorDone = false;
  cleanups.push(() => clearTimeout(noticeTimer));
  let pageFrameDrawn = false;
  let newPageDrawn = false;
  let noticeTimer;
  let sidebarWish = null;
  const messageElements = new Map();
  const conversationElements = new Map();
  let draftPath = null;
  let draftKey = null;
  let following = true;
  let creatingConversation = false;
  let openingNew = false;
  let draftEditedBeforeReady = false;
  let statusTimer;
  let attachmentSignature = "";
  let renderTimer;
  let lastRenderAt = 0;
  let lastRenderCost = 0;
  let sizedDraft = null;
  const draft = $("draft");
  draft.value = localStorage.getItem(legacyDraftKey) || "";
  const messages = $("messages");
  const pendingArticle = document.createElement("article");
  pendingArticle.className = "message user pending-message";
  pendingArticle.innerHTML = '<div class="role">你 · 正在发送</div><div class="text"></div>';
  function saveDraft() {
    if (draftKey) localStorage.setItem(draftKey, draft.value);
  }
  function persistPendingDetails() {
    if (pendingDetails) sessionStorage.setItem(pendingDetailsKey, JSON.stringify(pendingDetails));
    else sessionStorage.removeItem(pendingDetailsKey);
  }
  function activateDraft() {
    const path = new URL(state.url).pathname;
    if (path === draftPath) return;
    saveDraft();
    const key = draftPrefix + encodeURIComponent(path);
    const createdConversation =
      draftPath === "/new" && /^\/chat\//.test(path) && creatingConversation;
    if (createdConversation) {
      localStorage.setItem(key, draft.value);
      localStorage.removeItem(draftKey);
      if (pendingDetails?.type === "send") pendingDetails.path = path;
      creatingConversation = false;
      persistPendingDetails();
    } else {
      const saved = localStorage.getItem(key);
      const legacy = draftPath === null ? localStorage.getItem(legacyDraftKey) : null;
      draft.value =
        openingNew && path === "/new"
          ? ""
          : draftPath === null && draftEditedBeforeReady
            ? draft.value
            : (saved ?? legacy ?? state.draft ?? "");
      if (path === "/new") openingNew = false;
      if (legacy !== null) localStorage.removeItem(legacyDraftKey);
    }
    draftPath = path;
    draftKey = key;
    saveDraft();
    following = true;
  }
  draft.addEventListener("input", () => {
    if (draftPath === null) draftEditedBeforeReady = true;
    saveDraft();
    controls();
  });
  messages.addEventListener(
    "scroll",
    () => {
      following = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
      $("jump-latest").hidden = following;
    },
    { passive: true },
  );
  for (const type of ["wheel", "touchstart", "keydown"])
    messages.addEventListener(type, () => (anchorDone = true), { passive: true });
  messages.addEventListener("click", async (event) => {
    // Claude's own links need the remote browser's login; this browser never visits the site.
    const link = event.target.closest?.("a[href]");
    if (link && /^https:\/\/([\w-]+\.)*claude\.ai(\/|$)/i.test(link.href)) {
      event.preventDefault();
      options.onOpenRemote?.(link.href);
      return;
    }
    const button = event.target.closest?.(".code-copy");
    if (!button) return;
    const code = button.closest(".chat-code-block")?.querySelector("code");
    try {
      await navigator.clipboard.writeText(code?.textContent ?? "");
      button.textContent = "已复制";
    } catch {
      button.textContent = "请选中复制";
    }
    setTimeout(() => (button.textContent = "复制"), 1500);
  });
  $("sidebar-show").onclick = () => (phone.matches ? setHistoryOpen(true) : setSidebar(true));
  $("recents-toggle").onclick = () => {
    const open = $("recents-toggle").getAttribute("aria-expanded") !== "true";
    $("recents-toggle").setAttribute("aria-expanded", String(open));
    $("conversations").hidden = !open;
  };
  $("compose-project").onclick = $("compose-mode").onclick = () => options.onOpenRemote?.();
  $("compose-model").onclick = (event) => {
    event.stopPropagation();
    openModelMenu();
  };
  listen(document, "click", (event) => {
    if (!$("model-menu").hidden && !event.target.closest?.("#model-menu")) closeModelMenu();
  });
  listen(document, "keydown", (event) => {
    if (event.key === "Escape") closeModelMenu();
  });
  $("jump-latest").onclick = () => {
    following = true;
    messages.scrollTop = messages.scrollHeight;
    $("jump-latest").hidden = true;
  };
  listen(document, "selectionchange", () => {
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed && messages.contains(selection.anchorNode))
      following = false;
  });
  function controls() {
    $("send").disabled =
      !draft.value.trim() ||
      leaving ||
      !controller ||
      !connected ||
      !state?.ready ||
      state.generating ||
      busy ||
      !!pending ||
      !!uploadController ||
      preparingUpload;
    $("new-chat").disabled = leaving || !controller || !connected || !state || busy || !!pending;
    $("mobile-new-chat").disabled = $("new-chat").disabled;
    $("stop").hidden = !state?.generating;
    $("stop").disabled = leaving || !controller || !connected || busy || !!pending;
    $("resolve-pending").hidden = !pending || busy;
    $("resolve-pending").disabled = leaving;
    draft.readOnly = leaving;
    $("attach").disabled =
      leaving ||
      !controller ||
      !connected ||
      !state?.ready ||
      !!uploadController ||
      preparingUpload;
    if (leaving) cancelUpload();
    if (draft.value !== sizedDraft) sizeDraft();
    // Claude's page says nothing while things go as they should, so neither does this. What stays
    // is an action whose outcome is still open after its request has ended.
    $("generation-status").textContent = pending && !busy ? "等待操作确认" : "";
  }
  /** Short confirmations clear themselves instead of lingering above the composer. */
  function transientStatus(text) {
    $("action-status").textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      if ($("action-status").textContent === text) $("action-status").textContent = "";
    }, 3000);
  }
  /** The composer grows with its text up to its CSS maximum. */
  function sizeDraft() {
    sizedDraft = draft.value;
    draft.style.height = "auto";
    draft.style.height = `${draft.scrollHeight}px`;
  }
  function setRetryVisible(visible) {
    $("retry-chat").hidden = !visible;
  }
  /** Files in the remote composer, each removable there through the gateway. */
  function renderAttachments() {
    const attachments = state.attachments || [];
    const signature = JSON.stringify(attachments);
    if (signature === attachmentSignature) return;
    attachmentSignature = signature;
    const list = $("attachments");
    list.hidden = !attachments.length;
    list.replaceChildren(
      ...attachments.map((attachment, index) => {
        const item = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = attachment.name;
        item.append(name);
        if (attachment.removable) {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "×";
          remove.setAttribute("aria-label", `移除附件 ${attachment.name}`);
          remove.onclick = async () => {
            remove.disabled = true;
            try {
              const response = await fetch(`${apiBase}/attachment`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  controller,
                  epoch: state.epoch,
                  attachment: index,
                  name: attachment.name,
                }),
              });
              if (!response.ok) throw new Error((await response.json()).error || "移除失败");
            } catch (error) {
              remove.disabled = false;
              $("action-status").textContent = error.message || "移除失败";
            }
          };
          item.append(remove);
        }
        return item;
      }),
    );
  }
  /**
   * Streaming replies are parsed whole, so the rate follows what a render really costs here: at
   * most about a fifth of the main thread goes to it, however long the reply or slow the device.
   */
  function scheduleRender() {
    if (renderTimer !== undefined) return;
    const wait =
      lastRenderAt + Math.min(RENDER_MAX_INTERVAL_MS, lastRenderCost * 4) - performance.now();
    if (wait <= 0) render();
    else
      renderTimer = setTimeout(() => {
        renderTimer = undefined;
        if (state && !leaving) render();
      }, wait);
  }
  let reportedLocation = "";
  function reportLocation() {
    const location = JSON.stringify([state.url, state.title]);
    if (location === reportedLocation) return;
    reportedLocation = location;
    options.onLocation?.({ url: state.url, title: state.title ?? "" });
  }
  /** Fonts that never arrived leave Claude's icons as empty boxes, so those are hidden instead. */
  function glyphSpan(glyph, className = "glyph") {
    const span = document.createElement("span");
    span.className = className;
    span.setAttribute("aria-hidden", "true");
    span.textContent = glyph;
    return span;
  }
  function applyLook() {
    if (!look) return;
    const head = $("side-head");
    head.replaceChildren();
    if (look.sidebarGlyph) {
      const hide = document.createElement("button");
      hide.type = "button";
      hide.className = "side-toggle";
      hide.setAttribute("aria-label", "折叠对话列表");
      hide.append(glyphSpan(look.sidebarGlyph));
      hide.onclick = () => (phone.matches ? setHistoryOpen(false) : setSidebar(false));
      head.append(hide);
      $("sidebar-show").querySelector(".glyph").textContent = look.sidebarGlyph;
    }
    const wordmark = document.createElement("span");
    wordmark.className = "wordmark";
    wordmark.textContent = look.wordmark || "Claude";
    head.append(wordmark);
    if (look.modeGlyphs?.length) {
      const modes = document.createElement("span");
      modes.className = "side-modes";
      modes.setAttribute("aria-hidden", "true");
      look.modeGlyphs.forEach((glyph) => modes.append(glyphSpan(glyph)));
      head.append(modes);
    }
    const rows = $("side-rows");
    const newChat = $("new-chat");
    look.rows.forEach((row, index) => {
      if (index === 0) {
        newChat.replaceChildren(
          glyphSpan(row.glyph),
          Object.assign(document.createElement("span"), { textContent: row.label }),
        );
        return;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "side-row";
      button.append(
        glyphSpan(row.glyph),
        Object.assign(document.createElement("span"), { textContent: row.label }),
      );
      button.onclick = () => options.onOpenRemote?.(row.href ?? undefined);
      rows.append(button);
    });
    if (look.account) {
      const account = $("side-account");
      account.hidden = false;
      const button = document.createElement("button");
      button.type = "button";
      const avatar = document.createElement("span");
      avatar.className = "side-avatar";
      avatar.textContent = look.account.initial;
      const name = document.createElement("span");
      name.textContent = look.account.name;
      button.append(avatar, name);
      if (look.account.plan) {
        const plan = document.createElement("span");
        plan.className = "side-plan";
        plan.textContent = ` · ${look.account.plan}`;
        button.append(plan);
      }
      button.onclick = () => options.onOpenRemote?.();
      account.append(button);
    }
    if (look.placeholder) draft.placeholder = look.placeholder;
    if (look.sendGlyph) $("send").querySelector(".glyph").textContent = look.sendGlyph;
    if (look.attachGlyph) $("attach").querySelector(".glyph").textContent = look.attachGlyph;
    for (const { glyph, width } of look.composerControls ?? []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "compose-extra";
      button.style.width = `${width}px`;
      // Their order differs between Claude's two screens, which the stylesheet follows.
      button.dataset.kind = !glyph ? "voice" : width < 20 ? "voice-menu" : "dictate";
      button.setAttribute("aria-label", "在页面模式中使用");
      if (glyph) button.append(glyphSpan(glyph));
      else button.innerHTML = VOICE_ICON;
      button.onclick = () => options.onOpenRemote?.();
      $("compose-extras").append(button);
    }
    $("compose-note").textContent = look.disclaimer || "";
    if (look.recents) {
      $("recents-label").textContent = look.recents.label;
      if (look.recents.caretGlyph)
        $("recents-toggle").append(glyphSpan(look.recents.caretGlyph, "glyph recents-caret"));
      if (look.recents.filterGlyph) {
        const filter = document.createElement("button");
        filter.type = "button";
        filter.className = "recents-filter";
        filter.setAttribute("aria-label", "在页面模式中筛选");
        filter.append(glyphSpan(look.recents.filterGlyph));
        filter.onclick = () => options.onOpenRemote?.();
        $("recents-head").append(filter);
      }
    }
    if (look.account) {
      const account = $("side-account");
      const [menuGlyph, deviceGlyph] = look.accountGlyphs ?? [];
      if (menuGlyph) account.firstElementChild.append(glyphSpan(menuGlyph, "glyph side-menu"));
      if (deviceGlyph) {
        const device = document.createElement("button");
        device.type = "button";
        device.className = "side-device";
        device.setAttribute("aria-label", "在页面模式中打开");
        device.append(glyphSpan(deviceGlyph));
        device.onclick = () => options.onOpenRemote?.();
        account.append(device);
      }
    }
    if (look.projectGlyph) $("compose-project").dataset.glyph = look.projectGlyph;
    if (look.spark) {
      // Only the shape's own numbers go into the new element.
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", look.spark.viewBox);
      svg.setAttribute("aria-hidden", "true");
      svg.style.fill = look.spark.color.startsWith("var(") ? "#d97757" : look.spark.color;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", look.spark.path);
      svg.append(path);
      $("chat-greeting").prepend(svg);
    }
    // Icons need the font; words stay readable without it.
    document.fonts.load("20px Anthropicons-Variable").then(
      (faces) => root.toggleAttribute("data-no-glyphs", faces.length === 0),
      () => root.setAttribute("data-no-glyphs", ""),
    );
  }
  /**
   * Puts the block the page had at its top at the same height here. Older messages keep arriving
   * above it for a while, so this holds until they have all come or the reader scrolls.
   */
  function applyAnchor(list) {
    const anchor = pageView?.anchor;
    if (!anchor || anchorDone) return;
    if (new URL(state.url).pathname !== pageView.path) {
      anchorDone = true;
      return;
    }
    const article = list.children[anchor.message];
    if (!article || article.hidden) return;
    const target =
      (anchor.text &&
        [...article.querySelectorAll(`.text ${ANCHOR_BLOCKS}`)].find(
          (block) => blockStart(block) === anchor.text,
        )) ||
      article;
    // The page's offset is from the top of the page, where this list starts below the title bar.
    const here = target.getBoundingClientRect().top - root.getBoundingClientRect().top;
    list.scrollTop += here - anchor.top;
    following = false;
    if (!state.history) anchorDone = true;
  }
  /** A still copy of part of the page; using it takes the reader to the real thing. */
  function drawReplica(host, replica) {
    host.style.width = `${replica.width}px`;
    host.style.height = `${replica.height}px`;
    host.dataset.takenIn = replica.theme;
    const item = (tag, className, x, y) => {
      const element = document.createElement(tag);
      element.className = className;
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
      host.append(element);
      return element;
    };
    for (const { x, y, w, h, radius, fill, line, shadow, clip } of replica.boxes) {
      const box = item("span", "replica-box", x, y);
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
      box.style.borderRadius = radius;
      if (fill) box.style.background = fill;
      if (line) box.style.border = `1px solid ${line}`;
      if (shadow) box.style.boxShadow = shadow;
      box.style.clipPath = clip;
    }
    for (const { x, y, w, h, src, clip } of replica.images) {
      // Only the page's own proxied images; a copy never reaches out to anywhere else.
      if (!src.startsWith("/s/")) continue;
      const image = item("img", "replica-box", x, y);
      image.alt = "";
      image.width = w;
      image.height = h;
      image.style.clipPath = clip;
      image.src = src;
    }
    for (const { x, y, width, text, size, weight, color, icon, transform } of replica.texts) {
      const span = item("span", icon ? "replica-text replica-icon" : "replica-text", x, y);
      span.style.fontSize = size;
      span.style.fontWeight = weight;
      span.style.color = color;
      if (width) span.style.maxWidth = `${width}px`;
      if (transform) span.style.transform = transform;
      span.textContent = text;
    }
    host.onclick = () => options.onOpenRemote?.();
  }
  /** The sidebar follows Claude's own, which the reader changes from here as well. */
  function setSidebar(open) {
    sidebarWish = open;
    applySidebar();
    fetch(`${apiBase}/sidebar`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ controller, epoch: state?.epoch, open }),
    })
      .then((response) => {
        if (!response.ok) throw new Error();
      })
      .catch(() => transientStatus("这次折叠只在这里生效，页面模式里没有改变"));
  }
  function applySidebar() {
    const remoteClosed = !!state?.surface?.sidebarClosed;
    // The page reports the change a moment later; until then the reader's wish stands.
    if (sidebarWish !== null && sidebarWish === !remoteClosed) sidebarWish = null;
    const closed = sidebarWish === null ? remoteClosed : !sidebarWish;
    root.toggleAttribute("data-sidebar-closed", closed);
    // On a phone the list is a drawer, opened from this same control.
    $("sidebar-show").hidden = !closed && !phone.matches;
  }
  function renderSurface(listIsEmpty) {
    const surface = state.surface;
    applySidebar();
    const isNew = new URL(state.url).pathname === "/new" && listIsEmpty;
    root.toggleAttribute("data-new", isNew);
    const newRow = $("new-chat");
    if (isNew) newRow.setAttribute("aria-current", "page");
    else newRow.removeAttribute("aria-current");
    const greeting = $("chat-greeting");
    greeting.hidden = !isNew || !surface?.greeting;
    $("chat-greeting-text").textContent = surface?.greeting ?? "";
    if (surface?.placeholder && draft.placeholder !== surface.placeholder)
      draft.placeholder = surface.placeholder;
    const project = $("compose-project");
    project.hidden = !isNew || !surface?.project;
    project.textContent = surface?.project ?? "";
    if (project.dataset.glyph)
      project.append(glyphSpan(project.dataset.glyph, "glyph compose-caret"));
    const name = surface?.model || look?.model?.name;
    const effort = surface?.model ? surface.effort : look?.model?.effort;
    const model = $("compose-model");
    model.hidden = !name;
    const label = JSON.stringify([name, effort]);
    if (model.dataset.label !== label) {
      model.dataset.label = label;
      model.textContent = name ?? "";
      if (effort) {
        const part = document.createElement("span");
        part.className = "compose-effort";
        part.textContent = effort;
        model.append(part);
      }
    }
    const mode = $("compose-mode");
    mode.textContent = surface?.mode || look?.mode || "";
    mode.hidden = !mode.textContent;
    const newPage = look?.newPage;
    const below = $("new-below");
    below.hidden = !isNew || !newPage;
    $("new-header").hidden = !isNew || !newPage;
    if (isNew && newPage && !newPageDrawn) {
      newPageDrawn = true;
      drawReplica(below, newPage.below);
      if (newPage.aboveFieldAt !== null) {
        below.style.position = "absolute";
        below.style.top = `${newPage.aboveFieldAt - TITLE_BAR_PX}px`;
        below.style.left = "0";
      }
      drawReplica($("new-header"), newPage.header);
    }
  }
  /** Claude's own model menu, read from the page and acted on there. */
  let modelRows = null;
  function closeModelMenu() {
    $("model-menu").hidden = true;
    $("compose-model").setAttribute("aria-expanded", "false");
  }
  function drawModelMenu(rows, submenu) {
    const menu = $("model-menu");
    menu.replaceChildren(
      ...(submenu
        ? [
            Object.assign(document.createElement("button"), {
              type: "button",
              className: "model-back",
              textContent: `‹ ${submenu}`,
              onclick: () => drawModelMenu(modelRows, null),
            }),
          ]
        : []),
      ...rows.map((row) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "model-row";
        button.setAttribute("role", row.submenu ? "menuitem" : "menuitemradio");
        if (!row.submenu) button.setAttribute("aria-checked", String(row.checked));
        const words = document.createElement("span");
        words.className = "model-words";
        const name = document.createElement("span");
        name.textContent = row.name;
        words.append(name);
        if (row.detail && !row.submenu) {
          const detail = document.createElement("span");
          detail.className = "model-detail";
          detail.textContent = row.detail;
          words.append(detail);
        }
        button.append(words);
        const end = document.createElement("span");
        end.className = "model-end";
        end.textContent = row.submenu ? `${row.detail} ›` : row.checked ? "✓" : "";
        button.append(end);
        button.onclick = () => {
          if (row.submenu) {
            if (row.rows?.length) drawModelMenu(row.rows, row.name);
            else options.onOpenRemote?.();
            return;
          }
          pickModel(submenu, row.name);
        };
        return button;
      }),
    );
  }
  async function pickModel(submenu, name) {
    closeModelMenu();
    modelRows = null;
    try {
      const response = await fetch(`${apiBase}/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          controller,
          epoch: state?.epoch,
          pick: submenu ? { submenu, name } : { name },
        }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
    } catch (error) {
      transientStatus(error.message || "没能切换模型");
    }
  }
  async function openModelMenu() {
    const menu = $("model-menu");
    if (!menu.hidden) {
      closeModelMenu();
      return;
    }
    menu.hidden = false;
    $("compose-model").setAttribute("aria-expanded", "true");
    if (modelRows) {
      drawModelMenu(modelRows, null);
      return;
    }
    menu.replaceChildren(
      Object.assign(document.createElement("div"), {
        className: "model-loading",
        textContent: "正在读取…",
      }),
    );
    try {
      const response = await fetch(`${apiBase}/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ controller, epoch: state?.epoch }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      modelRows = (await response.json()).rows;
      if (!menu.hidden) drawModelMenu(modelRows, null);
    } catch (error) {
      closeModelMenu();
      transientStatus(error.message || "暂时无法读取模型列表");
    }
  }
  /** What surrounded this conversation on the page stays while the reader stays on it. */
  function renderPageFrame() {
    const same = !!pageView && new URL(state.url).pathname === pageView.path;
    const panel = $("chat-panel");
    const header = $("chat-header");
    panel.hidden = !(same && pageView.panel);
    header.hidden = !(same && pageView.header);
    $("chat-title-glyph").textContent = same ? pageView.titleGlyph : "";
    if (!same || pageFrameDrawn) return;
    pageFrameDrawn = true;
    if (pageView.panel) drawReplica(panel, pageView.panel);
    if (pageView.header) drawReplica(header, pageView.header);
  }
  function render() {
    clearTimeout(renderTimer);
    renderTimer = undefined;
    const startedAt = performance.now();
    renderNow();
    if (state) reportLocation();
    lastRenderAt = performance.now();
    lastRenderCost = lastRenderAt - startedAt;
  }
  function renderNow() {
    document.title = state.title || "Claude";
    activateDraft();
    const list = $("messages");
    const keep = new Set();
    for (const [index, message] of state.messages.entries()) {
      const key = `${index}:${message.id}:${message.role}`;
      const streaming =
        state.generating && message.role === "assistant" && index === state.messages.length - 1;
      keep.add(key);
      let entry = messageElements.get(key);
      if (!entry) {
        const article = document.createElement("article");
        article.className = `message ${message.role}`;
        const role = document.createElement("div");
        role.className = "role";
        role.textContent = message.role === "user" ? "你" : "CLAUDE";
        const text = document.createElement("div");
        text.className = "text";
        const copy = document.createElement("button");
        const copyLabel = look?.copyGlyph || "复制文字";
        copy.textContent = copyLabel;
        copy.className = look?.copyGlyph ? "glyph message-copy" : "message-copy";
        copy.setAttribute("aria-label", "复制文字");
        copy.type = "button";
        copy.onclick = async () => {
          copy.className = "message-copy";
          try {
            await navigator.clipboard.writeText(entry?.messageText ?? "");
            copy.textContent = "已复制";
          } catch {
            copy.textContent = "请选中文字复制";
          }
          setTimeout(() => {
            copy.textContent = copyLabel;
            copy.className = look?.copyGlyph ? "glyph message-copy" : "message-copy";
          }, 1500);
        };
        const files = document.createElement("div");
        files.className = "message-files";
        const steps = document.createElement("div");
        steps.className = "message-steps";
        const cards = document.createElement("div");
        cards.className = "message-cards";
        const actions = document.createElement("div");
        actions.className = "message-actions";
        actions.append(copy);
        // Reading aloud, rating and retrying happen on Claude's page.
        if (message.role === "assistant") {
          for (const glyph of look?.replyGlyphs ?? []) {
            const more = document.createElement("button");
            more.type = "button";
            more.className = "glyph message-copy";
            more.setAttribute("aria-label", "在页面模式中使用");
            more.textContent = glyph;
            more.onclick = () => options.onOpenRemote?.();
            actions.append(more);
          }
        }
        article.append(role, steps, text, cards, files, actions);
        entry = {
          article,
          text,
          files,
          steps,
          cards,
          fileSignature: "",
          stepSignature: "",
          cardSignature: "",
        };
        messageElements.set(key, entry);
      }
      entry.article.toggleAttribute("data-streaming", streaming);
      if (list.children[index] !== entry.article)
        list.insertBefore(entry.article, list.children[index] || null);
      // A delta keeps every other message's object, so a long transcript costs nothing here.
      if (entry.message === message && entry.messageText === message.text) continue;
      entry.message = message;
      entry.article.hidden = !!message.pending;
      if (entry.messageText !== message.text) {
        renderChatText(entry.text, message.text, message.role === "assistant");
        entry.messageText = message.text;
      }
      const stepSignature = JSON.stringify(message.steps || []);
      if (entry.stepSignature !== stepSignature) {
        entry.stepSignature = stepSignature;
        renderSteps(entry.steps, message.steps || [], index, message.id);
      }
      const cardSignature = JSON.stringify(message.cards || []);
      if (entry.cardSignature !== cardSignature) {
        entry.cardSignature = cardSignature;
        renderCards(entry.cards, message.cards || [], index);
      }
      const signature = JSON.stringify(message.files || []);
      if (entry.fileSignature !== signature) {
        entry.fileSignature = signature;
        entry.files.replaceChildren(
          ...(message.files || []).map((file) => {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = `↓ ${file.name}`;
            button.onclick = async () => {
              button.disabled = true;
              try {
                const response = await fetch(`${apiBase}/file`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    controller,
                    epoch: state.epoch,
                    message: index,
                    file: file.id,
                  }),
                });
                if (!response.ok) throw new Error((await response.json()).error || "下载失败");
                watchDownloads();
              } catch (error) {
                $("action-status").textContent = error.message || "下载失败";
              } finally {
                button.disabled = false;
              }
            };
            return button;
          }),
        );
      }
    }
    for (const [key, entry] of messageElements)
      if (!keep.has(key)) {
        entry.article.remove();
        messageElements.delete(key);
      }
    const showPending =
      pendingDetails?.type === "send" &&
      pendingDetails.path === draftPath &&
      !state.messages
        .filter((message) => message.role === "user")
        .slice(pendingDetails.priorUsers)
        .some((message) => message.text.trim() === pendingDetails.text.trim());
    if (showPending) {
      pendingArticle.querySelector(".text").textContent = pendingDetails.text;
      if (pendingArticle.parentElement !== list) list.append(pendingArticle);
    } else pendingArticle.remove();
    renderAttachments();
    const history = state.history;
    $("history-status").textContent = history?.stalled
      ? `有 ${history.total - history.loaded} 条较早的消息没有读到，可切换到“页面”模式查看`
      : "";
    applyAnchor(list);
    if (following) list.scrollTop = list.scrollHeight;
    $("jump-latest").hidden = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const notice = $("notice");
    // A page that is still coming up is not ready for a moment, which is nothing to report.
    if (state.ready) {
      clearTimeout(noticeTimer);
      noticeTimer = undefined;
      notice.hidden = true;
    } else if (state.signedOut) {
      clearTimeout(noticeTimer);
      noticeTimer = undefined;
      notice.hidden = false;
      notice.textContent =
        "远程浏览器里的 Claude 已登出。请切换到上方的“页面”模式登录（需要人机验证时用“画面”），登录后回到聊天即可。";
    } else if (notice.hidden && noticeTimer === undefined) {
      noticeTimer = setTimeout(() => {
        noticeTimer = undefined;
        notice.textContent =
          "还没有找到 Claude 的输入框。如果需要登录或验证，请切换到上方的“页面”或“画面”完成，然后回到聊天。";
        notice.hidden = false;
      }, NOTICE_DELAY_MS);
    }
    const conversationList = $("conversations");
    const activePaths = new Set();
    let activeTitle = "";
    state.conversations.forEach((conversation, index) => {
      activePaths.add(conversation.path);
      let button = conversationElements.get(conversation.path);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.dataset.path = conversation.path;
        button.onclick = (event) => {
          // The row's own menu, drawn at its end, is on Claude's page.
          if (
            button.hasAttribute("aria-current") &&
            event.offsetX > button.clientWidth - MORE_AREA_PX
          ) {
            options.onOpenRemote?.();
            return;
          }
          setHistoryOpen(false);
          action("switch", { path: conversation.path });
        };
        if (look?.moreGlyph) button.dataset.more = look.moreGlyph;
        conversationElements.set(conversation.path, button);
      }
      if (button.textContent !== conversation.title) button.textContent = conversation.title;
      const conversationGlyph = look?.conversationGlyphs?.[conversation.path];
      if (conversationGlyph) button.dataset.glyph = conversationGlyph;
      if (new URL(state.url).pathname === conversation.path) {
        button.setAttribute("aria-current", "page");
        activeTitle = conversation.title;
      } else button.removeAttribute("aria-current");
      if (conversationList.children[index] !== button)
        conversationList.insertBefore(button, conversationList.children[index] || null);
    });
    for (const [path, button] of conversationElements) {
      if (!activePaths.has(path)) {
        button.remove();
        conversationElements.delete(path);
      }
    }
    $("chat-title").textContent = activeTitle || (state.title || "").replace(/ [-–—] Claude$/, "");
    renderPageFrame();
    renderSurface(!state.messages.length && !pendingArticle.parentElement);
    controls();
  }
  /**
   * The remote page renders thinking, web search and tool use with the same status row; only its
   * summary says which one it is ("Searched the web, read a page", "Used …", or a thought title).
   */
  const SEARCH_STEP = /search|browse|read (a |\d+ )?pages?|fetch|搜索|浏览|网页|检索/i;
  const TOOL_STEP =
    /^(used|using|ran|running|called|calling|executed|created|creating|edited|editing|viewed|analy[sz]ed|analy[sz]ing|connected|使用|运行|调用|执行|创建|编辑|查看|分析)/i;
  const CARD_ICON =
    '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';
  const STEP_LOADING = "正在加载详细内容…";
  const STEP_UNAVAILABLE = "这一行暂时无法在聊天中展开，可切换到“页面”模式查看。";
  const stepRequests = new Map();
  const STEP_ICONS = {
    search:
      '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    tool: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.6-.7-.7-2.6z"/></svg>',
    thinking:
      '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/></svg>',
  };
  function stepKind(summary) {
    if (SEARCH_STEP.test(summary)) return { id: "search", done: "搜索", active: "搜索中" };
    if (TOOL_STEP.test(summary)) return { id: "tool", done: "工具", active: "工具调用中" };
    return { id: "thinking", done: "思考", active: "思考中" };
  }
  /**
   * Thinking and process rows from the remote page. Their detail exists remotely only while a row
   * is expanded there, so a collapsed row shows its summary and says where to read the rest.
   */
  function renderSteps(container, steps, messageIndex, messageId) {
    const open = new Set(
      [...container.querySelectorAll("details[open]")].map((item) => item.dataset.index),
    );
    container.replaceChildren(
      ...steps.map((step, index) => {
        const kind = stepKind(step.summary || "");
        const details = document.createElement("details");
        details.className = "message-step";
        details.dataset.index = String(index);
        details.dataset.state = step.state || "";
        details.dataset.kind = kind.id;
        if (open.has(String(index))) details.open = true;
        const summary = document.createElement("summary");
        const icon = document.createElement("span");
        icon.className = "message-step-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = STEP_ICONS[kind.id];
        const label = document.createElement("span");
        label.className = "message-step-label";
        label.textContent = step.state && step.state !== "done" ? kind.active : kind.done;
        const title = document.createElement("span");
        title.className = "message-step-title";
        title.textContent = step.summary || "";
        summary.append(icon, label, title);
        const body = document.createElement("div");
        body.className = "message-step-body";
        const key = `${messageId}:${index}`;
        body.textContent =
          step.text || (stepRequests.get(key) === "failed" ? STEP_UNAVAILABLE : STEP_LOADING);
        details.append(summary, body);
        details.addEventListener("toggle", () => {
          if (details.open && !step.text) expandStep(key, messageIndex, index, container);
        });
        return details;
      }),
    );
  }
  /** Documents such as Claude Docs live on the remote page: open them there and show that view. */
  function renderCards(container, cards, messageIndex) {
    container.replaceChildren(
      ...cards.map((card, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "message-card";
        button.disabled = !card.openable;
        const icon = document.createElement("span");
        icon.className = "message-step-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = CARD_ICON;
        const words = document.createElement("span");
        words.className = "message-card-words";
        const title = document.createElement("span");
        title.className = "message-card-title";
        title.textContent = card.title;
        const subtitle = document.createElement("span");
        subtitle.className = "message-card-subtitle";
        subtitle.textContent = card.subtitle;
        words.append(title, subtitle);
        button.append(icon, words);
        button.onclick = async () => {
          button.disabled = true;
          try {
            const response = await fetch(`${apiBase}/card`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                controller,
                epoch: state?.epoch,
                message: messageIndex,
                card: index,
              }),
            });
            if (!response.ok) throw new Error((await response.json()).error);
            options.onOpenRemote?.();
          } catch (error) {
            transientStatus(error.message || "这张卡片暂时无法打开");
          } finally {
            button.disabled = !card.openable;
          }
        };
        return button;
      }),
    );
  }
  /** The detail exists remotely only while a row is open there, so open it once on demand. */
  async function expandStep(key, messageIndex, stepIndex, container) {
    if (stepRequests.has(key)) return;
    stepRequests.set(key, "pending");
    const fail = () => {
      stepRequests.set(key, "failed");
      const body = container.querySelector(`details[data-index="${stepIndex}"] .message-step-body`);
      if (body?.textContent === STEP_LOADING) body.textContent = STEP_UNAVAILABLE;
    };
    try {
      const response = await fetch(`${apiBase}/step`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          controller,
          epoch: state?.epoch,
          message: messageIndex,
          step: stepIndex,
        }),
      });
      if (!response.ok) throw new Error("step unavailable");
      // A row may open empty; do not leave it loading forever.
      setTimeout(fail, 6000);
    } catch {
      fail();
    }
  }
  async function reconcilePending() {
    if (!pending) return;
    const id = pending;
    try {
      const response = await fetch(`${apiBase}/actions/${encodeURIComponent(id)}`, {
        redirect: "error",
      });
      if (!response.ok) return;
      const result = await response.json();
      if (pending !== id || leaving) return;
      if (result.status === "not-started") {
        clearPending();
        $("action-status").textContent = "上次操作尚未执行，草稿已保留，可重新发送。";
        controls();
        return;
      }
      if (result.status === "confirmed" && pendingDetails) {
        confirmPending();
        controls();
        if (state) render();
        return;
      }
      if (result.status === "pending") {
        clearTimeout(reconcileTimer);
        reconcileTimer = setTimeout(reconcilePending, 1000);
      }
      $("action-status").textContent =
        result.status === "confirmed"
          ? "上次操作已在远端确认；草稿保留，请核对后解除待确认状态。"
          : "上次操作结果尚未确认。请在“页面”模式核对；系统不会自动重发。";
    } catch {
      /* A reconnect never resubmits an action. */
    }
  }
  function clearPending() {
    pending = null;
    pendingDetails = null;
    sessionStorage.removeItem(pendingKey);
    persistPendingDetails();
    pendingArticle.remove();
  }
  function confirmPending() {
    if (
      pendingDetails?.type === "send" &&
      draft.value === pendingDetails.text &&
      pendingDetails.path === draftPath
    ) {
      draft.value = "";
      saveDraft();
    }
    if (pendingDetails?.type === "new" && draftPath === "/new") {
      draft.value = "";
      openingNew = false;
      saveDraft();
    }
    clearPending();
  }
  function connect() {
    if (leaving || !sid) {
      connected = false;
      setConnectionText("未打开会话");
      $("notice").hidden = false;
      $("notice").textContent = "会话尚未就绪，请稍候或刷新页面。";
      setRetryVisible(false);
      controls();
      return;
    }
    const query = new URLSearchParams({ connectionKey });
    if (tab) query.set("tab", tab);
    clearTimeout(retry);
    source?.close();
    const currentSource = new EventSource(`${apiBase}/events?${query}`);
    source = currentSource;
    sequence = 0;
    source.onopen = () => {
      if (source !== currentSource) return;
      if (leaving) {
        source.close();
        return;
      }
      connected = true;
      setRetryVisible(false);
      setConnectionText("已连接");
      // Record downloads that finished before this view, so only new ones start automatically.
      if (!downloadsPrimed) void pollDownloads();
      controls();
    };
    source.onmessage = (event) => {
      if (source !== currentSource || leaving) return;
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data.type === "replaced") {
        leaving = true;
        retired = true;
        clearTimeout(retry);
        source.close();
        connected = false;
        controller = null;
        state = null;
        setConnectionText("已由另一页面接管");
        $("notice").hidden = false;
        $("notice").textContent =
          data.message || "另一页面已接管此会话。草稿仍保留，请在新页面继续。";
        controls();
        return;
      }
      if (sequence && data.seq !== sequence + 1) {
        source.close();
        connected = false;
        controls();
        retry = setTimeout(connect, 1000);
        return;
      }
      sequence = data.seq;
      controller = data.controller;
      if (data.type === "snapshot") {
        retryAttempt = 0;
        state = data.state;
        render();
        if (pending && !busy) reconcilePending();
      } else if (data.type === "delta") {
        if (!state || data.epoch !== state.epoch) {
          source.close();
          connected = false;
          controls();
          retry = setTimeout(connect, 1000);
          return;
        }
        for (const change of data.edits) {
          if (change.message) state.messages[change.index] = change.message;
          else {
            const message = state.messages[change.index],
              edit = change.edit;
            if (!message || !edit) continue;
            message.text =
              message.text.slice(0, edit.at) +
              edit.insert +
              message.text.slice(edit.at + edit.delete);
          }
        }
        state.messages.length = data.length;
        Object.assign(state, {
          title: data.title,
          url: data.url,
          signedOut: data.signedOut,
          ready: data.ready,
          draft: data.draft,
          generating: data.generating,
          attachments: data.attachments,
          surface: data.surface,
          history: data.history,
          conversations: data.conversations ?? state.conversations,
        });
        scheduleRender();
      } else if (data.type === "unavailable") {
        state = null;
        $("notice").hidden = false;
        $("notice").textContent = data.message;
        controls();
      }
    };
    source.onerror = () => {
      if (leaving || source !== currentSource) return;
      connected = false;
      controller = null;
      source.close();
      retryAttempt += 1;
      setConnectionText(retryAttempt >= maxRetryAttempts ? "连接失败" : "连接中断，正在重连");
      $("notice").hidden = false;
      $("notice").textContent =
        retryAttempt >= maxRetryAttempts
          ? "暂时无法连接文字聊天。草稿已保留，未确认的操作不会自动重发；可点击“重新连接”再试。"
          : "正在重新连接。草稿已保留，未确认的操作不会自动重发。";
      controls();
      if (retryAttempt >= maxRetryAttempts) {
        setRetryVisible(true);
        return;
      }
      retry = setTimeout(connect, Math.min(15000, 1000 * 2 ** (retryAttempt - 1)));
    };
  }
  async function action(type, extra = {}) {
    if (leaving || !connected || !state || busy || pending || !controller) return;
    saveDraft();
    if (type === "new" || type === "switch") creatingConversation = false;
    if (type === "new") openingNew = true;
    if (type === "send" && draftPath === "/new") creatingConversation = true;
    busy = true;
    const id = crypto.randomUUID();
    const sentText = extra.text;
    pending = id;
    pendingDetails = {
      id,
      type,
      text: sentText,
      path: draftPath,
      priorUsers: state.messages.filter((message) => message.role === "user").length,
    };
    sessionStorage.setItem(pendingKey, id);
    persistPendingDetails();
    $("action-status").textContent = "";
    if (type === "send") {
      following = true;
      render();
    }
    controls();
    const requestController = new AbortController();
    actionController = requestController;
    const actionTimeout = setTimeout(() => requestController.abort(), 20000);
    try {
      const response = await fetch(`${apiBase}/action`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, type, controller, epoch: state.epoch, ...extra }),
        signal: requestController.signal,
      });
      const result = await response.json();
      if (response.ok && result.status === "confirmed") {
        confirmPending();
        cancelUpload();
      } else if (!response.ok) {
        // Precondition failures occur before execution. Preserve the draft either way.
        if (result.started === false || response.status === 400 || response.status === 403) {
          clearPending();
          creatingConversation = false;
          openingNew = false;
        }
        $("action-status").textContent = result.error || "操作未确认，请核对远端页面。";
      } else
        $("action-status").textContent = "操作结果未知。请在“页面”模式核对，系统不会自动重发。";
    } catch {
      $("action-status").textContent = "连接中断，操作结果未知；草稿保留，不会自动重发。";
    } finally {
      clearTimeout(actionTimeout);
      if (actionController === requestController) actionController = null;
      busy = false;
      controls();
      if (state && !leaving) render();
    }
  }
  $("composer").onsubmit = (event) => {
    event.preventDefault();
    if (draft.value.trim() && !$("send").disabled) action("send", { text: draft.value });
  };
  draft.onkeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      $("composer").requestSubmit();
    }
  };
  $("new-chat").onclick = $("mobile-new-chat").onclick = () => {
    setHistoryOpen(false);
    action("new");
  };
  $("stop").onclick = () => action("stop");
  $("resolve-pending").onclick = () => {
    clearPending();
    $("action-status").textContent = "待确认状态已解除，草稿保留。";
    controls();
  };
  $("retry-chat").onclick = () => {
    leaving = false;
    retryAttempt = 0;
    setRetryVisible(false);
    connect();
  };
  listen(window, "pagehide", () => {
    leaving = true;
    connected = false;
    controller = null;
    actionController?.abort();
    clearTimeout(retry);
    clearTimeout(reconcileTimer);
    source?.close();
    saveDraft();
    cancelUpload();
    clearTimeout(downloadTimer);
    downloadTimer = undefined;
    controls();
  });
  listen(window, "pageshow", (event) => {
    if (!event.persisted || retired) return;
    leaving = false;
    retryAttempt = 0;
    if (downloadsWatchedUntil > Date.now()) watchDownloads();
    connect();
    controls();
  });
  function setHistoryOpen(open) {
    root.toggleAttribute("data-history-open", open);
    $("history-toggle").setAttribute("aria-expanded", String(open));
    $("history-backdrop").hidden = !open;
    if (open) $("chat-sidebar").setAttribute("aria-modal", "true");
    else $("chat-sidebar").removeAttribute("aria-modal");
    if (open) $("chat-sidebar").setAttribute("role", "dialog");
    else $("chat-sidebar").removeAttribute("role");
    $("chat-main").inert = open && matchMedia("(max-width:760px)").matches;
    if (open) $("history-close").focus();
  }
  $("history-toggle").onclick = () => setHistoryOpen(!root.hasAttribute("data-history-open"));
  $("history-close").onclick = $("history-backdrop").onclick = () => {
    setHistoryOpen(false);
    $("history-toggle").focus();
  };
  listen(document, "keydown", (event) => {
    if (event.key === "Escape" && root.hasAttribute("data-history-open")) setHistoryOpen(false);
    if (event.key === "Tab" && root.hasAttribute("data-history-open")) {
      const buttons = [...$("chat-sidebar").querySelectorAll("button:not(:disabled), a[href]")];
      const first = buttons[0],
        last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  listen(phone, "change", () => {
    setHistoryOpen(false);
    applySidebar();
  });
  const resizeChat = () => {
    if (window.visualViewport?.scale === 1)
      root.style.setProperty("--chat-height", `${window.visualViewport.height}px`);
    sizeDraft();
    if (following) messages.scrollTop = messages.scrollHeight;
  };
  listen(window.visualViewport, "resize", resizeChat);
  resizeChat();
  applyLook();
  connect();
  controls();

  const transferBase = sid ? `/s/${encodeURIComponent(sid)}` : "";
  function transferStatus(text) {
    $("transfer-status").hidden = false;
    $("cancel-upload").textContent =
      uploadController || preparingUpload || uploadPick ? "取消上传" : "关闭";
    $("upload-status").textContent = text;
  }
  function cancelUpload() {
    prepareController?.abort();
    prepareController = null;
    preparingUpload = false;
    uploadController?.abort();
    uploadController = null;
    if (uploadPick)
      fetch(`${transferBase}/u/${uploadPick.key}`, { method: "DELETE", keepalive: true }).catch(
        () => {},
      );
    uploadPick = null;
    $("file-picker").value = "";
    $("file-picker").hidden = true;
    $("upload-progress").hidden = true;
    $("transfer-status").hidden = true;
  }
  $("cancel-upload").onclick = () => {
    cancelUpload();
    controls();
  };
  $("attach").onclick = async () => {
    cancelUpload();
    preparingUpload = true;
    const preparing = new AbortController();
    prepareController = preparing;
    controls();
    transferStatus("正在准备远端附件输入框…");
    try {
      const response = await fetch(`${transferBase}/uploads/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tab: state?.tab || tab }),
        signal: preparing.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "附件入口尚未就绪");
      if (leaving || preparing.signal.aborted) {
        fetch(`${transferBase}/u/${result.key}`, { method: "DELETE", keepalive: true }).catch(
          () => {},
        );
        return;
      }
      uploadPick = result;
      $("file-picker").multiple = result.multiple;
      $("file-picker").hidden = false;
      transferStatus("选择本机文件，单文件 ≤100 MB，单批 ≤500 MB");
    } catch (error) {
      if (!preparing.signal.aborted) transferStatus(error.message || "附件准备失败");
    } finally {
      if (prepareController === preparing) {
        prepareController = null;
        preparingUpload = false;
      }
      controls();
    }
  };
  $("file-picker").onchange = async (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    if (!files.length || !uploadPick) return;
    const pick = uploadPick;
    uploadController = new AbortController();
    const signal = uploadController.signal;
    controls();
    try {
      const total = files.reduce((sum, file) => sum + file.size, 0);
      if (
        files.length > pick.maxFiles ||
        (!pick.multiple && files.length !== 1) ||
        total > pick.maxTotalBytes ||
        files.some(
          (file) => file.size > pick.maxFileBytes || encodeURIComponent(file.name).length > 2048,
        )
      )
        throw new Error("所选文件超出数量或大小限制，请重新选择");
      let offset = 0;
      $("file-picker").hidden = true;
      $("upload-progress").hidden = false;
      for (const [index, file] of files.entries()) {
        transferStatus(`正在上传 ${file.name}`);
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", `${transferBase}/u/${pick.key}`);
          for (const [key, value] of Object.entries({
            "content-type": "application/octet-stream",
            "x-mirror-file-index": index,
            "x-mirror-file-count": files.length,
            "x-mirror-file-size": file.size,
            "x-mirror-total-size": total,
            "x-mirror-file-name": encodeURIComponent(file.name),
            "x-mirror-file-type": encodeURIComponent(file.type),
          }))
            xhr.setRequestHeader(key, String(value));
          const abort = () => xhr.abort();
          const finish = () => signal.removeEventListener("abort", abort);
          xhr.timeout = 10 * 60 * 1000;
          xhr.upload.onprogress = (event) => {
            $("upload-progress").value = ((offset + event.loaded) / (total || 1)) * 100;
          };
          xhr.onload = () => {
            finish();
            xhr.status >= 200 && xhr.status < 300
              ? resolve()
              : reject(new Error(`上传失败（HTTP ${xhr.status}）`));
          };
          xhr.onerror = xhr.ontimeout = () => {
            finish();
            reject(new Error("上传连接中断，请重新选择文件"));
          };
          xhr.onabort = () => {
            finish();
            reject(new DOMException("已取消", "AbortError"));
          };
          if (signal.aborted) {
            reject(new DOMException("已取消", "AbortError"));
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
          xhr.send(file);
        });
        offset += file.size;
      }
      uploadPick = null;
      $("upload-progress").hidden = true;
      transferStatus(`已上传 ${files.length} 个附件，请等待官网处理完成后发送`);
      $("cancel-upload").textContent = "关闭";
    } catch (error) {
      if (!signal.aborted) {
        transferStatus(error.message || "上传失败");
        fetch(`${transferBase}/u/${pick.key}`, { method: "DELETE" }).catch(() => {});
        uploadPick = null;
      }
    } finally {
      if (uploadController?.signal === signal) uploadController = null;
      controls();
    }
  };
  let downloadRequest = false;
  const finishedAt = new Map();
  let renderedDownloads = "";
  let downloadsPrimed = false;
  /** Refreshes the download list; true while something is in flight or still on screen. */
  async function pollDownloads() {
    if (!connected || leaving || downloadRequest) return false;
    downloadRequest = true;
    try {
      const response = await fetch(`${transferBase}/downloads`, { cache: "no-store" });
      if (!response.ok) return false;
      const entries = await response.json();
      const now = Date.now();
      for (const entry of entries) {
        if (entry.state === "active" || finishedAt.has(entry.id)) continue;
        finishedAt.set(entry.id, now);
        // Hand a download that finishes while this view is open straight to the browser.
        // Ones that finished before the view opened are only offered, never re-downloaded.
        if (downloadsPrimed && entry.state === "done" && entry.href) {
          startClientDownload(entry.href, entry.name);
        }
      }
      downloadsPrimed = true;
      // Finished entries stay briefly as a fallback link, then leave the chat.
      const visible = entries.filter(
        (entry) =>
          entry.state === "active" || now - (finishedAt.get(entry.id) ?? now) < DOWNLOAD_NOTICE_MS,
      );
      const list = $("downloads");
      list.hidden = visible.length === 0;
      // Rebuilding unchanged rows would swap the link out from under a pending click.
      const signature = JSON.stringify(
        visible.map((entry) => [entry.id, entry.state, entry.recv, entry.total, entry.href]),
      );
      if (signature === renderedDownloads) return visible.length > 0;
      renderedDownloads = signature;
      list.replaceChildren(
        ...visible.slice(-10).map((entry) => {
          const row = document.createElement("div");
          const name = document.createElement("span");
          name.textContent = `${entry.name} · ${entry.state === "done" ? "已开始下载" : entry.state === "canceled" ? "已取消" : entry.total > 0 ? Math.round((entry.recv / entry.total) * 100) + "%" : "下载中"}`;
          row.append(name);
          if (entry.state === "done" && entry.href) {
            const save = document.createElement("a");
            save.href = entry.href;
            save.download = entry.name;
            save.textContent = "没有开始？点此下载";
            row.append(save);
          } else if (entry.state === "active") {
            const cancel = document.createElement("button");
            cancel.type = "button";
            cancel.textContent = "取消";
            cancel.onclick = async () => {
              await fetch(`${transferBase}/downloads/${encodeURIComponent(entry.id)}`, {
                method: "DELETE",
              });
              watchDownloads();
            };
            row.append(cancel);
          }
          return row;
        }),
      );
      return visible.length > 0;
    } catch {
      /* The SSE connection status remains authoritative. */
      return false;
    } finally {
      downloadRequest = false;
    }
  }
  // Downloads only start from a file button here, so poll while one may be in flight instead of
  // every few seconds for the whole session.
  let downloadTimer;
  let downloadsWatchedUntil = 0;
  function watchDownloads() {
    downloadsWatchedUntil = Math.max(downloadsWatchedUntil, Date.now() + 15_000);
    if (downloadTimer === undefined) downloadTimer = setTimeout(downloadTick, 1000);
  }
  async function downloadTick() {
    downloadTimer = undefined;
    if (leaving) return;
    const busy = await pollDownloads();
    if (leaving) return;
    if (busy) downloadsWatchedUntil = Math.max(downloadsWatchedUntil, Date.now() + 3000);
    if (Date.now() < downloadsWatchedUntil) downloadTimer = setTimeout(downloadTick, 1500);
  }
  return () => {
    leaving = true;
    clearTimeout(renderTimer);
    retired = true;
    clearTimeout(statusTimer);
    actionController?.abort();
    clearTimeout(retry);
    clearTimeout(reconcileTimer);
    clearTimeout(downloadTimer);
    downloadTimer = undefined;
    source?.close();
    saveDraft();
    cancelUpload();
    for (const cleanup of cleanups.splice(0)) cleanup();
    root.removeAttribute("data-history-open");
    root.replaceChildren();
  };
}
