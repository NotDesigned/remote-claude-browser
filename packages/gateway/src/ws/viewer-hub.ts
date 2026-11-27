/**
 * The workspaces' viewers: who is connected to which session, the WebSocket server's callbacks
 * (upgrade, join, leave, each viewer message) and the messages they send to a workspace's browser.
 * Sessions reach their viewers through publish().
 */
import {
  encodeMsg,
  LOCAL_RESYNC_REASON,
  type Down,
  type ServerStatusMsg,
  type Up,
} from "@mirror/protocol";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { isOwnOrigin } from "../auth/origin";
import type { SessionAccess } from "../auth/session-access";
import { sendVoice, type VoiceTarget } from "../browser/account-pool";
import type { VoiceAgentMsg } from "../browser/agentlink";
import { ackCaps, inputAckConfig, proxyInputConfig } from "../input/acks";
import type { InputMsg } from "../input/relay";
import type { PixelCapacity } from "../px-capacity";
import type { ClientRuntime } from "../session/client-runtime";
import type { ClientSessions, SessionRuntimeRegistry } from "../session/runtime-registry";
import { createRoleManager } from "./roles";
import { createWsServer } from "./server";
import type { ViewerConn } from "./viewerconn";

/** Frames wait before encoding beyond this, since a viewer cannot skip one once it is encoded. */
const VIDEO_BACKLOG_BYTES = 512 * 1024;

/** The close code that tells a viewer its session ended for good. */
export const SESSION_ENDED_CODE = 4010;

export interface ViewerHubDeps {
  server: HttpServer;
  e2e: boolean;
  publicOrigin: string | undefined;
  access: Pick<SessionAccess<ClientRuntime>, "sessionGrant" | "ownsSession" | "currentUser">;
  /** The login and device cookies a WebSocket upgrade needs (not checked for e2e fixtures). */
  upgradeSignedIn(request: IncomingMessage): boolean;
  registry: Pick<SessionRuntimeRegistry<ClientRuntime>, "get" | "ensure" | "isClosing" | "sids">;
  sessions: Pick<ClientSessions, "get">;
  pixelCapacity: PixelCapacity;
  status(sid?: string): ServerStatusMsg;
  /** A viewer came back to the session: its idle clock restarts. */
  touch(sid: string): void;
  /** The viewer build identifier, read again for each connection. */
  build(): string | undefined;
  isStopping(): boolean;
  /** Someone started or stopped looking at the session (a viewer connected or left). */
  onPresence?(sid: string): void;
  report(message: string, error: unknown): void;
}

interface Connection {
  viewer: ViewerConn;
  sid: string;
  userId: string;
  authorized(): boolean;
}

export type ViewerHub = ReturnType<typeof createViewerHub>;

export function createViewerHub(deps: ViewerHubDeps) {
  const { registry, access, pixelCapacity, report } = deps;
  const viewerIds = new WeakMap<ViewerConn, string>();
  const viewers = new Map<string, Connection>();
  /** Tabs whose page is using its microphone (and their session), for a viewer that connects. */
  const micTabs = new Map<string, string>();
  let nextViewer = 1;
  const hasViewer = (sid: string) =>
    [...viewers.values()].some((connection) => connection.sid === sid);
  const onlineSessions = () => new Set([...viewers.values()].map((connection) => connection.sid));
  const caps = ackCaps(inputAckConfig().acks, proxyInputConfig());
  const roles = createRoleManager({
    // Read for each connection: deploy-viewer.sh publishes a viewer without restarting this.
    build: deps.build,
    caps: () => caps,
    onDriverChange(change) {
      const runtime = registry.get(change.sessionId);
      if (runtime && change.viewport) runtime.viewport.handle(change.to, change.viewport);
    },
  });
  const sidFromRequest = (request: IncomingMessage) =>
    new URL(request.url ?? "/", "http://local").searchParams.get("sid") ?? undefined;

  function publish(sid: string, message: Down) {
    if (deps.isStopping() || registry.isClosing(sid)) return;
    if (message.t === "snapshot") {
      const reason = registry.get(sid)?.viewport.noteSnapshot(message);
      if (reason !== undefined) message.reason = reason;
    }
    ws.fanout.publishToSession(sid, message);
  }
  function broadcastStatus() {
    if (deps.isStopping()) return;
    for (const sid of registry.sids()) publish(sid, deps.status(sid));
  }
  async function stopPixels(runtime: ClientRuntime, exceptTab?: string) {
    const holder = pixelCapacity.holder(runtime.sid);
    if (holder?.sid === runtime.sid && holder.tab !== exceptTab)
      await runtime.pixels.handle({ t: "mode", tab: holder.tab, mode: "dom" });
  }

  /** One viewer message for the session's browser, once its role allowed it. */
  async function handle(runtime: ClientRuntime, id: string, message: Up) {
    // Input that never reaches the relay is still answered, as refused, in the tab's queue: an
    // ack must not cover input still queued before it.
    if ("tab" in message && message.tab && !runtime.browser.ownsTarget(message.tab)) {
      if (isInput(message)) runtime.acks?.refuse(id, message);
      return;
    }
    if ((isInput(message) || message.t === "mode") && runtime.recovery.isBlocked(message.tab)) {
      if (isInput(message)) runtime.acks?.refuse(id, message);
      return;
    }
    if (message.t === "view" || message.t === "view-ack") {
      runtime.viewport.handle(id, message);
      // A viewer that has just come back needs to know the page is still listening.
      if (message.t === "view" && micTabs.has(message.tab))
        publish(runtime.sid, { t: "mic", tab: message.tab, on: true });
      return;
    }
    if (message.t === "mic-pcm") {
      sendVoice(runtime.account, message.tab, { pcm: message.pcm });
      return;
    }
    if (message.t === "mic-state") {
      if (!message.ok) micTabs.delete(message.tab);
      sendVoice(runtime.account, message.tab, { state: message.ok });
      return;
    }
    if (message.t === "resync-req") {
      ws.fanout.flushSession(runtime.sid);
      const hub = runtime.tabs.hubFor(message.tab);
      const viewer = viewers.get(id)?.viewer;
      // This viewer's typing echo went its own way; the stream itself is fine, so the cached
      // state answers it without making every viewer rebuild from a new page snapshot.
      if (message.reason === LOCAL_RESYNC_REASON && hub !== undefined && viewer !== undefined) {
        viewer.requestCatchUp(message.tab, () => hub.joinPayload());
        return;
      }
      hub?.requestSnapshot("resync");
      return;
    }
    if (message.t === "vid-key") {
      runtime.pixels.requestKeyframe(message.tab);
      return;
    }
    if (message.t === "mode") {
      await runtime.pixels.handle(message);
      publish(runtime.sid, { t: "px-capacity", available: pixelCapacity.available() });
      return;
    }
    if (message.t === "rtc-sig") {
      await runtime.rtc?.handleViewer(id, message);
      return;
    }
    if (message.t === "nav") {
      if (message.action === "newtab" || message.action === "activate")
        await stopPixels(runtime, message.action === "activate" ? message.tab : undefined);
      if (["newtab", "close", "activate"].includes(message.action)) {
        await runtime.tabs.handle(message);
      } else {
        // An address that does not load is an ordinary outcome, shown as a failed page. Letting this
        // propagate would close the viewer's connection, which is how it would hear about that page.
        await runtime.navigation
          .handle(message)
          .catch((error) => report("client navigation failed", error));
      }
      return;
    }
    if (isInput(message)) await runtime.input(id, message);
  }

  const ws = createWsServer({
    server: deps.server,
    replaceSessionOnConnect: true,
    requireConnectionKey: true,
    hubsForSession: (sid) => registry.get(sid)?.tabs.hubs() ?? [],
    sessionForRequest: (request) => {
      const sid = sidFromRequest(request);
      return sid && access.sessionGrant(request, sid)?.runtime ? sid : undefined;
    },
    authorizeUpgrade: async (request) => {
      if (!deps.e2e && !deps.upgradeSignedIn(request)) return false;
      // Browsers always send Origin on a WebSocket handshake; without a configured public
      // origin it must at least name the host the handshake was sent to.
      if (!isOwnOrigin(request.headers.origin, request.headers.host, deps.publicOrigin))
        return false;
      const sid = sidFromRequest(request);
      if (!sid || !access.sessionGrant(request, sid)) return false;
      try {
        await registry.ensure(sid);
        return !!access.sessionGrant(request, sid);
      } catch (error) {
        report("client websocket unavailable", error);
        return false;
      }
    },
    onConnection(viewer, request, sid, resumable) {
      const id = `viewer-${nextViewer++}`;
      viewerIds.set(viewer, id);
      viewers.set(id, {
        viewer,
        sid,
        userId: access.currentUser(request)!.id,
        authorized: () => access.ownsSession(request, sid),
      });
      deps.touch(sid);
      const runtime = registry.get(sid)!;
      // A reconnect whose replay position is still buffered keeps its geometry agreement: the
      // epoch did not change, so this viewer identity inherits the acknowledgement directly. One
      // that cannot inherit it is not resumed at all: its join payload then carries a snapshot,
      // as its `hello` says, rather than deltas the viewer would wait in vain to see completed.
      const accepted = resumable.filter((cursor) =>
        runtime.viewport.gate.inheritAgreement(id, cursor.tab),
      );
      const resumed = accepted.map((cursor) => cursor.tab);
      roles.connect({
        sessionId: sid,
        inviteRole: "driver",
        viewerId: id,
        send: (message, serialized) => viewer.send(message, serialized),
        viewportLimit: deps.sessions.get(sid)?.phone ? undefined : runtime.account.identity.screen,
        resumed,
      });
      const mode = {
        t: "mode",
        tab: runtime.tabs.activeTabId ?? "",
        mode: runtime.pixels.modeFor(runtime.tabs.activeTabId ?? "") ?? "dom",
      } as const;
      viewer.send(mode, encodeMsg(mode));
      for (const message of runtime.recovery.status()) viewer.send(message, encodeMsg(message));
      // After `hello`, which resets the viewer's idea of every tab's field sync.
      for (const message of runtime.input.valueStatusMessages())
        viewer.send(message, encodeMsg(message));
      const capacity = { t: "px-capacity", available: pixelCapacity.available() } as const;
      viewer.send(capacity, encodeMsg(capacity));
      const currentStatus = deps.status(sid);
      viewer.send(currentStatus, encodeMsg(currentStatus));
      broadcastStatus();
      deps.onPresence?.(sid);
      void runtime.tabs
        .tabsMessage()
        .then((message) => viewer.send(message, encodeMsg(message)))
        .catch((error) => report("client tabs unavailable", error));
      return accepted;
    },
    onDisconnection(viewer, sid) {
      const id = viewerIds.get(viewer);
      if (!id) return;
      roles.disconnect(id);
      viewers.delete(id);
      const runtime = registry.get(sid);
      runtime?.viewport.removeViewer(id);
      runtime?.rtc?.removeViewer(id);
      if (runtime && !hasViewer(sid)) {
        for (const hub of runtime.tabs.hubs()) runtime.input.resetTab(hub.tabId);
        void stopPixels(runtime).catch((error) => report("disconnected pixel cleanup", error));
      }
      broadcastStatus();
      deps.onPresence?.(sid);
    },
    async onUp(viewer, message, sid) {
      const id = viewerIds.get(viewer),
        connection = id ? viewers.get(id) : undefined;
      if (!id || !connection || !connection.authorized() || registry.isClosing(sid)) return;
      const runtime = registry.get(sid);
      if (!runtime) return;
      // A valid driver is still forbidden from naming another client's CDP target.
      if ("tab" in message && message.tab !== "" && !runtime.browser.ownsTarget(message.tab)) {
        if (isInput(message)) runtime.acks?.refuse(id, message);
        return;
      }
      const routed = await roles.routeUp(id, message, (forwarded) =>
        handle(runtime, id, forwarded),
      );
      // Input of a viewer that no longer drives (it was on its way when the role moved).
      if (routed === "dropped" && isInput(message)) runtime.acks?.refuse(id, message);
    },
  });
  // Full snapshots are the heavy part of page sync: how often, why, how big and how slow.
  ws.fanout.onSnapshot = (sid, message, bytes) => {
    const ms = registry.get(sid)?.tabs.hubFor(message.tab)?.lastSnapshotMs;
    console.log(
      `snapshot: ${sid} ${message.reason ?? "page"} ${(bytes / 1048576).toFixed(1)} MB` +
        (ms === null || ms === undefined ? "" : ` in ${ms} ms`),
    );
  };

  return {
    publish,
    broadcastStatus,
    onlineSessions,
    /** How many devices have a viewer connected. */
    onlineOwnerCount(): number {
      const owners = new Set<string>();
      for (const sid of onlineSessions()) {
        const owner = deps.sessions.get(sid)?.owner;
        if (owner !== undefined) owners.add(owner);
      }
      return owners.size;
    },
    isDriver: (viewerId: string, sid: string) =>
      roles.isDriver(viewerId) && viewers.get(viewerId)?.sid === sid,
    backlogged: (sid: string) =>
      [...viewers.values()].some(
        (connection) =>
          connection.sid === sid && connection.viewer.socket.bufferedAmount > VIDEO_BACKLOG_BYTES,
      ),
    sendViewer(viewerId: string, sid: string, message: Down): boolean {
      const connection = viewers.get(viewerId);
      return connection?.sid === sid
        ? (connection.viewer.send(message, encodeMsg(message)) ?? false)
        : false;
    },
    /** A page of the session started or stopped using its microphone, or sent sound. */
    onVoice(sid: string, tab: string, message: VoiceAgentMsg, account: VoiceTarget): void {
      if ("audio" in message) {
        publish(sid, { t: "audio", tab, pcm: message.audio });
        return;
      }
      if (message.mic) micTabs.set(tab, sid);
      else micTabs.delete(tab);
      publish(sid, { t: "mic", tab, on: message.mic });
      // With nobody connected there is no device to ask, so the page should not wait for one.
      if (message.mic && !hasViewer(sid)) sendVoice(account, tab, { state: false });
    },
    /** Ends the session's connections; with `ended`, they are told it is over for good. */
    disconnectSession(sid: string, ended: boolean): void {
      // Its windows are about to close; a new runtime's pages announce their microphone again.
      for (const [tab, owner] of micTabs) if (owner === sid) micTabs.delete(tab);
      ws.closeSession(sid, ended ? SESSION_ENDED_CODE : undefined);
      for (const [id, connection] of viewers)
        if (connection.sid === sid) {
          roles.disconnect(id);
          viewers.delete(id);
        }
      deps.onPresence?.(sid);
    },
    /** Brings a tab of the session to the front, as the tab strip does. */
    async activateTab(sid: string, tab: string): Promise<void> {
      const runtime = registry.get(sid);
      if (!runtime || registry.isClosing(sid) || !runtime.browser.ownsTarget(tab)) return;
      await stopPixels(runtime, tab);
      await runtime.tabs.handle({ t: "nav", tab, action: "activate" });
    },
    /** A tab of the session went away. */
    forgetTab(sid: string, tab: string): void {
      if (micTabs.get(tab) === sid) micTabs.delete(tab);
    },
    /** Tabs remembered as using their microphone (tests). */
    get micTabCount(): number {
      return micTabs.size;
    },
    /** The session ended for good: forget its connection ordering. */
    forgetSession: (sid: string) => ws.forgetSession(sid),
    /** Closes (for reconnection) every session a user is viewing. */
    closeUserSessions(userId: string): void {
      for (const connection of viewers.values())
        if (connection.userId === userId) ws.closeSession(connection.sid);
    },
    /** Closes the sessions of a user's viewers whose login no longer holds. */
    closeRevoked(userId: string): void {
      for (const connection of [...viewers.values()])
        if (connection.userId === userId && !connection.authorized())
          ws.closeSession(connection.sid);
    },
    /** Closes the sessions of every viewer whose login no longer holds. */
    closeUnauthorized(): void {
      for (const connection of viewers.values())
        if (!connection.authorized()) ws.closeSession(connection.sid);
    },
    close: () => ws.close(),
  };
}

function isInput(message: Up): message is InputMsg {
  return ["ptr", "key", "text", "value", "ime", "scroll"].includes(message.t);
}
