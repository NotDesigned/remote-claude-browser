import "./chat-view.css";
import { renderChatText } from "./chat-render";
import { CHAT_VIEW_MARKUP } from "./chat-markup";

/**
 * Text chat, mounted inside the unified page. Returns a dispose function that closes the chat
 * stream, stops every timer and removes every global listener, so the page can switch between
 * chat and the browser views without reloading.
 *
 * @param {HTMLElement} root
 * @param {{ sid: string | null, tab?: string | null, connectionKey: string,
 *   onStatus?: (status: { text: string, connected: boolean }) => void,
 *   onOpenBrowser?: () => void }} options
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
  const messageElements = new Map();
  const conversationElements = new Map();
  let draftPath = null;
  let draftKey = null;
  let following = true;
  let creatingConversation = false;
  let openingNew = false;
  let draftEditedBeforeReady = false;
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
    $("resolve-pending").hidden = !pending;
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
    $("generation-status").textContent = busy
      ? "正在提交…"
      : pending
        ? "等待操作确认"
        : state?.generating
          ? "正在生成…"
          : connected && state?.ready
            ? "就绪"
            : "等待同步";
  }
  function setRetryVisible(visible) {
    $("retry-chat").hidden = !visible;
  }
  function render() {
    document.title = state.title || "Claude";
    activateDraft();
    const list = $("messages");
    const keep = new Set();
    for (const [index, message] of state.messages.entries()) {
      const key = `${index}:${message.id}:${message.role}`;
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
        copy.textContent = "复制文字";
        copy.type = "button";
        copy.onclick = async () => {
          try {
            await navigator.clipboard.writeText(entry?.messageText ?? "");
            copy.textContent = "已复制";
          } catch {
            copy.textContent = "请选中文字复制";
          }
        };
        const files = document.createElement("div");
        files.className = "message-files";
        const steps = document.createElement("div");
        steps.className = "message-steps";
        article.append(role, steps, text, files, copy);
        entry = { article, text, files, steps, fileSignature: "", stepSignature: "" };
        messageElements.set(key, entry);
      }
      if (entry.messageText !== message.text) {
        renderChatText(entry.text, message.text, message.role === "assistant");
        entry.messageText = message.text;
      }
      const stepSignature = JSON.stringify(message.steps || []);
      if (entry.stepSignature !== stepSignature) {
        entry.stepSignature = stepSignature;
        renderSteps(entry.steps, message.steps || []);
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
                $("action-status").textContent = "已请求下载，完成后可在下方保存";
                setTimeout(pollDownloads, 1000);
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
      if (list.children[index] !== entry.article)
        list.insertBefore(entry.article, list.children[index] || null);
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
    if (following) list.scrollTop = list.scrollHeight;
    $("jump-latest").hidden = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const notice = $("notice");
    notice.hidden = state.ready;
    notice.textContent = state.signedOut
      ? "远程浏览器里的 Claude 已登出。请切换到上方的“页面”模式登录（需要人机验证时用“画面”），登录后回到聊天即可。"
      : "还没有找到 Claude 的输入框。如果需要登录或验证，请切换到上方的“页面”或“画面”完成，然后回到聊天。";
    const conversationList = $("conversations");
    const activePaths = new Set();
    state.conversations.forEach((conversation, index) => {
      activePaths.add(conversation.path);
      let button = conversationElements.get(conversation.path);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.dataset.path = conversation.path;
        button.onclick = () => {
          setHistoryOpen(false);
          action("switch", { path: conversation.path });
        };
        conversationElements.set(conversation.path, button);
      }
      if (button.textContent !== conversation.title) button.textContent = conversation.title;
      if (new URL(state.url).pathname === conversation.path)
        button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
      if (conversationList.children[index] !== button)
        conversationList.insertBefore(button, conversationList.children[index] || null);
    });
    for (const [path, button] of conversationElements) {
      if (!activePaths.has(path)) {
        button.remove();
        conversationElements.delete(path);
      }
    }
    controls();
  }
  /**
   * The remote page renders thinking, web search and tool use with the same status row; only its
   * summary says which one it is ("Searched the web, read a page", "Used …", or a thought title).
   */
  const SEARCH_STEP = /search|browse|read (a |\d+ )?pages?|fetch|搜索|浏览|网页|检索/i;
  const TOOL_STEP =
    /^(used|using|ran|running|called|calling|executed|created|creating|edited|editing|viewed|analy[sz]ed|analy[sz]ing|connected|使用|运行|调用|执行|创建|编辑|查看|分析)/i;
  function stepKind(summary) {
    if (SEARCH_STEP.test(summary)) return { id: "search", done: "搜索", active: "搜索中" };
    if (TOOL_STEP.test(summary)) return { id: "tool", done: "工具", active: "工具调用中" };
    return { id: "thinking", done: "思考", active: "思考中" };
  }
  /**
   * Thinking and process rows from the remote page. Their detail exists remotely only while a row
   * is expanded there, so a collapsed row shows its summary and says where to read the rest.
   */
  function renderSteps(container, steps) {
    const open = new Set(
      [...container.querySelectorAll("details[open]")].map((item) => item.dataset.index),
    );
    container.replaceChildren(
      ...steps.map((step, index) => {
        const details = document.createElement("details");
        details.className = "message-step";
        details.dataset.index = String(index);
        details.dataset.state = step.state || "";
        if (open.has(String(index))) details.open = true;
        const summary = document.createElement("summary");
        const label = document.createElement("span");
        label.className = "message-step-label";
        const kind = stepKind(step.summary || "");
        details.dataset.kind = kind.id;
        label.textContent = step.state && step.state !== "done" ? kind.active : kind.done;
        const title = document.createElement("span");
        title.className = "message-step-title";
        title.textContent = step.summary || "";
        summary.append(label, title);
        const body = document.createElement("div");
        body.className = "message-step-body";
        body.textContent =
          step.text || "详细内容在远程页面中处于折叠状态，可切换到“页面”模式展开查看。";
        if (!step.text) body.classList.add("message-step-hint");
        details.append(summary, body);
        return details;
      }),
    );
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
    $("action-status").textContent = "远端已确认";
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
          conversations: data.conversations ?? state.conversations,
        });
        render();
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
    $("action-status").textContent = "等待远端确认…";
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
        $("action-status").textContent = "远端已确认";
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
    clearInterval(downloadTimer);
    controls();
  });
  listen(window, "pageshow", (event) => {
    if (!event.persisted || retired) return;
    leaving = false;
    retryAttempt = 0;
    downloadTimer = setInterval(pollDownloads, 4000);
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
  listen(matchMedia("(max-width:760px)"), "change", () => setHistoryOpen(false));
  const resizeChat = () => {
    if (window.visualViewport?.scale === 1)
      root.style.setProperty("--chat-height", `${window.visualViewport.height}px`);
    if (following) messages.scrollTop = messages.scrollHeight;
  };
  listen(window.visualViewport, "resize", resizeChat);
  resizeChat();
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
      $("upload-progress").value = 100;
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
  async function pollDownloads() {
    if (!connected || leaving || downloadRequest) return;
    downloadRequest = true;
    try {
      const response = await fetch(`${transferBase}/downloads`, { cache: "no-store" });
      if (!response.ok) return;
      const entries = await response.json();
      const root = $("downloads");
      root.hidden = entries.length === 0;
      root.replaceChildren(
        ...entries.slice(-10).map((entry) => {
          const row = document.createElement("div");
          const name = document.createElement("span");
          name.textContent = `${entry.name} · ${entry.state === "done" ? "下载完成" : entry.total > 0 ? Math.round((entry.recv / entry.total) * 100) + "%" : "下载中"}`;
          row.append(name);
          if (entry.state === "done" && entry.href) {
            const save = document.createElement("a");
            save.href = entry.href;
            save.download = entry.name;
            save.textContent = "保存文件";
            row.append(save);
          } else {
            const cancel = document.createElement("button");
            cancel.type = "button";
            cancel.textContent = "取消";
            cancel.onclick = async () => {
              await fetch(`${transferBase}/downloads/${encodeURIComponent(entry.id)}`, {
                method: "DELETE",
              });
              pollDownloads();
            };
            row.append(cancel);
          }
          return row;
        }),
      );
    } catch {
      /* The SSE connection status remains authoritative. */
    } finally {
      downloadRequest = false;
    }
  }
  let downloadTimer = setInterval(pollDownloads, 4000);
  return () => {
    leaving = true;
    retired = true;
    actionController?.abort();
    clearTimeout(retry);
    clearTimeout(reconcileTimer);
    clearInterval(downloadTimer);
    source?.close();
    saveDraft();
    cancelUpload();
    for (const cleanup of cleanups.splice(0)) cleanup();
    root.removeAttribute("data-history-open");
    root.replaceChildren();
  };
}
