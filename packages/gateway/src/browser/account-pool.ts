/**
 * One Chrome per browser profile ("account"), opened on demand and shared by the profile's
 * workspaces: it owns the login tracker, the shared download manager, and which frame and CDP
 * session belong to which workspace. Accounts close when their Chrome dies or nobody used them for
 * a while; the session registry decides what happens to their workspaces.
 */
import type { Down } from "@mirror/protocol";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FrontendUser } from "../auth/users";
import { createClaudeLoginTracker } from "../claude/signed-in";
import { createThemeCopies, type ClaudeTheme } from "../claude/theme";
import { createDownloadManager } from "../downloads";
import type { ProxyCatalog } from "../egress/catalog";
import type { ExitMetadata } from "../egress/timezone";
import { ClientSessionError } from "../session/clients";
import { DEFAULT_PROFILE, type createProfileStore } from "../session/profiles";
import type { TargetRef } from "../types";
import { timed } from "../timing";
import { createAgentLink, type VoiceAgentMsg } from "./agentlink";
import { callAgentBridge } from "./bridge";
import { launchBrokerBrowser, prepareBrokerBrowser, stopBrokerBrowser } from "./broker";
import { installZoomExtension } from "./browser-zoom";
import { afterSignInUrl, createClientBrowserPool } from "./client-scope";
import { createAccountDisplay, type AccountDisplay } from "./display";
import { profileBrowserOptions } from "./engine";
import { identityEnvironment, type BrowserIdentity } from "./identity";
import { launchBrowser, type BrowserHandle, type BrowserTargetInfo } from "./launch";
import { createPhoneTargetPreparer, waitForOwner } from "./phone-identity";
import { connectRemoteBrowser } from "./remote";

/** One account: its Chrome, and what the gateway keeps for that Chrome. */
export interface Account extends ExitMetadata {
  id: string;
  dir: string;
  browser: BrowserHandle;
  proxyUrl?: string;
  display?: AccountDisplay;
  identity: BrowserIdentity;
  pool: ReturnType<typeof createClientBrowserPool>;
  login: ReturnType<typeof createClaudeLoginTracker>;
  agent: ReturnType<typeof createAgentLink>;
  themeCopies: ReturnType<typeof createThemeCopies>;
  downloads: Awaited<ReturnType<typeof createDownloadManager>>;
  zoomReady: boolean;
  frameOwners: Map<string, string>;
  sessionTargets: Map<string, string>;
  /** Since when no session has used it. */
  unusedSince: number | null;
}

/** A workspace's pages, as the account sees them. */
export interface WorkspacePages {
  browser: { send(sessionId: string, method: string, params?: object): Promise<unknown> };
  targets: ReadonlyMap<string, TargetRef>;
  metadata: ReadonlyMap<string, BrowserTargetInfo>;
}

/** Headroom for another Chrome plus its private Xvfb display before the first page. */
export const ACCOUNT_MEMORY_BYTES = 560 * 1048576;

export const CHROME_ARGS = [
  "--disable-dev-shm-usage",
  // Nobody is at this browser to click: Claude's sound starts without a gesture here, and the
  // viewer's own browser applies its own rule.
  "--autoplay-policy=no-user-gesture-required",
  // This host is short of memory rather than of JavaScript speed, and new windows are rare
  // enough not to need a renderer waiting for them.
  "--js-flags=--optimize-for-size",
  "--disable-features=SpareRendererForSitePerProcess",
  // Sessions share the profile now, so a restart would otherwise offer to restore them.
  "--hide-crash-restore-bubble",
  // Only over this private pipe: it lets the picture's zoom extension be loaded below.
  "--enable-unsafe-extension-debugging",
];

export interface AccountPoolDeps {
  e2e: boolean;
  /** Where the default profile's Chrome keeps its data, and the other profiles theirs. */
  defaultBrowserDirectory: string;
  accountsDir: string;
  profiles: Awaited<ReturnType<typeof createProfileStore>>;
  /** The user a profile belongs to. */
  profileUser(profileId: string): FrontendUser | undefined;
  proxyCatalog: Pick<ProxyCatalog, "getNodeConfig">;
  memoryShort(extraBytes: number): Promise<boolean>;
  isPhoneSession(sid: string): boolean;
  isClosing(sid: string): boolean;
  /** The running workspaces on the account. */
  workspacesOn(accountId: string): Iterable<WorkspacePages>;
  themeOf(sid: string): ClaudeTheme;
  publish(sid: string, message: Down): void;
  /** A page started or stopped using the microphone, or sent sound. */
  onVoice(sid: string, tab: string, message: VoiceAgentMsg, account: VoiceTarget): void;
  /** A page's website-notification message (see notify/relay.ts). */
  onNotify?(sid: string, tab: string, message: object): void;
  report(message: string, error: unknown): void;
}

export type VoiceTarget = Pick<Account, "browser" | "sessionTargets">;

export type AccountPool = ReturnType<typeof createAccountPool>;

export function createAccountPool(deps: AccountPoolDeps) {
  const { profiles, report } = deps;
  const accounts = new Map<string, Account>();
  const opening = new Map<string, Promise<Account>>();
  const accountDir = (id: string) =>
    id === DEFAULT_PROFILE ? deps.defaultBrowserDirectory : join(deps.accountsDir, id);

  async function buildAccount(
    id: string,
    dir: string,
    browser: BrowserHandle,
    identity: BrowserIdentity,
    exit: ExitMetadata,
    display?: AccountDisplay,
  ): Promise<Account> {
    const zoomReady = await installZoomExtension(
      browser,
      join(dir, "zoom-extension"),
      identity.fingerprint?.platform === "windows" ? "/C:/zoom-extension" : undefined,
    ).then(
      () => true,
      (error: unknown) => {
        console.warn("The picture will stop at CSS pixels:", (error as Error).message);
        return false;
      },
    );
    const frameOwners = new Map<string, string>();
    const sessionTargets = new Map<string, string>();
    const login = createClaudeLoginTracker(browser, sessionTargets, {
      email: profiles.get(id)?.email,
      signedIn: profiles.get(id)?.signedIn,
      unavailable: profiles.get(id)?.unavailable,
      save: (login) => profiles.setLogin(id, login),
    });
    const pool = createClientBrowserPool(browser, {
      windowSize: identity.screen,
      onSignedIn: () => {
        for (const workspace of deps.workspacesOn(id))
          for (const target of workspace.targets.values()) {
            if (target.type !== "page") continue;
            const destination = afterSignInUrl(workspace.metadata.get(target.targetId)?.url);
            if (destination === null) continue;
            void workspace.browser
              .send(target.sessionId, "Page.navigate", { url: destination })
              .catch((error) => report("shared login navigation failed", error));
          }
      },
      onLoginState: login.observe,
    });
    const sessionFrames = createSessionFrames(frameOwners);
    browser.onAttached((target) => sessionTargets.set(target.sessionId, target.targetId));
    browser.onDetached((target) => {
      if (sessionTargets.get(target.sessionId) === target.targetId)
        sessionTargets.delete(target.sessionId);
      sessionFrames.detached(target.sessionId);
    });
    browser.onSessionEvent("Page.frameNavigated", (session, event) => {
      const target = sessionTargets.get(session),
        owner = target ? pool.ownerOf(target) : undefined;
      if (owner) sessionFrames.navigated(session, event.frame, owner);
    });
    const preparePhoneTarget = createPhoneTargetPreparer({
      send: browser.send,
      ownerOf: (targetId) => pool.ownerOf(targetId),
      isPhoneSession: deps.isPhoneSession,
      screen: identity.screen,
      onError: (error) => report("phone identity failed", error),
    });
    const themeCopies = createThemeCopies(browser.send);
    browser.onDetached((target) => themeCopies.forget(target.sessionId));
    const prepareThemeCopy = async (target: TargetRef): Promise<void> => {
      if (target.type !== "page") return;
      const owner = await waitForOwner(target, { ownerOf: (targetId) => pool.ownerOf(targetId) });
      if (owner === undefined) return;
      void themeCopies
        .install(target.sessionId, deps.themeOf(owner), true)
        .catch((error) => report("client theme failed", error));
    };
    const agent = createAgentLink(browser, {
      prepareTarget: async (target) => {
        await Promise.all([preparePhoneTarget(target), prepareThemeCopy(target)]);
      },
      publishClipboard(message, target) {
        const sid = pool.ownerOf(target);
        if (sid) deps.publish(sid, message);
      },
      publishVoice(message, target) {
        const sid = pool.ownerOf(target);
        if (sid) deps.onVoice(sid, target, message, { browser, sessionTargets });
      },
      publishNotify(message, target) {
        // Only the session whose window holds the page hears about its notifications.
        const sid = pool.ownerOf(target);
        if (sid && !deps.isClosing(sid)) deps.onNotify?.(sid, target, message);
      },
    });
    const downloadDir = join(dir, "downloads");
    await mkdir(downloadDir, { recursive: true });
    const downloads = await createDownloadManager({
      sessionId: "shared-account",
      browser,
      downloadDir,
      sessionForFrame: (frame) => {
        const sid = frameOwners.get(frame) ?? pool.ownerOf(frame);
        return sid && !deps.isClosing(sid) ? sid : undefined;
      },
      publish: (message, sid) => deps.publish(sid, message),
      onError: (error) => report("client download failed", error),
    });
    return {
      id,
      dir,
      ...exit,
      browser,
      identity,
      display,
      pool,
      login,
      agent,
      themeCopies,
      downloads,
      zoomReady,
      frameOwners,
      sessionTargets,
      unusedSince: null,
    };
  }

  /** Refuses a profile without an exit node; local fixtures (MIRROR_E2E) run without one. */
  function requireBrowserExit(id: string): void {
    if (!deps.e2e && !profiles.get(id)?.proxyId)
      throw new ClientSessionError(409, "EXIT_REQUIRED", "请先为浏览器配置选择出口节点");
  }

  /** The account's Chrome, started if it is not running. */
  async function open(id: string): Promise<Account> {
    requireBrowserExit(id);
    const running = accounts.get(id);
    if (running) return running;
    let pending = opening.get(id);
    if (!pending) {
      pending = (async () => {
        if (!profiles.has(id)) throw new ClientSessionError(404, "PROFILE_UNKNOWN", "没有这个账号");
        if (id !== DEFAULT_PROFILE) {
          if (process.env.BROWSER_CDP_URL)
            throw new ClientSessionError(
              503,
              "PROFILE_UNSUPPORTED",
              "连接外部浏览器时只能用一个账号",
            );
        }
        if (!deps.e2e && (await deps.memoryShort(ACCOUNT_MEMORY_BYTES)))
          throw new ClientSessionError(
            503,
            "PROFILE_RESOURCES",
            "内存不足以启动另一个浏览器，请等待空闲会话自动回收",
          );
        const dir = accountDir(id);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const external = id === DEFAULT_PROFILE && !!process.env.BROWSER_CDP_URL;
        const identity = profiles.identity(id);
        const proxyId = profiles.get(id)!.proxyId;
        let node: unknown;
        if (proxyId) {
          if (!process.env.MIRROR_RUNTIME_SOCKET || external)
            throw new ClientSessionError(
              503,
              "PROXY_RUNTIME_DISABLED",
              "当前部署未启用独立浏览器出口",
            );
          const owner = deps.profileUser(id);
          if (!owner?.enabled)
            throw new ClientSessionError(403, "PROFILE_FORBIDDEN", "这个浏览器所属用户已停用");
          node = deps.proxyCatalog.getNodeConfig(owner, proxyId);
        }
        // The exit's network and lookup start while the display does: neither needs the other.
        const preparing =
          node === undefined ? undefined : timed("prepare", () => prepareBrokerBrowser(id, node));
        let display: AccountDisplay | undefined;
        let browser: BrowserHandle | undefined;
        let proxyUrl: string | undefined;
        let exit: ExitMetadata;
        try {
          const [, created] = await Promise.allSettled([
            preparing,
            !external && process.env.CHROME_HEADFUL === "1"
              ? timed("display", createAccountDisplay)
              : undefined,
          ]);
          if (created.status === "rejected") throw created.reason;
          display = created.value;
          await preparing;
          const engine = profileBrowserOptions(identity);
          const launchOptions = {
            userDataDir: dir,
            engine: engine.engine,
            executablePath: engine.executablePath,
            headful: process.env.CHROME_HEADFUL === "1",
            enableExtensions: true,
            args: [
              ...CHROME_ARGS,
              ...engine.args,
              `--window-size=${identity.screen.width},${identity.screen.height}`,
            ],
            env: { ...display?.env, ...(await identityEnvironment(dir, identity)) },
          };
          if (node !== undefined) {
            // The zone this profile's exit had last time lets the browser start before the
            // lookup confirms it (see startBrowser in deploy/profile-broker.mjs).
            const {
              browser: opened,
              proxyUrl: endpoint,
              ...metadata
            } = await timed("broker", () =>
              launchBrokerBrowser(id, node, launchOptions, profiles.get(id)?.timeZone),
            );
            browser = opened;
            proxyUrl = endpoint;
            exit = metadata;
          } else {
            // Local replay fixtures explicitly opt into MIRROR_E2E; production requires a node.
            exit = { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
            browser = external
              ? await connectRemoteBrowser(process.env.BROWSER_CDP_URL!)
              : await launchBrowser({
                  ...launchOptions,
                  env: { ...launchOptions.env, TZ: exit.timeZone },
                });
          }
          const account = await timed("account", () =>
            buildAccount(id, dir, browser!, identity, exit, display),
          );
          account.proxyUrl = proxyUrl;
          await profiles.setExitMetadata(id, exit);
          accounts.set(id, account);
          return account;
        } catch (error) {
          if (browser) await browser.close().catch(() => {});
          // A prepared exit with no browser yet: the runtime removes it with the browser.
          else if (preparing) await stopBrokerBrowser(id).catch(() => {});
          await display?.close();
          throw error;
        }
      })();
      opening.set(id, pending);
      void pending
        .finally(() => {
          if (opening.get(id) === pending) opening.delete(id);
        })
        .catch(() => {});
    }
    return pending;
  }

  async function close(account: Account): Promise<void> {
    if (accounts.get(account.id) === account) accounts.delete(account.id);
    account.login.dispose();
    account.downloads.close();
    account.pool.dispose();
    await account.browser.close().catch(() => {});
    await account.display?.close();
  }

  return {
    get: (id: string) => accounts.get(id),
    has: (id: string) => accounts.has(id),
    get size() {
      return accounts.size;
    },
    values: () => [...accounts.values()],
    /** Where a profile's Chrome keeps its data. */
    accountDir,
    requireBrowserExit,
    open,
    close,
    /** Closes the profile's Chrome, waiting for one still starting. */
    async closeProfile(id: string, ignoreOpenFailure = false): Promise<void> {
      const starting = opening.get(id);
      const account =
        accounts.get(id) ??
        (await (ignoreOpenFailure ? starting?.catch(() => undefined) : starting));
      if (account) await close(account);
    },
    /** Whether every running Chrome still answers. */
    allAlive: () =>
      [...accounts.values()].every((account) => account.browser.isAlive?.() !== false),
    /** The CDP session's Chrome: a CDP session belongs to one Chrome, and so to one account. */
    send(sessionId: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
      const owner = [...accounts.values()].find((account) => account.sessionTargets.has(sessionId));
      return owner
        ? owner.browser.send(sessionId, method, params)
        : Promise.reject(new Error("Unknown browser session"));
    },
    /**
     * Closes the windows of a workspace being torn down and waits until they are gone. Its
     * runtime closes them when it got that far; otherwise its scope on the account does.
     */
    async closeWorkspaceWindows(
      sid: string,
      profileId: string,
      runtime: { account: Account; stop(): Promise<void> } | undefined,
    ): Promise<void> {
      const account = runtime?.account ?? accounts.get(profileId);
      account?.downloads.revokeSession(sid);
      if (!account) return;
      if (runtime) await runtime.stop();
      else await account.pool.scope(sid).close();
      const pages = () =>
        account.pool
          .scope(sid)
          .targets()
          .some((target) => target.type === "page");
      const deadline = Date.now() + 2000;
      while (pages() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (pages()) throw new Error("Client window did not close");
      for (const [frame, session] of account.frameOwners)
        if (session === sid) account.frameOwners.delete(frame);
    },
    /**
     * Watches every 2 s for a Chrome that died. Its workspaces are closed first (onDead), inside
     * `run`, so that no other lifecycle step reuses a session or profile before the cleanup.
     */
    watchHealth(options: {
      run(task: () => Promise<void>): Promise<void>;
      isStopping(): boolean;
      onDead(account: Account): Promise<void>;
    }): () => void {
      let pending = false;
      const timer = setInterval(() => {
        if (options.isStopping() || pending) return;
        pending = true;
        void options
          .run(async () => {
            if (options.isStopping()) return;
            for (const account of [...accounts.values()]) {
              if (account.browser.isAlive?.() !== false) continue;
              console.error(`Chrome for account ${account.id} died; closing its sessions`);
              await options.onDead(account);
              await close(account);
            }
          })
          .catch((error) => report("browser health recovery", error))
          .finally(() => {
            pending = false;
          });
      }, 2000);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    /** Closes accounts nobody has used for `idleMs`. */
    async closeUnused(inUse: (id: string) => boolean, idleMs: number, now = Date.now()) {
      for (const account of [...accounts.values()]) {
        if (inUse(account.id)) {
          account.unusedSince = null;
          continue;
        }
        account.unusedSince ??= now;
        if (now - account.unusedSince >= idleMs)
          await close(account).catch((error) => report("account close failed", error));
      }
    },
    /** Shutdown. */
    async closeAll(): Promise<void> {
      for (const account of [...accounts.values()]) await close(account);
    },
  };
}

/** Sends a microphone state or sound to the page showing `tab`, if it still does. */
/** Frames a CDP session reported, kept only as long as they can exist. */
export const MAX_FRAMES_PER_SESSION = 1024;

/**
 * Keeps `frameOwners` to the frames that can still exist: a page's main frame committing a new
 * document takes every frame of the old one with it, a detached session takes all of its frames,
 * and a page that keeps creating frames without navigating keeps only its most recent ones.
 */
export function createSessionFrames(frameOwners: Map<string, string>) {
  const bySession = new Map<string, Set<string>>();
  /** A frame swapped into another process is reported by both sessions; the other keeps it. */
  const drop = (frame: string) => {
    for (const frames of bySession.values()) if (frames.has(frame)) return;
    frameOwners.delete(frame);
  };
  return {
    navigated(session: string, frame: { id: string; parentId?: string }, owner: string): void {
      let frames = bySession.get(session);
      if (!frames) bySession.set(session, (frames = new Set()));
      const gone: string[] = [];
      if (frame.parentId === undefined)
        for (const other of frames) if (other !== frame.id) gone.push(other);
      frames.delete(frame.id);
      frames.add(frame.id);
      for (const oldest of frames) {
        if (frames.size - gone.length <= MAX_FRAMES_PER_SESSION) break;
        if (!gone.includes(oldest)) gone.push(oldest);
      }
      for (const other of gone) {
        frames.delete(other);
        drop(other);
      }
      frameOwners.set(frame.id, owner);
    },
    detached(session: string): void {
      const frames = bySession.get(session);
      bySession.delete(session);
      for (const frame of frames ?? []) drop(frame);
    },
    /** Sessions with frames kept (tests). */
    get sessions(): number {
      return bySession.size;
    },
  };
}

export function sendVoice(
  account: VoiceTarget,
  tab: string,
  value: { state: boolean } | { pcm: string },
): void {
  const session = [...account.sessionTargets].find(([, target]) => target === tab)?.[0];
  if (session)
    void callAgentBridge(account.browser, session, "voice", [value]).catch(() => {
      // The page navigated away, which ends its use of the microphone as well.
    });
}

/** Delivers a website-notification message (NotifyAgentIn) to a page's agent. */
export function sendNotify(account: VoiceTarget, tab: string, value: object): void {
  const session = [...account.sessionTargets].find(([, target]) => target === tab)?.[0];
  if (session)
    void callAgentBridge(account.browser, session, "notify", [value]).catch(() => {
      // The page navigated away; its next document says hello again.
    });
}
