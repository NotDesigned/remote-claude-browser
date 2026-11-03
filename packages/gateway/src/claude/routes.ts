import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BrowserHandle, BrowserTargetInfo } from "../browser/launch";
import type { TargetRef } from "../types";
import { SECURITY_HEADERS } from "../security-headers";
import { chatDelta, type ChatState } from "./delta";
import { ActionLedger } from "./ledger";
import { observeChat } from "./observe";
import {
  CHAT_EXPRESSION,
  EDITOR_FOCUS_EXPRESSION,
  buttonExpression,
  fileDownloadExpression,
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
  /** Enables latest-page takeover; the caller synchronously revokes this workspace's old WS. */
  takeControl?(): void;
  onControllerChange?(): void;
  /** Lazily creates the session's authoritative page when chat is opened directly. */
  ensureRuntime?(): Promise<void>;
  onNativeViewport?(tab: string): void | Promise<void>;
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
}
interface ActionBody {
  id?: unknown;
  controller?: unknown;
  epoch?: unknown;
  type?: unknown;
  text?: unknown;
  path?: unknown;
}

const CHAT_ACTIVE_POLL_MS = 160;
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
  ): Promise<T> => {
    const result = (await boundedSend(target, "Runtime.evaluate", {
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
  const sample = async (target: TargetRef): Promise<ChatState> => {
    const state = await evaluate<Omit<ChatState, "tab" | "epoch">>(target, CHAT_EXPRESSION);
    if (new URL(state.url).origin !== siteOrigin) throw new Error("请在通用视图打开 Claude");
    return {
      ...state,
      tab: target.targetId,
      epoch: `${boot}:${target.targetId}:${options.documentId(target.targetId)}:${state.url}`,
    };
  };
  const send = (current: Lease, event: Record<string, unknown>) => {
    if (!isCurrent(current)) return;
    if (current.response.writableLength > 512 * 1024) {
      current.response.destroy();
      return;
    }
    const frame = `data: ${JSON.stringify({ ...event, controller: current.id, seq: ++current.seq })}\n\n`;
    metrics.bytes += Buffer.byteLength(frame);
    current.response.write(frame);
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
        options.takeControl();
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
        sampledAt = 0;
      const schedule = (delay: number) => {
        if (!isCurrent(current)) return;
        clearTimeout(timer);
        timer = setTimeout(() => void poll(), delay);
      };
      current.stopWatching = () => {
        clearTimeout(timer);
        observer?.close();
      };
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
                message: "请先在通用视图打开 Claude 并登录，再切换到聊天视图。",
              });
              current.readUnavailable = true;
              lastHeartbeat = Date.now();
            }
          } else {
            const documentKey = `${target.sessionId}:${options.documentId(target.targetId)}`;
            if (preparedSession !== documentKey) {
              await options.onNativeViewport?.(target.targetId);
              if (!canPoll()) return;
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
            const state = await sample(target);
            sampledAt = Date.now();
            metrics.pollStage = "sampled";
            if (!canPoll()) return;
            const change = chatDelta(current.readUnavailable ? undefined : current.state, state);
            current.readUnavailable = false;
            current.state = state;
            if (change) {
              send(current, change);
              if (change.type === "snapshot") metrics.snapshots++;
              else metrics.deltas++;
            }
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
            dirty
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
      try {
        const result = await ledger.run(
          body.id,
          { type: body.type, text, path, epoch: body.epoch },
          async () => {
            metrics.lastActionStage = "checking";
            if (!canAct()) return "not-started";
            let checked: ChatState;
            try {
              checked = await sample(target);
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
                const next = await sample(target);
                if (!canAct()) return false;
                if (body.type === "send") {
                  const beforeCount = state.messages.filter((m) => m.role === "user").length;
                  if (
                    next.messages
                      .filter((m) => m.role === "user")
                      .slice(beforeCount)
                      .some((m) => m.text.trim() === text.trim())
                  )
                    return true;
                } else if (
                  body.type === "stop" ? !next.generating : new URL(next.url).pathname === path
                )
                  return true;
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
      const ok = await evaluate<boolean>(
        target,
        fileDownloadExpression(body.message!, Number(file.id), file.name),
        true,
      );
      if (!ok) return reply.code(409).send({ error: "下载入口已改变，请重试" });
      return reply.code(204).send();
    },
  );

  app.get(apiPath("/metrics"), { preHandler: options.preHandler }, async (_request, reply) =>
    reply.header("cache-control", "no-store").send(metrics),
  );
  return {
    hasController: () => !!lease,
    disconnectController,
    close: () => {
      closed = true;
      disconnectController();
    },
  };
}
