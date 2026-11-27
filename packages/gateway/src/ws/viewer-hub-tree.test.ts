import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  decodeDown,
  encodeMsg,
  EventType,
  IncrementalSource,
  type Down,
  type eventWithTime,
  type Up,
} from "@mirror/protocol";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { TreeBudget } from "../hub/live-tree/budget";
import { pageSyncMetrics, resetPageSyncMetrics } from "../hub/live-tree/metrics";
import { TabHub, type LiveTreeOptions } from "../hub/tabhub";
import { createViewerHub, type ViewerHubDeps } from "./viewer-hub";

const TREE: LiveTreeOptions = {
  ringEvents: 50,
  ringBytes: 1024 * 1024,
  maxNodes: 100_000,
  maxBytes: 64 * 1024 * 1024,
  maxSidecar: 1_000,
  verify: false,
  budget: new TreeBudget(1024 * 1024 * 1024),
};

let clock = 10;
const rrweb = (e: eventWithTime) => ({ kind: "rrweb" as const, docId: 1, e });

/** A hub with html > body#3 > div#4(contenteditable) > text#5, and its page snapshot in. */
function readyHub(tab: string, liveTree: LiveTreeOptions | false = TREE): TabHub {
  let epoch = 100;
  const hub = new TabHub({ sessionId: "s1", tabId: tab, liveTree, nextEpoch: () => ++epoch });
  hub.ingest({ kind: "hello", docId: 1, url: "https://x/", isTop: true, ts: 0 });
  hub.ingest(
    rrweb({
      type: EventType.Meta,
      timestamp: ++clock,
      data: { href: "https://x/", width: 800, height: 600 },
    } as eventWithTime),
  );
  hub.ingest(
    rrweb({
      type: EventType.FullSnapshot,
      timestamp: ++clock,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: "html",
              attributes: {},
              childNodes: [
                {
                  type: 2,
                  id: 3,
                  tagName: "body",
                  attributes: {},
                  childNodes: [
                    {
                      type: 2,
                      id: 4,
                      tagName: "div",
                      attributes: { contenteditable: "true" },
                      childNodes: [{ type: 3, id: 5, textContent: "typed" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        initialOffset: { left: 0, top: 0 },
      },
    } as unknown as eventWithTime),
  );
  return hub;
}

function text(hub: TabHub, value: string): Down[] {
  return hub.ingest(
    rrweb({
      type: EventType.IncrementalSnapshot,
      timestamp: ++clock,
      data: {
        source: IncrementalSource.Mutation,
        texts: [{ id: 5, value }],
        attributes: [],
        removes: [],
        adds: [],
      },
    } as unknown as eventWithTime),
  );
}

interface Harness {
  server: Server;
  viewerHub: ReturnType<typeof createViewerHub>;
  hubs: TabHub[];
  needs: string[];
  connect(): Promise<{ socket: WebSocket; received: Down[]; send(up: Up): void }>;
  close(): Promise<void>;
}

async function harness(liveTree: LiveTreeOptions | false = TREE): Promise<Harness> {
  const hubs = [readyHub("T1", liveTree), readyHub("T2", liveTree)];
  const needs: string[] = [];
  for (const hub of hubs) hub.onNeedSnapshot((reason) => void needs.push(`${hub.tabId}:${reason}`));
  const runtime = {
    sid: "s1",
    tabs: {
      hubs: () => hubs[Symbol.iterator](),
      hubFor: (tab: string) => hubs.find((hub) => hub.tabId === tab),
      activeTabId: "T1",
      tabsMessage: async () => ({ t: "tabs" as const, tabs: [] }),
      handle: async () => undefined,
    },
    browser: { ownsTarget: (tab: string) => hubs.some((hub) => hub.tabId === tab) },
    recovery: { isBlocked: () => false, status: () => [] },
    viewport: {
      gate: { inheritAgreement: () => true },
      handle: () => undefined,
      removeViewer: () => undefined,
      noteSnapshot: () => undefined,
    },
    input: Object.assign(async () => undefined, {
      valueStatusMessages: () => [],
      resetTab: () => undefined,
    }),
    pixels: { modeFor: () => "dom", handle: async () => undefined },
    account: { identity: { screen: undefined } },
  };
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const viewerHub = createViewerHub({
    server,
    e2e: true,
    publicOrigin: undefined,
    access: {
      sessionGrant: () => ({ runtime }),
      ownsSession: () => true,
      currentUser: () => ({ id: "u1" }),
    } as unknown as ViewerHubDeps["access"],
    upgradeSignedIn: () => true,
    registry: {
      get: () => runtime,
      ensure: async () => runtime,
      isClosing: () => false,
      sids: () => ["s1"][Symbol.iterator](),
    } as unknown as ViewerHubDeps["registry"],
    sessions: { get: () => undefined },
    pixelCapacity: {
      available: () => true,
      holder: () => undefined,
    } as unknown as ViewerHubDeps["pixelCapacity"],
    status: () => ({ t: "server-status" }) as unknown as ReturnType<ViewerHubDeps["status"]>,
    touch: () => undefined,
    build: () => undefined,
    isStopping: () => false,
    liveTree: liveTree !== false,
    report: () => undefined,
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    viewerHub,
    hubs,
    needs,
    async connect() {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?sid=s1&connectionKey=k${++clock}`, {
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      const received: Down[] = [];
      socket.on("message", (data) => received.push(decodeDown(data.toString())));
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      // The join's snapshots, and the tab list, which comes on its own.
      await until(
        () =>
          received.some((down) => down.t === "snapshot") &&
          received.some((down) => down.t === "tabs"),
      );
      return { socket, received, send: (up: Up) => socket.send(encodeMsg(up)) };
    },
    async close() {
      await viewerHub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function until(predicate: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let open: Harness | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
  resetPageSyncMetrics();
});

describe("viewer hub with the live tree", () => {
  it("says tree1 in hello, and answers any resync-req for that viewer alone", async () => {
    open = await harness();
    const viewer = await open.connect();
    const hello = viewer.received.find((down) => down.t === "hello");
    expect(hello?.t === "hello" && hello.caps).toContain("tree1");
    const before = viewer.received.length;
    const epoch = open.hubs[0]!.epoch;
    viewer.send({ t: "resync-req", tab: "T1", reason: "seq gap: expected 3, got 5" });
    await until(() => viewer.received.length >= before + 2);
    expect(viewer.received.slice(before).map((down) => down.t)).toEqual(["resync", "snapshot"]);
    const snapshot = viewer.received.at(-1)!;
    expect(snapshot).toMatchObject({ t: "snapshot", tab: "T1", epoch, seq: open.hubs[0]!.seq });
    // No page snapshot, no new epoch.
    expect(open.needs).toEqual([]);
    expect(open.hubs[0]!.epoch).toBe(epoch);
  });

  it("checks its tree with the page when one viewer keeps asking (storm breaker)", async () => {
    open = await harness();
    const viewer = await open.connect();
    for (let index = 0; index < 3; index++) {
      viewer.send({ t: "resync-req", tab: "T1", reason: "replay failed" });
      // Catch-ups closer than a second are coalesced: wait each one out.
      await new Promise((resolve) => setTimeout(resolve, 1_050));
    }
    await until(() => open!.needs.length > 0, 3_000);
    expect(open.needs).toEqual(["T1:resync"]);
    expect(pageSyncMetrics.pageSnapshots.verify).toBe(0);
  });

  it("sends a tab a viewer holds only its tail and caught-up on a switch", async () => {
    open = await harness();
    const viewer = await open.connect();
    const hub = open.hubs[1]!;
    // The viewer holds T2 at the seq its join gave it (parked).
    viewer.send({ t: "held", tabs: [["T2", hub.epoch, hub.seq + 1]] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = viewer.received.length;
    text(hub, "while away");
    text(hub, "while away 2");
    open.viewerHub.catchUpViewers("s1", "T2", hub);
    await until(() => viewer.received.length >= before + 2);
    const sent = viewer.received.slice(before);
    expect(sent.map((down) => down.t)).toEqual(["delta", "caught-up"]);
    expect(sent[0]).toMatchObject({ seq: hub.seq - 1 });
    expect(sent[1]).toEqual({ t: "caught-up", tab: "T2", epoch: hub.epoch, seq: hub.seq });
    expect(pageSyncMetrics.catchUp).toEqual({ tail: 1, synth: 0 });

    // A cursor out of the tail (or none) gets the tab's state instead.
    for (let index = 0; index < 60; index++) text(hub, `more ${index}`);
    const later = viewer.received.length;
    open.viewerHub.catchUpViewers("s1", "T2", hub);
    await until(() => viewer.received.length >= later + 2);
    expect(viewer.received.slice(later).map((down) => down.t)).toEqual(["resync", "snapshot"]);
    expect(open.needs).toEqual([]);
  });

  it("answers a resync-req naming a node with that node's subtree", async () => {
    open = await harness();
    const viewer = await open.connect();
    const hub = open.hubs[0]!;
    const before = viewer.received.length;
    viewer.send({ t: "resync-req", tab: "T1", reason: "editable", node: 4 });
    await until(() => viewer.received.length > before);
    const subtree = viewer.received.at(-1)!;
    expect(subtree).toMatchObject({ t: "subtree", tab: "T1", node: 4, seq: hub.seq });
    expect(pageSyncMetrics.subtree).toEqual({ served: 1, fallback: 0 });
    // An unknown node: the tab's state instead.
    const again = viewer.received.length;
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    viewer.send({ t: "resync-req", tab: "T1", reason: "editable", node: 999 });
    await until(() => viewer.received.length >= again + 2);
    expect(viewer.received.slice(again).map((down) => down.t)).toEqual(["resync", "snapshot"]);
    expect(pageSyncMetrics.subtree).toEqual({ served: 1, fallback: 1 });
  });

  it("without the tree, a resync-req still asks the page", async () => {
    open = await harness(false);
    const viewer = await open.connect();
    const hello = viewer.received.find((down) => down.t === "hello");
    expect(hello?.t === "hello" && (hello.caps ?? [])).not.toContain("tree1");
    viewer.send({ t: "resync-req", tab: "T1", reason: "seq gap" });
    await until(() => open!.needs.length > 0);
    expect(open.needs).toEqual(["T1:resync"]);
  });
});
