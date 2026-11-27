/**
 * What the workbench route modules are given: the stores, the session and account machinery, and
 * a few shared actions. Built once by the composition root (clients-main.ts).
 */
import type { ServerStatusMsg } from "@mirror/protocol";
import type { AssetLaneCounts } from "../assets/fetch";
import type { preHandlerAsyncHookHandler } from "fastify";
import type { SessionAccess } from "../auth/session-access";
import type { FrontendUser, UserStore } from "../auth/users";
import type { AccountPool } from "../browser/account-pool";
import type { BrowserPlatform } from "../browser/identity";
import type { createCpaRuntime } from "../cpa/runtime";
import type { CpaStore } from "../cpa/store";
import type { ProxyCatalog } from "../egress/catalog";
import type { ExitCheckLimiter } from "../egress/probe-limit";
import type { createRuntimeClient } from "../egress/runtime-client";
import type { ScopedExits } from "../egress/scoped-exits";
import type { ExitHealth } from "../egress/timezone";
import type { MailboxService } from "../mail/mailboxes";
import type { RemoteCcStore } from "../remote-cc/store";
import type { ClientRuntime } from "../session/client-runtime";
import type { createIdleReaper } from "../session/idle-reaper";
import type { createLifecycleLock } from "../session/lifecycle-lock";
import type { createProfileStore } from "../session/profiles";
import type { ClientSessions, SessionRuntimeRegistry } from "../session/runtime-registry";
import type { ViewerHub } from "../ws/viewer-hub";
import type { WorkspaceErrors } from "./workspace-errors";

export interface GatewayContext {
  /** Local replay fixtures: no exit node required, owners named by the request. */
  e2e: boolean;
  /** Orders account assignment, opening and deletion; input never waits here. */
  lock: ReturnType<typeof createLifecycleLock>;
  userStore: UserStore;
  accountStore: Awaited<ReturnType<typeof createProfileStore>>;
  clientSessions: ClientSessions;
  mailbox: MailboxService;
  remoteCcStore: RemoteCcStore;
  cpaStore: CpaStore | undefined;
  cpaRuntime: ReturnType<typeof createCpaRuntime> | undefined;
  proxyCatalog: ProxyCatalog;
  networkRuntime: ReturnType<typeof createRuntimeClient>;
  exits: ScopedExits;
  access: SessionAccess<ClientRuntime>;
  registry: SessionRuntimeRegistry<ClientRuntime>;
  accounts: AccountPool;
  hub: ViewerHub;
  workspace: WorkspaceErrors;
  idleReaper: ReturnType<typeof createIdleReaper>;
  /** The system identities a new profile may take; the first is the default. */
  platforms: readonly BrowserPlatform[];
  requirePlatform(value: unknown): BrowserPlatform;
  profileSystem(id: string): { platform: BrowserPlatform; browserEngine: string };
  /** Checks a node's exit through a throwaway process. */
  checkProxy(user: FrontendUser, nodeId: string): Promise<ExitHealth>;
  /** Bounds the exit checks running at once, per user and in all. */
  exitChecks: ExitCheckLimiter;
  /** The guard of a route that serves one workspace (`:sid`). */
  requireSession(): preHandlerAsyncHookHandler;
  status(sid?: string): ServerStatusMsg;
  /** How page assets were fetched since start (browser, blob, direct, refused), counts only. */
  assetLanes(): AssetLaneCounts;
  isStopping(): boolean;
  report(message: string, error: unknown): void;
}
