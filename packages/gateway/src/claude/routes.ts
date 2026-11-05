import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BrowserHandle, BrowserTargetInfo } from "../browser/launch";
import type { TargetRef } from "../types";
import { SECURITY_HEADERS } from "../security-headers";
import { chatDelta, type ChatMessage, type ChatState } from "./delta";
import { ActionLedger } from "./ledger";
import { observeChat } from "./observe";
import {
  CHAT_EXPRESSION,
  EDITOR_FOCUS_EXPRESSION,
  MODEL_MENU_COUNT,
  MODEL_TRIGGER_POINT,
  MODE_TRIGGER_POINT,
  editFillExpression,
  editOpenExpression,
  editSaveExpression,
  retryExpression,
  buttonExpression,
  modelMenuExpression,
  modelRowPoint,
  sidebarExpression,
  fileDownloadExpression,
  cardOpenExpression,
  stepExpandExpression,
  attachmentRemoveExpression,
  rowScrollExpression,
  SCROLL_HOME_EXPRESSION,
} from "./extract";

interface Options {
  browser: BrowserHandle;
  profileDir: string;
  preHandler: preHandlerAsyncHookHandler;
  isOwner: (request: IncomingMessage) => boolean;
  mirrorHasController: () => boolean;
  targets: () => TargetRef[];
  metadata: (tab: string) => BrowserTargetInfo | undefined;
  documentId: (tab: string) => number;
  /** For example /s/client-1; the legacy empty prefix keeps /api/claude routes unchanged. */
  routePrefix?: string;
  /**
   * Enables latest-page takeover; the caller synchronously revokes this workspace's old WS.
   * `connectionKey` identifies the page: its own WebSocket is closed but not retired, so the
   * same page can switch between chat and the browser views.
   */
  takeControl?(connectionKey: string): void;
  onControllerChange?(): void;
  /** Lazily creates the session's authoritative page when chat is opened directly. */
  ensureRuntime?(): Promise<void>;
  onNativeViewport?(tab: string): void | Promise<void>;
  /**
   * True when the tab is already wide enough for Claude's desktop layout. Chat then keeps that
   * viewport, so returning to the browser views needs no remote relayout.
   */
  keepsDesktopLayout?(tab: string): boolean;
  testOrigin?: string;
}

interface Lease {
  id: string;
  response: ServerResponse;
  isAuthorized(): boolean;
  connectionKey?: string;
  tab?: string;
  state?: ChatState;
  readUnavailable?: boolean;
  seq: number;
  stopWatching?(): void;
  wake?(): void;
  /** The chat observer's isolated world, where reads use the per-message cache. */
  readContext?(): number | undefined;
  /** Sends being confirmed; reading older rows waits so it cannot look like the new message. */
  acting?: number;
  /** The document whose older rows could not all be read. */
  historyStalledEpoch?: string;
}
const MODEL_MENU_WAIT_MS = 1_500;
const EDIT_STEP_WAIT_MS = 2_000;
const MODEL_MENU_POLL_MS = 50;
const MODEL_MENU_ESCAPE_MS = 400;

interface ClickBody {
  controller?: string;
  epoch?: string;
  message?: number;
  step?: number;
  card?: number;
  attachment?: number;
  name?: string;
  open?: boolean;
}
interface EditBody {
  controller?: string;
  epoch?: string;
  message?: unknown;
  text?: unknown;
  expected?: unknown;
}
interface ModelBody {
  controller?: string;
  epoch?: string;
  /** Which of the composer's menus. */
  menu?: "model" | "mode";
  /** Without one, this lists the menu. A submenu row's name leads to its own rows. */
  pick?: { submenu?: unknown; name?: unknown };
}
interface ActionBody {
  id?: unknown;
  controller?: unknown;
  epoch?: unknown;
  type?: unknown;
  text?: unknown;
  path?: unknown;
}

// Samples reuse the isolated-world cache and re-read only changed messages, so a streaming
// reply can be sampled this often without re-serializing the conversation.
const CHAT_ACTIVE_POLL_MS = 100;
/** Pace of reading older transcript rows, which gives the page time to mount each new range. */
const CHAT_WALK_STEP_MS = 250;
const CHAT_WALK_MAX_STALLS = 20;
const CHAT_IDLE_POLL_MS = 1000;
const CHAT_FALLBACK_POLL_MS = 5000;

export async function registerClaudeChat(app: FastifyInstance, options: Options) {
  const prefix = options.routePrefix ?? "";
  const siteOrigin = options.testOrigin ?? "https://claude.ai";
  if (
    prefix !== "" &&
    (!prefix.startsWith("/") ||
      prefix.startsWith("//") ||
      prefix.endsWith("/") ||
      /[?#]/.test(prefix))
  ) {
    throw new TypeError("routePrefix must be an origin-relative path without a trailing slash");
  }
  const apiPath = (path: string) => `${prefix}/api/claude${path}`;
  const boot = randomUUID();
  const ledger = new ActionLedger(join(options.profileDir, "claude-actions.jsonl"));
  await ledger.load();
  let lease: Lease | undefined;
  let lastConnectionKey: string | undefined;
  let closed = false;
  const retiredConnections = new Set<string>();
  const retire = (connectionKey: string | undefined) => {
    if (connectionKey === undefined) return;
    retiredConnections.add(connectionKey);
    if (retiredConnections.size > 512) {
      const oldest = retiredConnections.values().next().value;
      if (oldest !== undefined) retiredConnections.delete(oldest);
    }
  };
  const replaced = {
    type: "replaced",
    message: "另一页面已接管此会话。此页已停止连接，草稿仍保留在本机。",
  };
  const disconnectController = (reason?: "replaced") => {
    const current = lease;
    lease = undefined;
    if (reason === "replaced") {
      retire(current?.connectionKey ?? lastConnectionKey);
      lastConnectionKey = undefined;
    }
    if (!current) return;
    current.stopWatching?.();
    if (!current.response.destroyed && !current.response.writableEnded) {
      if (reason === "replaced")
        current.response.write(
          `data: ${JSON.stringify({
            ...replaced,
            controller: current.id,
            seq: ++current.seq,
          })}\n\n`,
        );
      current.response.end();
    }
    options.onControllerChange?.();
  };
  const isCurrent = (current: Lease) =>
    !closed &&
    lease === current &&
    current.isAuthorized() &&
    !current.response.destroyed &&
    !current.response.writableEnded;
  const metrics = {
    connections: 0,
    snapshots: 0,
    deltas: 0,
    bytes: 0,
    pollErrors: 0,
    lastActionStage: "idle",
    lastActionFailureStage: "",
    lastRpcError: "",
    pollStage: "idle",
    polls: 0,
  };

  const boundedSend = async (
    target: TargetRef,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        options.browser.send(target.sessionId, method, params),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("远端页面响应超时")), 2500);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      metrics.lastRpcError = method + ": " + String(error);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const evaluate = async <T>(
    target: TargetRef,
    expression: string,
    userGesture = false,
    contextId?: number,
  ): Promise<T> => {
    const result = (await boundedSend(target, "Runtime.evaluate", {
      ...(contextId === undefined ? {} : { contextId }),
      expression,
      timeout: 2000,
      returnByValue: true,
      awaitPromise: false,
      userGesture,
      silent: true,
    })) as { result?: { value?: T }; exceptionDetails?: unknown };
    if (result.exceptionDetails || !result.result || !("value" in result.result))
      throw new Error("页面暂不可读取");
    return result.result.value as T;
  };
  const targetFor = (tab?: string): TargetRef | undefined =>
    options.targets().find((target) => {
      if (target.type !== "page" || (tab && target.targetId !== tab)) return false;
      try {
        return new URL(options.metadata(target.targetId)?.url || "").origin === siteOrigin;
      } catch {
        return false;
      }
    });
  let transcript: { epoch: string; messages: ChatMessage[] } | undefined;
  const sample = async (target: TargetRef, lease?: Lease): Promise<ChatState> => {
    const contextId = lease?.readContext?.();
    let state: Omit<ChatState, "tab" | "epoch">;
    try {
      state = await evaluate(target, CHAT_EXPRESSION, false, contextId);
    } catch (error) {
      // A navigation can retire the isolated world before the observer reinstalls it.
      if (contextId === undefined) throw error;
      state = await evaluate(target, CHAT_EXPRESSION);
    }
    if (new URL(state.url).origin !== siteOrigin) throw new Error("请在“页面”模式打开 Claude");
    const epoch = `${boot}:${target.targetId}:${options.documentId(target.targetId)}:${state.url}`;
    // Rows read earlier stay known after they unmount, also across chat reconnects.
    const known = transcript?.epoch === epoch ? transcript.messages : [];
    const messages = state.messages.map((message, index) =>
      message.pending && known[index] && !known[index].pending ? known[index] : message,
    );
    transcript = { epoch, messages };
    const unread = messages.filter((message) => message.pending).length;
    return {
      ...state,
      messages,
      tab: target.targetId,
      epoch,
      ...(unread
        ? {
            history: {
              loaded: messages.length - unread,
              total: messages.length,
              ...(lease?.historyStalledEpoch === epoch ? { stalled: true } : {}),
            },
          }
        : {}),
    };
  };
  /** Mounts a virtualized row so a control inside it can be clicked. */
  const mountRow = async (target: TargetRef, row: number): Promise<void> => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await evaluate<string>(target, rowScrollExpression(row));
      if (result !== "moved") return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };
  const send = (current: Lease, event: Record<string, unknown>) => {
    if (!isCurrent(current)) return;
    // A long transcript is one large snapshot; a slow phone link must not lose it for that.
    if (current.response.writableLength > 8 * 1024 * 1024) {
      current.response.destroy();
      return;
    }
    const frame = `data: ${JSON.stringify({ ...event, controller: current.id, seq: ++current.seq })}\n\n`;
    metrics.bytes += Buffer.byteLength(frame);
    current.response.write(frame);
  };
  const publishState = (current: Lease, state: ChatState) => {
    if (!isCurrent(current)) return;
    const change = chatDelta(current.readUnavailable ? undefined : current.state, state);
    current.readUnavailable = false;
    current.state = state;
    if (change) {
      send(current, change);
      if (change.type === "snapshot") metrics.snapshots++;
      else metrics.deltas++;
    }
  };

  app.get<{ Querystring: { tab?: string; connectionKey?: string } }>(
    apiPath("/events"),
    { preHandler: options.preHandler },
    async (request, reply) => {
      if (!options.isOwner(request.raw)) return reply.code(403).send({ error: "需要主控权限" });
      try {
        await options.ensureRuntime?.();
      } catch {
        return reply.code(503).send({ error: "远端 Claude 页面尚未准备好，请稍后重试" });
      }
      const connectionKey = request.query.connectionKey;
      if (options.takeControl !== undefined) {
        if (
          typeof connectionKey !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(connectionKey) ||
          retiredConnections.has(connectionKey)
        ) {
          return reply
            .type("text/event-stream")
            .header("cache-control", "no-store")
            .header("x-accel-buffering", "no")
            .send(`data: ${JSON.stringify(replaced)}\n\n`);
        }
        // A network retry for the same page replaces only its old transport. A different page
        // retires the old key so delayed retries cannot take control back from the new page.
        if (lastConnectionKey !== connectionKey) retire(lastConnectionKey);
        if (lease)
          disconnectController(lease.connectionKey === connectionKey ? undefined : "replaced");
        lastConnectionKey = connectionKey;
        options.takeControl(connectionKey);
      } else if (lease || options.mirrorHasController()) {
        return reply.code(409).send({ error: "请先关闭其他控制页面，再连接聊天视图" });
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      });
      const current: Lease = {
        id: randomUUID(),
        response: reply.raw,
        isAuthorized: () => options.isOwner(request.raw),
        connectionKey,
        tab: request.query.tab,
        seq: 0,
      };
      lease = current;
      options.onControllerChange?.();
      metrics.connections++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let lastHeartbeat = Date.now();
      let preparedSession: string | undefined;
      let observer: ReturnType<typeof observeChat> | undefined;
      let polling = false,
        dirty = false,
        walking = false,
        sampledAt = 0;
      const schedule = (delay: number) => {
        if (!isCurrent(current)) return;
        clearTimeout(timer);
        timer = setTimeout(() => void poll(), delay);
      };
      /** Reads older transcript rows, one remote scroll per poll, then scrolls back. */
      let walk = { epoch: "", loaded: 0, stalled: 0, at: 0, moved: false, gaveUp: false };
      let walkTarget: TargetRef | undefined;
      const returnHome = async () => {
        const contextId = observer?.contextId();
        if (!walk.moved || !walkTarget || contextId === undefined) return;
        walk.moved = false;
        await evaluate(walkTarget, SCROLL_HOME_EXPRESSION, false, contextId).catch(() => {});
      };
      const walkHistory = async (target: TargetRef, state: ChatState): Promise<boolean> => {
        if (walk.epoch !== state.epoch)
          walk = { epoch: state.epoch, loaded: 0, stalled: 0, at: 0, moved: false, gaveUp: false };
        const contextId = observer?.contextId();
        const row = state.messages.map((message) => !!message.pending).lastIndexOf(true);
        if (
          row < 0 ||
          walk.gaveUp ||
          state.generating ||
          current.acting ||
          contextId === undefined
        ) {
          await returnHome();
          return false;
        }
        if (Date.now() - walk.at < CHAT_WALK_STEP_MS) return true;
        walk.at = Date.now();
        const loaded = state.history?.loaded ?? 0;
        walk.stalled = loaded > walk.loaded ? 0 : walk.stalled + 1;
        walk.loaded = Math.max(walk.loaded, loaded);
        const result =
          walk.stalled > CHAT_WALK_MAX_STALLS
            ? "none"
            : await evaluate<string>(target, rowScrollExpression(row), false, contextId).catch(
                () => "moved",
              );
        if (result === "none") {
          walk.gaveUp = true;
          current.historyStalledEpoch = state.epoch;
          await returnHome();
          current.wake?.();
          return false;
        }
        walkTarget = target;
        walk.moved = true;
        return true;
      };
      current.stopWatching = () => {
        clearTimeout(timer);
        void returnHome();
        observer?.close();
      };
      current.readContext = () => observer?.contextId();
      current.wake = () => {
        dirty = true;
        if (!polling) schedule(Math.max(0, CHAT_ACTIVE_POLL_MS - (Date.now() - sampledAt)));
      };
      const canPoll = () => {
        if (isCurrent(current)) return true;
        if (lease === current) disconnectController();
        return false;
      };
      const poll = async () => {
        if (polling) {
          dirty = true;
          return;
        }
        polling = true;
        dirty = false;
        metrics.polls++;
        metrics.pollStage = "checking";
        if (!canPoll()) {
          metrics.pollStage = "closed";
          polling = false;
          return;
        }
        try {
          const target = targetFor(current.tab);
          if (!target) {
            if (Date.now() - lastHeartbeat > 3000 || current.seq === 0) {
              send(current, {
                type: "unavailable",
                message:
                  "远程浏览器还没有打开 Claude，或需要登录。请切换到“页面”模式打开并登录，然后回到聊天。",
              });
              current.readUnavailable = true;
              lastHeartbeat = Date.now();
            }
          } else {
            const documentKey = `${target.sessionId}:${options.documentId(target.targetId)}`;
            if (preparedSession !== documentKey) {
              await options.onNativeViewport?.(target.targetId);
              if (!canPoll()) return;
              if (!options.keepsDesktopLayout?.(target.targetId))
                await boundedSend(target, "Emulation.setDeviceMetricsOverride", {
                  width: 1280,
                  height: 800,
                  deviceScaleFactor: 1,
                  mobile: false,
                });
              await boundedSend(target, "Page.bringToFront", {});
              preparedSession = documentKey;
              observer?.close();
              observer = observeChat(
                options.browser,
                target,
                () => current.wake?.(),
                (error) => {
                  metrics.lastRpcError = "Chat observer: " + String(error);
                },
              );
            }
            metrics.pollStage = "sample";
            const state = await sample(target, current);
            sampledAt = Date.now();
            metrics.pollStage = "sampled";
            if (!canPoll()) return;
            publishState(current, state);
            walking = await walkHistory(target, state);
          }
        } catch (error) {
          metrics.pollErrors++;
          metrics.pollStage = "failed: " + String(error);
          if (canPoll() && !current.readUnavailable) {
            current.readUnavailable = true;
            send(current, {
              type: "unavailable",
              message: "远端页面正在加载，等待恢复同步。草稿保留在本机。",
            });
          }
        }
        polling = false;
        if (!canPoll()) return;
        if (Date.now() - lastHeartbeat > 10000) {
          reply.raw.write(": heartbeat\n\n");
          lastHeartbeat = Date.now();
        }
        if (lease === current && !closed)
          schedule(
            walking
              ? CHAT_WALK_STEP_MS
              : dirty
                ? CHAT_ACTIVE_POLL_MS
                : observer?.available()
                  ? CHAT_FALLBACK_POLL_MS
                  : CHAT_IDLE_POLL_MS,
          );
      };
      reply.raw.on("close", () => {
        current.stopWatching?.();
        if (lease === current) {
          lease = undefined;
          options.onControllerChange?.();
        }
      });
      void poll();
    },
  );

  app.get<{ Params: { id: string } }>(
    apiPath("/actions/:id"),
    { preHandler: options.preHandler },
    async (request, reply) => {
      if (!options.isOwner(request.raw)) return reply.code(403).send({ error: "需要主控权限" });
      reply.header("cache-control", "no-store");
      const action = ledger.get(request.params.id);
      return action
        ? { id: action.id, status: action.status }
        : { id: request.params.id, status: "unknown" };
    },
  );

  app.post<{ Body: ActionBody }>(
    apiPath("/action"),
    { preHandler: options.preHandler, bodyLimit: 256 * 1024 },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const origin = process.env.MIRROR_PUBLIC_ORIGIN;
      if (!options.isOwner(request.raw) || (origin && request.headers.origin !== origin))
        return reply.code(403).send({ error: "操作来源或权限无效", started: false });
      const body = request.body || {};
      if (
        typeof body.id !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(body.id) ||
        !["send", "stop", "new", "switch"].includes(String(body.type))
      )
        return reply.code(400).send({ error: "操作格式无效", started: false });
      if (!lease || body.controller !== lease.id || !lease.state || options.mirrorHasController())
        return reply.code(409).send({ error: "当前页面未持有控制权", started: false });
      const current = lease;
      current.wake?.();
      const target = targetFor(current.state!.tab);
      if (!target) return reply.code(409).send({ error: "远端页面已改变", started: false });
      const actionDeadline = Date.now() + 15000;
      const canAct = () =>
        Date.now() < actionDeadline &&
        !reply.raw.destroyed &&
        isCurrent(current) &&
        !options.mirrorHasController() &&
        targetFor(current.state!.tab)?.sessionId === target.sessionId;
      let state = current.state!;
      if (!canAct() || body.epoch !== state.epoch)
        return reply.code(409).send({ error: "页面已切换，请等待同步后操作", started: false });
      if (
        body.type === "send" &&
        (typeof body.text !== "string" ||
          !body.text.trim() ||
          body.text.length > 100000 ||
          !state.ready ||
          state.generating)
      )
        return reply.code(409).send({ error: "输入无效，或远端尚未准备好", started: false });
      if (
        body.type === "switch" &&
        (typeof body.path !== "string" || !/^\/chat\/[a-zA-Z0-9-]+$/.test(body.path))
      )
        return reply.code(400).send({ error: "会话路径无效", started: false });
      const text = typeof body.text === "string" ? body.text : "";
      const path = body.type === "switch" ? (body.path as string) : "/new";
      current.acting = (current.acting ?? 0) + 1;
      try {
        const result = await ledger.run(
          body.id,
          { type: body.type, text, path, epoch: body.epoch },
          async () => {
            metrics.lastActionStage = "checking";
            if (!canAct()) return "not-started";
            let checked: ChatState;
            try {
              checked = await sample(target, current);
            } catch {
              return "not-started";
            }
            if (!canAct() || checked.epoch !== state.epoch) return "not-started";
            if (body.type === "stop" && !checked.generating) return true;
            if (body.type === "send" && (!checked.ready || checked.generating))
              return "not-started";
            state = checked;
            metrics.lastActionStage = "ready";
            if (body.type === "new" || body.type === "switch") {
              await options.browser.send(target.sessionId, "Page.navigate", {
                url: `${siteOrigin}${path}`,
              });
            } else {
              if (body.type === "send") {
                metrics.lastActionStage = "focus";
                await options.browser.send(target.sessionId, "Emulation.setFocusEmulationEnabled", {
                  enabled: true,
                });
                const focused = await evaluate<boolean>(target, EDITOR_FOCUS_EXPRESSION);
                if (!canAct() || !focused) return false;
                metrics.lastActionStage = "insert";
                await options.browser.send(target.sessionId, "Input.insertText", { text });
                if (!canAct()) return false;
              }
              metrics.lastActionStage = "click";
              let clicked = false;
              const buttonDeadline = Date.now() + 3000;
              while (canAct() && Date.now() < buttonDeadline && !clicked) {
                clicked = await evaluate<boolean>(
                  target,
                  buttonExpression(body.type === "send" ? "send" : "stop", true),
                  true,
                );
                if (!clicked) await new Promise((resolve) => setTimeout(resolve, 75));
              }
              if (!canAct() || !clicked) return false;
            }
            metrics.lastActionStage = "confirm";
            const deadline = Date.now() + 6000;
            let nextStopClickAt = Date.now() + 500;
            while (Date.now() < deadline) {
              if (!canAct()) return false;
              try {
                const next = await sample(target, current);
                if (!canAct()) return false;
                if (body.type === "send") {
                  const beforeCount = state.messages.filter((m) => m.role === "user").length;
                  if (
                    next.messages
                      .filter((m) => m.role === "user")
                      .slice(beforeCount)
                      .some((m) => m.text.trim() === text.trim())
                  ) {
                    publishState(current, next);
                    return true;
                  }
                } else if (
                  body.type === "stop" ? !next.generating : new URL(next.url).pathname === path
                ) {
                  publishState(current, next);
                  return true;
                }
                // The site's stop handler can still be initializing when its button appears.
                // Reassert this pending stop only in the same document. Sends are never repeated.
                if (
                  body.type === "stop" &&
                  next.epoch === state.epoch &&
                  Date.now() >= nextStopClickAt
                ) {
                  await evaluate<boolean>(target, buttonExpression("stop", true), true);
                  nextStopClickAt = Date.now() + 500;
                }
              } catch {
                /* Navigation may be replacing the execution context. */
              }
              await new Promise((resolve) => setTimeout(resolve, 150));
            }
            return false;
          },
        );
        if (result.status !== "confirmed") metrics.lastActionFailureStage = metrics.lastActionStage;
        metrics.lastActionStage = result.status;
        if (result.status === "not-started")
          return reply.code(503).send({
            id: result.id,
            status: result.status,
            started: false,
            error: "远端页面尚未准备好，请稍后重试发送",
          });
        return { id: result.id, status: result.status };
      } catch {
        return reply.code(409).send({ error: "操作记录冲突或存储不可用，请核对远端页面" });
      } finally {
        current.acting! -= 1;
        current.wake?.();
      }
    },
  );

  app.post<{ Body: { controller?: string; epoch?: string; message?: number; file?: string } }>(
    apiPath("/file"),
    { preHandler: options.preHandler, bodyLimit: 4096 },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const origin = process.env.MIRROR_PUBLIC_ORIGIN;
      if (!options.isOwner(request.raw) || (origin && request.headers.origin !== origin))
        return reply.code(403).send({ error: "权限无效" });
      const body = request.body ?? {};
      const current = lease;
      if (!current?.state || body.controller !== current.id || options.mirrorHasController())
        return reply.code(409).send({ error: "请等待文字聊天重新连接" });
      const target = targetFor(current.state.tab);
      if (!target || !Number.isSafeInteger(body.message) || body.message! < 0)
        return reply.code(400).send({ error: "文件参数无效" });
      const state = await sample(target);
      const file = state.messages[body.message!]?.files?.find((item) => item.id === body.file);
      if (
        !isCurrent(current) ||
        options.mirrorHasController() ||
        body.epoch !== state.epoch ||
        !file
      )
        return reply.code(409).send({ error: "文件列表已改变，请重试" });
      await mountRow(target, body.message!);
      const ok = await evaluate<boolean>(
        target,
        fileDownloadExpression(body.message!, Number(file.id), file.name),
        true,
      );
      if (!ok) return reply.code(409).send({ error: "下载入口已改变，请重试" });
      return reply.code(204).send();
    },
  );

  /** Clicks one control on the remote page, for the current controller only. */
  const remoteClickRoute = (
    path: string,
    click: (body: ClickBody) => { row?: number; expression: string } | undefined,
    unavailable: string,
  ) =>
    app.post<{ Body: ClickBody }>(
      apiPath(path),
      { preHandler: options.preHandler, bodyLimit: 4096 },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        const origin = process.env.MIRROR_PUBLIC_ORIGIN;
        if (!options.isOwner(request.raw) || (origin && request.headers.origin !== origin))
          return reply.code(403).send({ error: "权限无效" });
        const body = request.body ?? {};
        const current = lease;
        if (!current?.state || body.controller !== current.id || options.mirrorHasController())
          return reply.code(409).send({ error: "请等待文字聊天重新连接" });
        const target = targetFor(current.state.tab);
        const action = click(body);
        if (!target || !action) return reply.code(400).send({ error: "参数无效" });
        if (body.epoch !== current.state.epoch)
          return reply.code(409).send({ error: "页面已切换，请重试" });
        const ok = await (async () => {
          if (action.row !== undefined) await mountRow(target, action.row);
          return evaluate<boolean>(target, action.expression, true);
        })().catch(() => false);
        if (!ok) return reply.code(409).send({ error: unavailable });
        current.wake?.();
        return reply.code(204).send();
      },
    );
  const isIndex = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0;
  remoteClickRoute(
    "/step",
    ({ message, step }) =>
      isIndex(message) && isIndex(step)
        ? { row: message, expression: stepExpandExpression(message, step) }
        : undefined,
    "这一行没有可展开的内容",
  );
  remoteClickRoute(
    "/card",
    ({ message, card }) =>
      isIndex(message) && isIndex(card)
        ? { row: message, expression: cardOpenExpression(message, card) }
        : undefined,
    "这张卡片暂时无法打开",
  );
  remoteClickRoute(
    "/retry",
    ({ message }) =>
      isIndex(message) ? { row: message, expression: retryExpression(message) } : undefined,
    "暂时无法重试，请到“页面”模式操作",
  );
  remoteClickRoute(
    "/sidebar",
    ({ open }) => (typeof open === "boolean" ? { expression: sidebarExpression(open) } : undefined),
    "暂时无法折叠对话列表",
  );
  remoteClickRoute(
    "/attachment",
    ({ attachment, name }) =>
      isIndex(attachment) && typeof name === "string" && name.length <= 200
        ? { expression: attachmentRemoveExpression(attachment, name) }
        : undefined,
    "附件列表已改变，请重试",
  );

  app.post<{ Body: EditBody }>(
    apiPath("/edit"),
    { preHandler: options.preHandler, bodyLimit: 256 * 1024 },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const origin = process.env.MIRROR_PUBLIC_ORIGIN;
      if (!options.isOwner(request.raw) || (origin && request.headers.origin !== origin))
        return reply.code(403).send({ error: "权限无效" });
      const body = request.body ?? {};
      const current = lease;
      if (!current?.state || body.controller !== current.id || options.mirrorHasController())
        return reply.code(409).send({ error: "请等待文字聊天重新连接" });
      const target = targetFor(current.state.tab);
      const { message, text, expected } = body;
      if (
        !target ||
        !isIndex(message) ||
        typeof text !== "string" ||
        !text.trim() ||
        text.length > 100_000 ||
        typeof expected !== "string"
      )
        return reply.code(400).send({ error: "参数无效" });
      if (body.epoch !== current.state.epoch)
        return reply.code(409).send({ error: "页面已切换，请重试" });
      if (current.state.generating)
        return reply.code(409).send({ error: "请等待 Claude 回复完成后再编辑" });
      const until = async (expression: string): Promise<boolean> => {
        const deadline = Date.now() + EDIT_STEP_WAIT_MS;
        while (Date.now() < deadline) {
          if (await evaluate<boolean>(target, expression, true)) return true;
          await new Promise((resolve) => setTimeout(resolve, MODEL_MENU_POLL_MS));
        }
        return false;
      };
      const unavailable = "没能提交编辑，请到“页面”模式操作";
      try {
        await mountRow(target, message);
        const done =
          (await until(editOpenExpression(message, expected))) &&
          (await until(editFillExpression(message, text))) &&
          (await until(editSaveExpression(message)));
        if (!done) return reply.code(409).send({ error: unavailable });
        current.wake?.();
        return reply.code(204).send();
      } catch {
        return reply.code(409).send({ error: unavailable });
      }
    },
  );

  /** Claude's menu only opens to a real press, and closes with Escape. */
  const pressAt = async (target: TargetRef, point: string): Promise<boolean> => {
    const at = await evaluate<{ x: number; y: number } | null>(target, point, true);
    if (!at) return false;
    const press = { ...at, button: "left", clickCount: 1 };
    await boundedSend(target, "Input.dispatchMouseEvent", { ...at, type: "mouseMoved" });
    await boundedSend(target, "Input.dispatchMouseEvent", {
      ...press,
      type: "mousePressed",
      buttons: 1,
    });
    await boundedSend(target, "Input.dispatchMouseEvent", { ...press, type: "mouseReleased" });
    return true;
  };
  const untilMenus = async (target: TargetRef, count: number): Promise<boolean> => {
    const deadline = Date.now() + MODEL_MENU_WAIT_MS;
    while (Date.now() < deadline) {
      if ((await evaluate<number>(target, MODEL_MENU_COUNT)) >= count) return true;
      await new Promise((resolve) => setTimeout(resolve, MODEL_MENU_POLL_MS));
    }
    return false;
  };
  /** A closing menu stays in the DOM for its animation, where a press would miss it. */
  const closeMenus = async (target: TargetRef): Promise<void> => {
    const deadline = Date.now() + MODEL_MENU_WAIT_MS;
    let lastEscape = 0;
    while (Date.now() < deadline) {
      if ((await evaluate<number>(target, MODEL_MENU_COUNT)) === 0) return;
      if (Date.now() - lastEscape > MODEL_MENU_ESCAPE_MS) {
        lastEscape = Date.now();
        const key = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };
        await boundedSend(target, "Input.dispatchKeyEvent", { ...key, type: "rawKeyDown" });
        await boundedSend(target, "Input.dispatchKeyEvent", { ...key, type: "keyUp" });
      }
      await new Promise((resolve) => setTimeout(resolve, MODEL_MENU_POLL_MS));
    }
    throw new Error("模型菜单没有关闭");
  };
  interface ModelRow {
    name: string;
    detail: string;
    checked: boolean;
    submenu: boolean;
    rows?: ModelRow[];
  }
  app.post<{ Body: ModelBody }>(
    apiPath("/model"),
    { preHandler: options.preHandler, bodyLimit: 4096 },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const origin = process.env.MIRROR_PUBLIC_ORIGIN;
      if (!options.isOwner(request.raw) || (origin && request.headers.origin !== origin))
        return reply.code(403).send({ error: "权限无效" });
      const body = request.body ?? {};
      const current = lease;
      if (!current?.state || body.controller !== current.id || options.mirrorHasController())
        return reply.code(409).send({ error: "请等待文字聊天重新连接" });
      const target = targetFor(current.state.tab);
      if (!target) return reply.code(400).send({ error: "参数无效" });
      if (body.epoch !== current.state.epoch)
        return reply.code(409).send({ error: "页面已切换，请重试" });
      const { pick } = body;
      const trigger = body.menu === "mode" ? MODE_TRIGGER_POINT : MODEL_TRIGGER_POINT;
      if (
        pick !== undefined &&
        (typeof pick.name !== "string" ||
          pick.name.length > 200 ||
          (pick.submenu !== undefined &&
            (typeof pick.submenu !== "string" || pick.submenu.length > 200)))
      )
        return reply.code(400).send({ error: "参数无效" });
      const unavailable = pick ? "没能切换，请到“页面”模式选择" : "暂时无法读取模型列表";
      try {
        await options.browser.send(target.sessionId, "Emulation.setFocusEmulationEnabled", {
          enabled: true,
        });
        await closeMenus(target);
        if (!(await pressAt(target, trigger)) || !(await untilMenus(target, 1)))
          return reply.code(409).send({ error: unavailable });
        if (pick) {
          const depth = pick.submenu === undefined ? 0 : 1;
          if (typeof pick.submenu === "string") {
            const opened =
              (await pressAt(target, modelRowPoint(0, pick.submenu))) &&
              (await untilMenus(target, 2));
            if (!opened) return reply.code(409).send({ error: unavailable });
          }
          if (!(await pressAt(target, modelRowPoint(depth, pick.name as string))))
            return reply.code(409).send({ error: unavailable });
          current.wake?.();
          return reply.code(204).send();
        }
        const rows = (await evaluate<ModelRow[] | null>(target, modelMenuExpression(0))) ?? [];
        for (const row of rows) {
          if (!row.submenu) continue;
          const opened =
            (await pressAt(target, modelRowPoint(0, row.name))) && (await untilMenus(target, 2));
          if (opened) row.rows = (await evaluate<ModelRow[]>(target, modelMenuExpression(1))) ?? [];
          await closeMenus(target);
          if (!(await pressAt(target, trigger)) || !(await untilMenus(target, 1))) break;
        }
        return reply.send({ rows });
      } catch {
        return reply.code(409).send({ error: unavailable });
      } finally {
        await closeMenus(target).catch(() => undefined);
      }
    },
  );

  app.get(apiPath("/metrics"), { preHandler: options.preHandler }, async (_request, reply) =>
    reply.header("cache-control", "no-store").send(metrics),
  );
  return {
    hasController: () => !!lease,
    disconnectController,
    /**
     * A browser-view WebSocket took over. The same page (same key) simply leaves chat; any other
     * page retires this chat connection for good.
     */
    yieldTo(connectionKey: string | undefined) {
      const sameKey =
        connectionKey !== undefined &&
        connectionKey === (lease?.connectionKey ?? lastConnectionKey);
      disconnectController(sameKey ? undefined : "replaced");
    },
    close: () => {
      closed = true;
      disconnectController();
    },
  };
}
