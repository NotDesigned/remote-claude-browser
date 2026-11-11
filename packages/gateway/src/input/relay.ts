/**
 * Gateway input dispatch.
 * The same relay handles IME composition and clipboard paste through CDP.
 *
 * DOM pointer coordinates are resolved against the live recorder mirror. Each lookup waits for the
 * page's main thread, so a node of the top document is asked for its rect at once and only a node
 * of another frame is resolved through the frames first. A hover reuses a rect for a moment, and a
 * click's release reuses the rect its press found on the same node, as a hand that stays put
 * would; a drag looks again. Pixel pointers carry the node-less sentinel and use their negotiated
 * viewport coordinates directly.
 */
import { Mod, NODE_IN_FRAME_ERROR, type RectResult, type Up } from "@mirror/protocol";
import { resolveNode, type FrameHop, type ResolveNodeDeps } from "../browser/resolvenode";
import type { AgentLink, CdpSend } from "../types";
import { describeKey } from "./keymap";

const DEFAULT_RECT_TIMEOUT_MS = 100;
/** A release this soon after its press, on the same node, lands where the press did. */
const PRESS_RECT_REUSE_MS = 1_000;
/**
 * Scrolls carry the absolute position, so a later one replaces an earlier one. Waiting longer for
 * a busy page only holds up the input queued behind it.
 */
const SCROLL_TIMEOUT_MS = 1_000;
const IFRAME_EDGE_INSET_PX = 0.01;

export interface InputRelayDeps {
  agentLink: AgentLink;
  send: CdpSend;
  /** Private recorder bridge used for DOM RemoteObjects without a page-global helper. */
  callBridge?: ResolveNodeDeps["callBridge"];
  callFrame?: ResolveNodeDeps["callFrame"];
  /** Live targetId -> CDP sessionId resolution comes from the browser TargetRegistry. */
  sessionFor(targetId: string): string | undefined;
  /** Role state is injected by the WS/roles composition; non-drivers are always rejected. */
  isDriver(viewerId: string): boolean;
  /** H3/D7's viewport-only epoch gate. */
  allowsInput(viewerId: string, tabId: string): boolean;
  /** Accepted activity delays routine trim snapshots without coupling the relay to TabHub. */
  noteInput(tabId: string): void;
  /** Current negotiated CSS-pixel viewport, used to clamp live rect coordinates. */
  /** Browser zoom divides scroll distances, unlike pointer coordinates. */
  wheelScale?(tabId: string): number;
  viewportFor(tabId: string): { w: number; h: number } | undefined;
  rectTimeoutMs?: number;
  onValueStatus?(tabId: string, failed: boolean): void;
}

export type InputMsg = Extract<
  Up,
  { t: "ptr" } | { t: "key" } | { t: "text" } | { t: "value" } | { t: "ime" } | { t: "scroll" }
>;

/** Resolves true only when an authorized message reached its authoritative dispatch path. */
export type InputRelay = ((viewerId: string, msg: InputMsg) => Promise<boolean>) & {
  /** Discard queued and resolving inputs belonging to a dead renderer. */
  resetTab(tabId: string): void;
  /** Test-mode instrumentation; production callers need not expose it. */
  rectFallbacksFor(tabId: string): number;
};

const FAILURE_REPORT_INTERVAL_MS = 60_000;
const lastFailureReports = new Map<string, number>();

/** Input goes wrong quietly otherwise. These hold ids and error text, never what was typed. */
function reportFailure(what: string, error: unknown): void {
  const message = `${what}: ${String(error).slice(0, 200)}`;
  const now = Date.now();
  if (now - (lastFailureReports.get(message) ?? 0) < FAILURE_REPORT_INTERVAL_MS) return;
  if (lastFailureReports.size > 100) lastFailureReports.clear();
  lastFailureReports.set(message, now);
  console.warn(`input: ${message}`);
}

export function createInputRelay(deps: InputRelayDeps): InputRelay {
  const rectTimeoutMs = deps.rectTimeoutMs ?? DEFAULT_RECT_TIMEOUT_MS;
  if (!Number.isSafeInteger(rectTimeoutMs) || rectTimeoutMs < 1) {
    throw new RangeError("rectTimeoutMs must be a positive safe integer");
  }

  // WebSocket callbacks may overlap. Serialize per tab so a fast `up` can never overtake a
  // slower `down` rect round-trip (the same ordering requirement applies to raw key pairs).
  const tabTails = new Map<string, Promise<void>>();
  // The latest hover, wheel or scroll still waiting its turn; the next of its kind merges into it.
  const pendingMoves = new Map<
    string,
    {
      viewerId: string;
      msg: InputMsg;
      result: Promise<boolean>;
    }
  >();
  const generations = new Map<string, number>();
  const rectFallbacks = new Map<string, number>();
  const failedValues = new Set<string>();
  const valueStatus = (tab: string, failed: boolean) => {
    if (failedValues.has(tab) === failed) return;
    if (failed) failedValues.add(tab);
    else failedValues.delete(tab);
    deps.onValueStatus?.(tab, failed);
  };
  const rectCache = new Map<string, { at: number; value: ResolvedRect }>();
  const pressRects = new Map<string, { nodeId: number; at: number; value: ResolvedRect }>();
  const resolverDeps: ResolveNodeDeps = {
    agentLink: deps.agentLink,
    send: deps.send,
    ...(deps.callBridge === undefined ? {} : { callBridge: deps.callBridge }),
    ...(deps.callFrame === undefined ? {} : { callFrame: deps.callFrame }),
    sessionFor: deps.sessionFor,
  };

  const relay = ((viewerId, msg) => {
    const generation = generations.get(msg.tab) ?? 0;
    const hover = msg.t === "ptr" && msg.kind === "move" && msg.buttons === 0;
    const wheel = msg.t === "ptr" && msg.kind === "wheel";
    const scroll = msg.t === "scroll";
    const pendingMove = pendingMoves.get(msg.tab);
    const pending = pendingMove?.viewerId === viewerId ? pendingMove.msg : undefined;
    if (hover && pending?.t === "ptr" && pending.kind === "move") {
      pendingMove!.msg = msg;
      return pendingMove!.result;
    }
    if (scroll && pending?.t === "scroll" && pending.nodeId === msg.nodeId) {
      pendingMove!.msg = msg;
      return pendingMove!.result;
    }
    // Each wheel event waits for the page. A trackpad sends far more of them than a busy page can
    // take, so ones still waiting are added together rather than left to scroll for seconds on.
    if (wheel && pending?.t === "ptr" && pending.kind === "wheel" && pending.mods === msg.mods) {
      pendingMove!.msg = {
        ...msg,
        dx: (pending.dx ?? 0) + (msg.dx ?? 0),
        dy: (pending.dy ?? 0) + (msg.dy ?? 0),
      };
      return pendingMove!.result;
    }
    // A click, drag or editor update is a barrier. Later moves and scrolls stay after that barrier.
    pendingMoves.delete(msg.tab);
    const prior = tabTails.get(msg.tab) ?? Promise.resolve();
    let move: ReturnType<typeof pendingMoves.get>;
    const result = prior.then(() => {
      if (move && pendingMoves.get(msg.tab) === move) pendingMoves.delete(msg.tab);
      return dispatch(viewerId, move?.msg ?? msg, generation);
    });
    if (hover || wheel || scroll) {
      move = { viewerId, msg, result };
      pendingMoves.set(msg.tab, move);
    }
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tabTails.set(msg.tab, tail);
    void tail.finally(() => {
      if (tabTails.get(msg.tab) === tail) tabTails.delete(msg.tab);
    });
    return result;
  }) as InputRelay;
  relay.resetTab = (tabId) => {
    pendingMoves.delete(tabId);
    valueStatus(tabId, false);
    generations.set(tabId, (generations.get(tabId) ?? 0) + 1);
    tabTails.delete(tabId);
    for (const key of rectCache.keys()) if (key.startsWith(`${tabId}:`)) rectCache.delete(key);
    pressRects.delete(tabId);
  };
  relay.rectFallbacksFor = (tabId) => rectFallbacks.get(tabId) ?? 0;
  return relay;

  async function dispatch(viewerId: string, msg: InputMsg, generation: number): Promise<boolean> {
    const valid = () =>
      (generations.get(msg.tab) ?? 0) === generation &&
      deps.isDriver(viewerId) &&
      deps.allowsInput(viewerId, msg.tab);
    if (!valid()) return false;
    if (
      failedValues.has(msg.tab) &&
      ((msg.t === "key" && msg.key === "Enter") ||
        (msg.t === "ptr" && (msg.kind === "down" || msg.kind === "up")))
    )
      return false;

    const sessionId = deps.sessionFor(msg.tab);
    if (sessionId === undefined) return false;
    deps.noteInput(msg.tab);

    try {
      switch (msg.t) {
        case "ptr":
          return await dispatchPointer(sessionId, msg, valid);
        case "key":
          await dispatchKey(sessionId, msg);
          return true;
        case "text":
          await deps.send(sessionId, "Input.insertText", { text: msg.insert });
          return true;
        case "ime":
          await deps.send(sessionId, "Input.imeSetComposition", {
            text: msg.text,
            selectionStart: msg.selStart,
            selectionEnd: msg.selEnd,
          });
          return true;
        case "value": {
          const resolved = await resolveNode(resolverDeps, msg.tab, msg.nodeId);
          if (!valid()) return false;
          const response = await deps.agentLink.sendCmd(
            resolved.targetId,
            {
              cmd: "value",
              nodeId: resolved.localId,
              value: msg.value,
              ...(msg.commit === undefined ? {} : { commit: msg.commit }),
              ...(msg.checked === undefined ? {} : { checked: msg.checked }),
              ...(msg.values === undefined ? {} : { values: msg.values }),
              ...(msg.selectionStart === undefined ? {} : { selectionStart: msg.selectionStart }),
              ...(msg.selectionEnd === undefined ? {} : { selectionEnd: msg.selectionEnd }),
            },
            resolved.frameId,
          );
          if (!valid()) return false;
          valueStatus(msg.tab, !response.ok);
          return response.ok;
        }
        case "scroll": {
          const command = { cmd: "scroll", x: msg.x, y: msg.y } as const;
          // Protocol nodeId 0 is the top-level window sentinel, not an rrweb mirror node. Any other
          // node is first tried in the top document, which is where nearly all of them are.
          let response = await withTimeout(
            deps.agentLink.sendCmd(msg.tab, { ...command, nodeId: msg.nodeId }),
            SCROLL_TIMEOUT_MS,
            "scroll",
          );
          if (!response.ok && response.err === NODE_IN_FRAME_ERROR) {
            const resolved = await resolveNode(resolverDeps, msg.tab, msg.nodeId);
            if (!valid()) return false;
            response = await withTimeout(
              deps.agentLink.sendCmd(
                resolved.targetId,
                { ...command, nodeId: resolved.localId },
                resolved.frameId,
              ),
              SCROLL_TIMEOUT_MS,
              "scroll",
            );
          }
          if (!response.ok) reportFailure("scroll was dropped", response.err);
          return response.ok;
        }
      }
    } catch (error) {
      reportFailure(`${msg.t} was dropped`, error);
      if (msg.t === "value" && valid()) valueStatus(msg.tab, true);
      // Navigation/detach can invalidate a session between authorization and dispatch. Input is
      // ephemeral; dropping that event is safer than turning a transient race into a WS failure.
      return false;
    }
  }

  async function dispatchPointer(
    sessionId: string,
    msg: Extract<InputMsg, { t: "ptr" }>,
    valid: () => boolean,
  ): Promise<boolean> {
    const { x, y } = await resolvePoint(msg);
    if (!valid()) return false;
    const common: Record<string, unknown> = {
      x,
      y,
      modifiers: msg.mods,
      buttons: msg.buttons,
    };

    switch (msg.kind) {
      case "move":
        await deps.send(sessionId, "Input.dispatchMouseEvent", {
          ...common,
          type: "mouseMoved",
          // Chromium ends a drag, such as selecting text, on a move without its button.
          button: heldButton(msg.buttons),
        });
        return true;
      case "wheel":
        await deps.send(sessionId, "Input.dispatchMouseEvent", {
          ...common,
          type: "mouseWheel",
          button: "none",
          deltaX: finiteOr(msg.dx, 0) * (deps.wheelScale?.(msg.tab) ?? 1),
          deltaY: finiteOr(msg.dy, 0) * (deps.wheelScale?.(msg.tab) ?? 1),
        });
        return true;
      case "down":
      case "up":
        await deps.send(sessionId, "Input.dispatchMouseEvent", {
          ...common,
          type: msg.kind === "down" ? "mousePressed" : "mouseReleased",
          button: mouseButton(msg.button),
          clickCount: msg.clicks ?? 1,
        });
        return true;
    }
  }

  async function resolvePoint(msg: Extract<InputMsg, { t: "ptr" }>): Promise<Point> {
    const fallback = clampToViewport(msg.tab, finiteOr(msg.vx, 0), finiteOr(msg.vy, 0));
    // Pixel input has no recorder node. Avoid a doomed resolve/rect bridge round-trip while
    // retaining the same coordinate sanitation and dispatch authorization as DOM input.
    if (msg.nodeId === -1) return fallback;
    let resolvedRect: ResolvedRect;
    const press = pressRects.get(msg.tab);
    // After a drag, what was pressed may have moved with the pointer, such as a slider's thumb.
    if (msg.kind === "down" || msg.kind === "up" || (msg.kind === "move" && msg.buttons !== 0))
      pressRects.delete(msg.tab);
    try {
      if (
        msg.kind === "up" &&
        press?.nodeId === msg.nodeId &&
        Date.now() - press.at < PRESS_RECT_REUSE_MS
      ) {
        resolvedRect = press.value;
      } else {
        resolvedRect = await resolveRect(msg.tab, msg.nodeId, msg.kind === "move");
        if (msg.kind === "down")
          pressRects.set(msg.tab, { nodeId: msg.nodeId, at: Date.now(), value: resolvedRect });
      }
    } catch (error) {
      rectFallbacks.set(msg.tab, (rectFallbacks.get(msg.tab) ?? 0) + 1);
      reportFailure("pointer fell back to viewport coordinates", error);
      return fallback;
    }

    // Clamp relative fractions as hostile/garbled wire values must not project beyond the node.
    const rx = clamp(finiteOr(msg.rx, 0), 0, 1);
    const ry = clamp(finiteOr(msg.ry, 0), 0, 1);
    let x = resolvedRect.rect.x + rx * resolvedRect.rect.w;
    let y = resolvedRect.rect.y + ry * resolvedRect.rect.h;
    if (resolvedRect.iframeClip !== undefined) {
      x = clampInto(x, resolvedRect.iframeClip.left, resolvedRect.iframeClip.right);
      y = clampInto(y, resolvedRect.iframeClip.top, resolvedRect.iframeClip.bottom);
    }
    return clampToViewport(msg.tab, x, y);
  }

  async function resolveRect(
    tabId: string,
    nodeId: number,
    cacheable = false,
  ): Promise<ResolvedRect> {
    const cacheKey = `${tabId}:${nodeId}`;
    const cached = rectCache.get(cacheKey);
    if (cacheable && cached !== undefined && Date.now() - cached.at < 120) return cached.value;
    const direct = await withTimeout(
      deps.agentLink.sendCmd(tabId, { cmd: "rect", nodeId }),
      rectTimeoutMs,
    );
    if (direct.ok && isRectResult(direct.data)) {
      const value = { rect: direct.data };
      if (cacheable) rectCache.set(cacheKey, { at: Date.now(), value });
      return value;
    }
    if (direct.ok || direct.err !== NODE_IN_FRAME_ERROR)
      throw new Error(direct.err ?? "rect command failed");
    const resolved = await resolveNode(resolverDeps, tabId, nodeId);
    const response = await withTimeout(
      deps.agentLink.sendCmd(
        resolved.targetId,
        {
          cmd: "rect",
          nodeId: resolved.localId,
        },
        resolved.frameId,
      ),
      rectTimeoutMs,
    );
    if (!response.ok || !isRectResult(response.data)) {
      throw new Error(response.err ?? "rect command failed");
    }
    if (resolved.frameHops.length === 0) {
      const value = { rect: response.data };
      if (cacheable) rectCache.set(cacheKey, { at: Date.now(), value });
      return value;
    }

    const iframeRects: RectResult[] = [];
    for (const hop of resolved.frameHops) {
      const iframeResponse = await withTimeout(
        deps.agentLink.sendCmd(
          hop.targetId,
          {
            cmd: "rect",
            nodeId: hop.iframeNodeId,
          },
          hop.frameId,
        ),
        rectTimeoutMs,
      );
      if (!iframeResponse.ok || !isRectResult(iframeResponse.data)) {
        throw new Error(iframeResponse.err ?? "iframe rect command failed");
      }
      iframeRects.push(iframeResponse.data);
    }
    const value = composeRemoteRect(response.data, resolved.frameHops, iframeRects);
    if (cacheable) rectCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  function clampToViewport(tabId: string, x: number, y: number): Point {
    const viewport = deps.viewportFor(tabId);
    if (viewport === undefined) return { x: Math.max(0, x), y: Math.max(0, y) };
    return {
      x: clamp(x, 0, Math.max(0, viewport.w - Number.EPSILON)),
      y: clamp(y, 0, Math.max(0, viewport.h - Number.EPSILON)),
    };
  }

  async function dispatchKey(
    sessionId: string,
    msg: Extract<InputMsg, { t: "key" }>,
  ): Promise<void> {
    if (
      ((msg.mods & (Mod.Ctrl | Mod.Meta)) !== 0 && msg.key.toLowerCase() === "v") ||
      ((msg.mods & Mod.Shift) !== 0 && msg.key === "Insert")
    )
      return;
    const description = describeKey(msg.code, msg.key, msg.mods);
    if (msg.kind === "up") {
      await deps.send(sessionId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        modifiers: msg.mods,
        key: description.key,
        code: description.code,
        windowsVirtualKeyCode: description.keyCode,
        location: description.location,
        isKeypad: description.location === 3,
      });
      return;
    }

    await deps.send(sessionId, "Input.dispatchKeyEvent", {
      type: description.text ? "keyDown" : "rawKeyDown",
      modifiers: msg.mods,
      key: description.key,
      code: description.code,
      text: description.text,
      unmodifiedText: description.text,
      windowsVirtualKeyCode: description.keyCode,
      location: description.location,
      isKeypad: description.location === 3,
    });
  }
}

interface Point {
  x: number;
  y: number;
}

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ResolvedRect {
  rect: RectResult;
  iframeClip?: Bounds;
}

function composeRemoteRect(
  childRect: RectResult,
  frameHops: readonly FrameHop[],
  iframeRects: readonly RectResult[],
): ResolvedRect {
  if (frameHops.length === 0 || frameHops.length !== iframeRects.length) {
    throw new Error("OOPIF rect composition received an invalid frame chain");
  }

  let x = childRect.x;
  let y = childRect.y;
  let iframeClip: Bounds | undefined;
  let visible = childRect.visible && childRect.w > 0 && childRect.h > 0;

  // Each child rect is relative to its own viewport. Walk inner-to-outer, translating both the
  // node and the accumulated clipping region through every iframe element.
  for (let index = iframeRects.length - 1; index >= 0; index -= 1) {
    const iframeRect = iframeRects[index]!;
    const contentX = iframeRect.x + (iframeRect.borderLeft ?? 0);
    const contentY = iframeRect.y + (iframeRect.borderTop ?? 0);
    x += contentX;
    y += contentY;
    if (iframeClip !== undefined) {
      iframeClip = translateBounds(iframeClip, contentX, contentY);
    }

    const iframeBounds = boundsForRect(iframeRect);
    if (iframeBounds === undefined) {
      throw new Error("OOPIF iframe has an empty dispatch rect");
    }
    iframeClip =
      iframeClip === undefined ? iframeBounds : intersectBounds(iframeClip, iframeBounds);
    if (iframeClip === undefined) {
      throw new Error("Nested OOPIF iframe rects do not overlap");
    }
    visible = visible && iframeRect.visible;
  }

  const rect = { ...childRect, x, y };
  if (iframeClip === undefined) throw new Error("OOPIF rect composition produced no clip");
  visible = visible && intersectBounds(boundsForRect(rect), iframeClip) !== undefined;
  return { rect: { ...rect, visible }, iframeClip };
}

function boundsForRect(rect: Pick<RectResult, "x" | "y" | "w" | "h">): Bounds | undefined {
  if (rect.w <= 0 || rect.h <= 0) return undefined;
  return {
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.w,
    bottom: rect.y + rect.h,
  };
}

function translateBounds(bounds: Bounds, x: number, y: number): Bounds {
  return {
    left: bounds.left + x,
    top: bounds.top + y,
    right: bounds.right + x,
    bottom: bounds.bottom + y,
  };
}

function intersectBounds(a: Bounds | undefined, b: Bounds): Bounds | undefined {
  if (a === undefined) return undefined;
  const intersection = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return intersection.right > intersection.left && intersection.bottom > intersection.top
    ? intersection
    : undefined;
}

function clampInto(value: number, min: number, max: number): number {
  if (!(max > min)) throw new Error("Cannot clamp into an empty OOPIF rect");
  const inset = Math.min(IFRAME_EDGE_INSET_PX, (max - min) / 2);
  return clamp(value, min + inset, max - inset);
}

function isRectResult(value: unknown): value is RectResult {
  if (typeof value !== "object" || value === null) return false;
  const rect = value as Partial<RectResult>;
  return (
    [rect.x, rect.y, rect.w, rect.h].every(
      (part) => typeof part === "number" && Number.isFinite(part),
    ) && typeof rect.visible === "boolean"
  );
}

function mouseButton(button: 0 | 1 | 2 | undefined): "left" | "middle" | "right" {
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "left";
}

/** The button a move carries, in the order of `MouseEvent.buttons`: left, right, middle. */
function heldButton(buttons: number): "none" | "left" | "right" | "middle" {
  if (buttons & 1) return "left";
  if (buttons & 2) return "right";
  if (buttons & 4) return "middle";
  return "none";
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what = "rect"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} command timed out`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
