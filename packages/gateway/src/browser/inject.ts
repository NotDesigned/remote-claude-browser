/**
 * Browser-agent injection pipeline.
 *
 * On every attached page/iframe target run the D1 attach sequence IN THIS ORDER:
 *   Page.enable -> webdriver safeguard -> isolated bridge + MAIN agent new-document scripts ->
 *   Runtime.runIfWaitingForDebugger -> create isolated worlds and add context-scoped bindings
 * `runImmediately:true` covers attaching to an already-loaded document (first attach after
 * session start).
 *
 * Gotchas: Runtime.bindingCalled fires per execution context — dedupe by msgId. Commands and node
 * handles use Runtime.callFunctionOn against the acquired per-document bridge RemoteObject.
 */
import { createAgentBundle, DEFAULT_AGENT_CONFIG } from "@mirror/agent";

import type { TargetRef } from "../types";
import {
  agentBridgeChannel,
  ensureAgentBridgeChannel,
  isolatedAgentBridgeSource,
  type AgentBridgeChannel,
} from "./bridge";
import type { BrowserHandle } from "./launch";

/** Native AutomationControlled already returns false. This conditional fallback only changes the
 * descriptor if a future Chromium/embedder regresses despite the launch invariant. */
/** MIRROR_CANVAS_SITES: comma-separated, "none" for no sites, unset for the challenge providers. */
export function canvasSites(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [...DEFAULT_AGENT_CONFIG.canvas.sites];
  if (value.trim() === "none") return [];
  return value
    .split(",")
    .map((site) => site.trim())
    .filter((site) => site !== "");
}

export const WEBDRIVER_NORMALIZER = `(() => {
  const prototype = Navigator.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "webdriver");
  if (navigator.webdriver === false || navigator.webdriver === undefined) return;
  Object.defineProperty(prototype, "webdriver", {
    configurable: descriptor?.configurable ?? true,
    enumerable: descriptor?.enumerable ?? true,
    get: () => false,
  });
})()`;

/**
 * Chromium's page for an address that failed to load lives in a process that may show nothing else,
 * and kills it if a frame there commits anything. The recorder makes a blank iframe to get clean
 * prototypes, so running on that page takes the tab down. The viewer says the page failed instead.
 */
export function skipOnErrorPage(source: string): string {
  return `if (location.protocol !== "chrome-error:") {\n${source}\n}`;
}

const injections = new WeakMap<BrowserHandle, Map<string, Promise<void>>>();
const rebindingBrowsers = new WeakSet<BrowserHandle>();

interface FrameTree {
  frame: { id: string };
  childFrames?: FrameTree[];
}

async function bindIsolatedBridgeWorld(
  browser: BrowserHandle,
  sessionId: string,
  frameId: string,
  channel: AgentBridgeChannel,
): Promise<void> {
  const created = (await browser.send(sessionId, "Page.createIsolatedWorld", {
    frameId,
    worldName: channel.worldName,
    grantUniveralAccess: false,
  })) as { executionContextId?: number };
  if (created.executionContextId === undefined) {
    throw new Error(`Could not create recorder bridge world for frame ${frameId}`);
  }
  await browser.send(sessionId, "Runtime.addBinding", {
    name: channel.bindingName,
    executionContextId: created.executionContextId,
  });
  await browser.send(sessionId, "Runtime.addBinding", {
    name: channel.rtcBindingName,
    executionContextId: created.executionContextId,
  });
}

/** The frame reached its next document between two commands, and its navigation binds that one. */
function frameMovedOn(error: unknown): boolean {
  return /Cannot find (?:execution )?context|No frame for given id|Frame with the given id/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

async function bindCurrentFrameTree(
  browser: BrowserHandle,
  sessionId: string,
  channel: AgentBridgeChannel,
): Promise<void> {
  const response = (await browser.send(sessionId, "Page.getFrameTree")) as {
    frameTree?: FrameTree;
  };
  if (response.frameTree === undefined) throw new Error("Page.getFrameTree returned no frame tree");
  const pending = [response.frameTree];
  while (pending.length > 0) {
    const tree = pending.shift()!;
    await bindIsolatedBridgeWorld(browser, sessionId, tree.frame.id, channel).catch(
      (error: unknown) => {
        if (!frameMovedOn(error)) throw error;
      },
    );
    pending.push(...(tree.childFrames ?? []));
  }
}

function ensureNavigationRebinding(browser: BrowserHandle): void {
  if (rebindingBrowsers.has(browser)) return;
  rebindingBrowsers.add(browser);
  browser.onSessionEvent("Page.frameNavigated", (sessionId, event) => {
    const channel = agentBridgeChannel(browser, sessionId);
    if (channel === undefined) return;
    // The MAIN agent can safely queue while this page-invisible world is created after commit.
    void bindIsolatedBridgeWorld(browser, sessionId, event.frame.id, channel).catch(
      () => undefined,
    );
  });
}

function injectionsFor(browser: BrowserHandle): Map<string, Promise<void>> {
  let browserInjections = injections.get(browser);
  if (browserInjections !== undefined) return browserInjections;

  const created = new Map<string, Promise<void>>();
  injections.set(browser, created);
  ensureNavigationRebinding(browser);
  browser.onDetached((target) => created.delete(target.sessionId));
  return created;
}

/** Inject once per flat session. Repeated callers share the same ordered attach promise. */
export function injectAgent(
  browser: BrowserHandle,
  target: TargetRef,
  prepare?: (target: TargetRef) => Promise<void>,
): Promise<void> {
  const browserInjections = injectionsFor(browser);

  const existing = browserInjections.get(target.sessionId);
  if (existing !== undefined) return existing;

  const injection = (async () => {
    const channel = ensureAgentBridgeChannel(browser, target.sessionId);
    const source = createAgentBundle({
      canvas: {
        ...DEFAULT_AGENT_CONFIG.canvas,
        enabled: process.env.MIRROR_CANVAS_SNAPSHOTS !== "0",
        sites: canvasSites(process.env.MIRROR_CANVAS_SITES),
      },
      bridge: {
        bindingName: channel.bindingName,
        rtcBindingName: channel.rtcBindingName,
        bridgeKey: channel.bridgeKey,
        outboundEventName: channel.outboundEventName,
        inboundEventName: channel.inboundEventName,
        nodeResponseEventName: channel.nodeResponseEventName,
        readyEventName: channel.readyEventName,
      },
    });
    // A page opened in a new window does not answer these until it is resumed, so they are sent in
    // order and only then awaited. Awaiting each one left that window blank until the protocol timed
    // out. The session delivers them in the order they were sent.
    const replies: Promise<unknown>[] = [];
    const send = (method: string, params?: Record<string, unknown>): void => {
      const reply = browser.send(target.sessionId, method, params);
      reply.catch(() => undefined);
      replies.push(reply);
    };
    send("Page.enable");
    await prepare?.(target);
    send("Page.addScriptToEvaluateOnNewDocument", {
      source: WEBDRIVER_NORMALIZER,
      runImmediately: true,
    });
    send("Page.addScriptToEvaluateOnNewDocument", {
      source: isolatedAgentBridgeSource(channel),
      worldName: channel.worldName,
      runImmediately: true,
    });
    send("Page.addScriptToEvaluateOnNewDocument", {
      source: skipOnErrorPage(source),
      runImmediately: true,
    });
    // Resume before creating the current isolated world: Page.createIsolatedWorld can wait on a
    // debugger-paused OOPIF, while its parent waits for that child to finish loading. The MAIN
    // agent queues safely until the context-scoped bridge becomes ready.
    send("Runtime.runIfWaitingForDebugger");
    await Promise.all(replies);
    // Runtime.bindingCalled does not require Runtime.enable. Scope both native bindings to the
    // isolated bridge context so no CDP binding property is ever installed in MAIN.
    await bindCurrentFrameTree(browser, target.sessionId, channel);
  })();
  browserInjections.set(target.sessionId, injection);
  return injection;
}
