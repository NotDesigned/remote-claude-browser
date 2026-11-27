// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventType, IncrementalSource } from "@mirror/protocol";
import { RETAINED_DOCUMENTS, retainCheckoutIds, type ResettableIframeMirror } from "./frame-ids";

/**
 * rrweb's own (patched) IframeManager and CrossOriginIframeMirror, taken from the dist the agent
 * bundles: what matters is how they remap a child frame's ids, which a stand-in would only assume.
 */
function loadIframeManager(
  hardening: { messageKey: string | null } = { messageKey: null },
): new (options: unknown) => IframeManagerLike {
  const require = createRequire(import.meta.url);
  const dist = join(dirname(require.resolve("@rrweb/record")), "record.js");
  const source = readFileSync(dist, "utf8");
  const start = source.indexOf("class CrossOriginIframeMirror {");
  const managerStart = source.indexOf("class IframeManager {", start);
  const end = source.indexOf("\n}\n", managerStart);
  expect(start).toBeGreaterThan(-1);
  expect(managerStart).toBeGreaterThan(start);
  const classes = source.slice(start, end + 2);
  let nextId = 1000;
  return new Function(
    "EventType",
    "IncrementalSource",
    "NodeType",
    "genId",
    "window",
    "hardening",
    `const __publicField = (obj, key, value) => { obj[key] = value; return value; };
${classes}
return IframeManager;`,
  )(
    EventType,
    IncrementalSource,
    { Document: 0 },
    () => nextId++,
    { addEventListener() {} },
    hardening,
  );
}

interface IframeManagerLike {
  crossOriginIframeMirror: ResettableIframeMirror;
  addIframe(iframe: HTMLIFrameElement): void;
  handleMessage(message: unknown): void;
}

interface SerializedNode {
  id: number;
  type: number;
  childNodes?: SerializedNode[];
}

function childDocument(): SerializedNode {
  // The child's own ids, which stay the same while it keeps its document.
  return {
    id: 1,
    type: 0,
    childNodes: [{ id: 2, type: 2, childNodes: [{ id: 3, type: 2, childNodes: [] }] }],
  };
}

function harness(messageKey: string | null = null) {
  const IframeManager = loadIframeManager({ messageKey });
  const emitted: Array<{ data: { adds: Array<{ node: SerializedNode }> } }> = [];
  const manager = new IframeManager({
    mutationCb() {},
    wrappedEmit: (event: (typeof emitted)[number]) => emitted.push(event),
    stylesheetManager: { styleMirror: { generateId: () => 1 } },
    recordCrossOriginIframes: false,
    mirror: { getId: () => 7 },
  });
  const childWindow = {};
  const iframe = { contentWindow: childWindow } as unknown as HTMLIFrameElement;
  manager.addIframe(iframe);
  const mirror = retainCheckoutIds(manager.crossOriginIframeMirror);
  /** The child sends its whole document, as a checkout of the same one or as a new one. */
  const send = (isCheckout: boolean, keyed = messageKey !== null): number => {
    const payload = {
      origin: "null",
      isCheckout,
      event: { type: EventType.FullSnapshot, timestamp: 1, data: { node: childDocument() } },
    };
    const before = emitted.length;
    manager.handleMessage({
      origin: "null",
      source: childWindow,
      data: keyed ? { [messageKey ?? "k"]: payload } : { type: "rrweb", ...payload },
    });
    // Nothing taken from the message.
    if (emitted.length === before) return -1;
    const node = emitted.at(-1)!.data.adds[0]!.node;
    return node.childNodes![0]!.childNodes![0]!.id;
  };
  return { iframe, mirror, send };
}

describe("retainCheckoutIds", () => {
  it("still resolves the ids of a document its frame sent again", () => {
    const { iframe, mirror, send } = harness();
    const first = send(false);
    expect(mirror.getRemoteId(iframe, first)).toBe(3);
    const second = send(true);
    // rrweb gives the same node a new id, which the viewer only learns once it arrives.
    expect(second).not.toBe(first);
    expect(mirror.getRemoteId(iframe, second)).toBe(3);
    expect(mirror.getRemoteId(iframe, first)).toBe(3);
  });

  it("forgets them once the frame has a new document", () => {
    const { iframe, mirror, send } = harness();
    const first = send(false);
    send(true);
    const reloaded = send(false);
    expect(mirror.getRemoteId(iframe, reloaded)).toBe(3);
    expect(mirror.getRemoteId(iframe, first)).toBe(-1);
  });

  it("keeps only the last few documents", () => {
    const { iframe, mirror, send } = harness();
    const ids = [send(false)];
    for (let i = 0; i < RETAINED_DOCUMENTS + 1; i++) ids.push(send(true));
    expect(mirror.getRemoteId(iframe, ids[0]!)).toBe(-1);
    for (const id of ids.slice(1)) expect(mirror.getRemoteId(iframe, id)).toBe(3);
  });

  it("answers a caller's own map from that map alone", () => {
    const { iframe, mirror, send } = harness();
    const first = send(false);
    send(true);
    expect(mirror.getRemoteId(iframe, first, new Map())).toBe(-1);
  });
});

describe("frame messages with the session's key (hardening)", () => {
  it("takes a child's events only under the key, never by type: rrweb", () => {
    const { iframe, mirror, send } = harness("k7x2");
    const id = send(false);
    expect(id).toBeGreaterThan(0);
    expect(mirror.getRemoteId(iframe, id)).toBe(3);
    // The literal shape a page could also post is ignored once there is a key.
    expect(send(false, false)).toBe(-1);
  });

  it("without a key, ignores keyed messages and takes the literal shape as before", () => {
    const { send } = harness(null);
    expect(send(false, true)).toBe(-1);
    expect(send(false, false)).toBeGreaterThan(0);
  });
});
