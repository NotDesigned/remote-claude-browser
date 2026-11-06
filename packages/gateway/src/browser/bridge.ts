import { randomBytes } from "node:crypto";

import type { Protocol } from "puppeteer-core";

import type { BrowserHandle } from "./launch";

export type AgentBridgeMethod = "command" | "node" | "rtc" | "voice";

export interface AgentBridgeChannel {
  readonly bindingName: string;
  readonly rtcBindingName: string;
  readonly bridgeKey: string;
  readonly worldName: string;
  readonly outboundEventName: string;
  readonly inboundEventName: string;
  readonly nodeResponseEventName: string;
  readonly readyEventName: string;
  objectId?: string;
  executionContextId?: number;
  /** One private world per frame reached by id, from which to talk to that frame's agent. */
  frameWorlds?: Map<string, number>;
}

const channels = new WeakMap<BrowserHandle, Map<string, AgentBridgeChannel>>();
const watched = new WeakSet<BrowserHandle>();

function randomPrivateName(): string {
  return `_${randomBytes(16).toString("hex")}`;
}

function channelsFor(browser: BrowserHandle): Map<string, AgentBridgeChannel> {
  let browserChannels = channels.get(browser);
  if (browserChannels === undefined) {
    browserChannels = new Map();
    channels.set(browser, browserChannels);
  }
  if (!watched.has(browser)) {
    watched.add(browser);
    browser.onDetached((target) => {
      const channel = browserChannels?.get(target.sessionId);
      browserChannels?.delete(target.sessionId);
      if (channel?.objectId !== undefined) {
        void browser
          .send(target.sessionId, "Runtime.releaseObject", { objectId: channel.objectId })
          .catch(() => undefined);
      }
    });
  }
  return browserChannels;
}

export function ensureAgentBridgeChannel(
  browser: BrowserHandle,
  sessionId: string,
): AgentBridgeChannel {
  const browserChannels = channelsFor(browser);
  let channel = browserChannels.get(sessionId);
  if (channel !== undefined) return channel;
  channel = {
    bindingName: randomPrivateName(),
    rtcBindingName: randomPrivateName(),
    bridgeKey: randomPrivateName(),
    worldName: randomPrivateName(),
    outboundEventName: randomPrivateName(),
    inboundEventName: randomPrivateName(),
    nodeResponseEventName: randomPrivateName(),
    readyEventName: randomPrivateName(),
  };
  browserChannels.set(sessionId, channel);
  return channel;
}

export function agentBridgeChannel(
  browser: BrowserHandle,
  sessionId: string,
): AgentBridgeChannel | undefined {
  return channels.get(browser)?.get(sessionId);
}

export function isolatedAgentBridgeSource(channel: AgentBridgeChannel): string {
  return `(() => {
    const bindingName = ${JSON.stringify(channel.bindingName)};
    const rtcBindingName = ${JSON.stringify(channel.rtcBindingName)};
    const bridgeKey = ${JSON.stringify(channel.bridgeKey)};
    const outboundEventName = ${JSON.stringify(channel.outboundEventName)};
    const inboundEventName = ${JSON.stringify(channel.inboundEventName)};
    const nodeResponseEventName = ${JSON.stringify(channel.nodeResponseEventName)};
    const readyEventName = ${JSON.stringify(channel.readyEventName)};
    const nativeAddEventListener = EventTarget.prototype.addEventListener;
    const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
    const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
    const nativeQuerySelectorAll = Document.prototype.querySelectorAll;
    const NativeCustomEvent = CustomEvent;
    const parse = JSON.parse;
    const stringify = JSON.stringify;
    let emitBinding;
    let rtcBinding;
    let nodeResult;
    let readyTimer;

    nativeAddEventListener.call(document, outboundEventName, (event) => {
      if (typeof event.detail !== "string") return;
      let envelope;
      try { envelope = parse(event.detail); } catch { return; }
      if (typeof envelope !== "object" || envelope === null ||
          typeof envelope.payload !== "string") return;
      const binding = envelope.lane === "agent" ? emitBinding :
        envelope.lane === "rtc" ? rtcBinding : undefined;
      if (typeof binding !== "function") return;
      if (readyTimer !== undefined) {
        clearInterval(readyTimer);
        readyTimer = undefined;
      }
      binding(envelope.payload);
    });
    const onNodeResponse = (event) => { nodeResult = event.target; };
    // A recorder also covers the same-origin documents below it. The agent answers on the node
    // itself, and an event stays within the node's own document.
    const documentsBelow = (root, found = []) => {
      found.push(root);
      for (const frame of nativeQuerySelectorAll.call(root, "iframe")) {
        let inner = null;
        try { inner = frame.contentDocument; } catch {}
        if (inner) documentsBelow(inner, found);
      }
      return found;
    };

    Object.defineProperty(globalThis, bridgeKey, {
      configurable: true,
      value: Object.freeze({
        command(value) {
          nativeDispatchEvent.call(document, new NativeCustomEvent(inboundEventName, {
            detail: stringify({ method: "command", args: [value] }),
          }));
        },
        node(nodeId) {
          nodeResult = undefined;
          const documents = documentsBelow(document);
          for (const each of documents) {
            nativeAddEventListener.call(each, nodeResponseEventName, onNodeResponse, true);
          }
          nativeDispatchEvent.call(document, new NativeCustomEvent(inboundEventName, {
            detail: stringify({ method: "node", args: [nodeId] }),
          }));
          for (const each of documents) {
            nativeRemoveEventListener.call(each, nodeResponseEventName, onNodeResponse, true);
          }
          return nodeResult;
        },
        rtc(value) {
          nativeDispatchEvent.call(document, new NativeCustomEvent(inboundEventName, {
            detail: stringify({ method: "rtc", args: [value] }),
          }));
        },
        voice(value) {
          nativeDispatchEvent.call(document, new NativeCustomEvent(inboundEventName, {
            detail: stringify({ method: "voice", args: [value] }),
          }));
        },
      }),
    });

    const announceReady = () => {
      emitBinding = typeof globalThis[bindingName] === "function"
        ? globalThis[bindingName] : emitBinding;
      rtcBinding = typeof globalThis[rtcBindingName] === "function"
        ? globalThis[rtcBindingName] : rtcBinding;
      if (typeof emitBinding !== "function" || typeof rtcBinding !== "function") return;
      nativeDispatchEvent.call(document, new NativeCustomEvent(readyEventName));
    };
    readyTimer = setInterval(announceReady, 50);
    announceReady();
  })()`;
}

function acquisitionExpression(channel: AgentBridgeChannel): string {
  return `(() => {
    const bridgeKey = ${JSON.stringify(channel.bridgeKey)};
    const bridge = globalThis[bridgeKey];
    if (bridge === undefined) throw new Error("recorder bridge unavailable");
    try { delete globalThis[bridgeKey]; } catch {}
    return bridge;
  })()`;
}

interface RuntimeRemoteResult {
  result?: Protocol.Runtime.RemoteObject;
  exceptionDetails?: Protocol.Runtime.ExceptionDetails;
}

/**
 * Capture the isolated world's short-lived bridge as a DevTools RemoteObject and remove its global
 * property. Non-canonical same-process frame bridges are acquired only long enough to perform the
 * same cleanup, then released. No binding or bridge property is installed in the page's MAIN world.
 */
export async function acquireAgentBridge(
  browser: BrowserHandle,
  sessionId: string,
  executionContextId: number,
  retain: boolean,
): Promise<string> {
  const channel = ensureAgentBridgeChannel(browser, sessionId);
  const evaluated = (await browser.send(sessionId, "Runtime.evaluate", {
    expression: acquisitionExpression(channel),
    contextId: executionContextId,
    returnByValue: false,
    silent: true,
  })) as RuntimeRemoteResult;
  const objectId = evaluated.result?.objectId;
  if (evaluated.exceptionDetails !== undefined || objectId === undefined) {
    throw new Error(`Could not acquire recorder bridge for CDP session ${sessionId}`);
  }

  if (!retain) {
    await browser.send(sessionId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
    return objectId;
  }

  const previousObjectId = channel.objectId;
  channel.objectId = objectId;
  channel.executionContextId = executionContextId;
  if (previousObjectId !== undefined && previousObjectId !== objectId) {
    await browser
      .send(sessionId, "Runtime.releaseObject", { objectId: previousObjectId })
      .catch(() => undefined);
  }
  return objectId;
}

export async function callAgentBridge(
  browser: BrowserHandle,
  sessionId: string,
  method: AgentBridgeMethod,
  args: readonly unknown[],
  options: { returnByValue?: boolean } = {},
): Promise<unknown> {
  const channel = agentBridgeChannel(browser, sessionId);
  if (channel?.objectId === undefined) {
    throw new Error(`Recorder bridge for CDP session ${sessionId} is not ready`);
  }
  return browser.send(sessionId, "Runtime.callFunctionOn", {
    objectId: channel.objectId,
    functionDeclaration: `function(method, args) { return this[method](...args); }`,
    arguments: [{ value: method }, { value: args }],
    awaitPromise: false,
    returnByValue: options.returnByValue ?? false,
    silent: true,
  });
}

function frameCallExpression(
  channel: AgentBridgeChannel,
  method: "command" | "node",
  args: readonly unknown[],
): string {
  const event = `new CustomEvent(${JSON.stringify(channel.inboundEventName)}, {
      detail: ${JSON.stringify(JSON.stringify({ method, args }))},
    })`;
  if (method === "command") return `void document.dispatchEvent(${event})`;
  // A recorder also covers the same-origin documents below it. The agent answers on the node itself,
  // and an event stays within the node's own document.
  return `(() => {
    let found;
    const listener = (event) => { found = event.target; };
    const documents = [];
    const collect = (root) => {
      documents.push(root);
      for (const frame of root.querySelectorAll("iframe")) {
        let inner = null;
        try { inner = frame.contentDocument; } catch {}
        if (inner) collect(inner);
      }
    };
    collect(document);
    for (const each of documents) {
      each.addEventListener(${JSON.stringify(channel.nodeResponseEventName)}, listener, true);
    }
    document.dispatchEvent(${event});
    for (const each of documents) {
      each.removeEventListener(${JSON.stringify(channel.nodeResponseEventName)}, listener, true);
    }
    return found;
  })()`;
}

/**
 * Talk to the agent of one particular frame. A session can hold several: a cross-origin frame in the
 * same process as its parent has no target of its own, and the bridge kept for a session belongs to
 * whichever frame announced itself last. Finding a frame's own context would take Runtime.enable,
 * which sites can detect. A private world can be asked for by frame id instead, and every world of
 * a document shares its events, which is how the agent is reached anyway.
 */
export async function callFrameAgent(
  browser: BrowserHandle,
  sessionId: string,
  frameId: string,
  method: "command" | "node",
  args: readonly unknown[],
): Promise<RuntimeRemoteResult> {
  const channel = ensureAgentBridgeChannel(browser, sessionId);
  const worlds = (channel.frameWorlds ??= new Map());
  const evaluate = async (contextId: number) =>
    (await browser.send(sessionId, "Runtime.evaluate", {
      expression: frameCallExpression(channel, method, args),
      contextId,
      returnByValue: false,
      silent: true,
    })) as RuntimeRemoteResult;
  const openWorld = async () => {
    const created = (await browser.send(sessionId, "Page.createIsolatedWorld", {
      frameId,
      worldName: channel.worldName,
    })) as { executionContextId: number };
    worlds.set(frameId, created.executionContextId);
    return created.executionContextId;
  };

  const known = worlds.get(frameId);
  if (known === undefined) return evaluate(await openWorld());
  try {
    return await evaluate(known);
  } catch {
    // The frame navigated, which took its worlds with it.
    worlds.delete(frameId);
    return evaluate(await openWorld());
  }
}
