/**
 * Short-lived remote-cc flows, kept in memory (a restart only cancels pending ones):
 * - device approvals: remote-cc asks for a token, the user approves it in the workbench;
 * - session grants: signed claims "this user may run profile P through node N", which
 *   only an egress host can redeem for the node's configuration;
 * - one-click logins: a Claude Code sign-in link opened in the profile's browser, whose
 *   callback code goes back to remote-cc.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { RemoteCcError, type RemoteCcTokenKind } from "./store";

// ---------------------------------------------------------------- device approvals

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const DEVICE_TTL_MS = 10 * 60_000;
/** Pending requests at once, overall and from one address (the endpoint needs no login). */
const MAX_PENDING_DEVICES = 200;
export const MAX_PENDING_DEVICES_PER_IP = 5;

export interface DeviceRequest {
  userCode: string;
  kind: RemoteCcTokenKind;
  name: string;
  createdAt: number;
  expiresAt: number;
  /** Where the request came from, so the approver can tell it is their own machine. */
  ip: string | null;
  userAgent: string | null;
}
interface DeviceRecord extends DeviceRequest {
  deviceDigest: string;
  status: "pending" | "approved" | "denied";
  token?: string;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** "abcd efgh" / "ABCD-EFGH" -> "ABCDEFGH"; "" when it cannot be a code. */
export function normalizeUserCode(value: string): string {
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  return code.length === 8 && [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : "";
}
export const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export function createDeviceFlows(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const byUser = new Map<string, DeviceRecord>();
  const byDevice = new Map<string, DeviceRecord>();
  const sweep = () => {
    for (const [code, record] of byUser)
      if (record.expiresAt <= now()) {
        byUser.delete(code);
        byDevice.delete(record.deviceDigest);
      }
  };
  const pending = (userCode: string) => {
    sweep();
    const record = byUser.get(normalizeUserCode(userCode));
    if (!record || record.status !== "pending")
      throw new RemoteCcError(404, "REMOTE_CC_DEVICE_UNKNOWN", "没有这个连接请求，或者它已过期");
    return record;
  };
  return {
    start(
      kind: RemoteCcTokenKind,
      name: string,
      origin: { ip?: string | null; userAgent?: string | null } = {},
    ) {
      sweep();
      const trimmed = name.trim();
      if (!trimmed || [...trimmed].length > 80)
        throw new RemoteCcError(400, "REMOTE_CC_TOKEN_NAME", "名称需要 1 到 80 个字");
      const ip = origin.ip || null;
      // Answered requests wait only for their poll; they no longer hold a slot.
      const waiting = [...byUser.values()].filter((record) => record.status === "pending");
      if (
        waiting.length >= MAX_PENDING_DEVICES ||
        (ip !== null &&
          waiting.filter((record) => record.ip === ip).length >= MAX_PENDING_DEVICES_PER_IP)
      )
        throw new RemoteCcError(429, "REMOTE_CC_DEVICE_BUSY", "待确认的连接请求过多，请稍后重试");
      let userCode = "";
      do {
        userCode = [...randomBytes(8)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
      } while (byUser.has(userCode));
      const deviceCode = randomBytes(32).toString("base64url");
      const record: DeviceRecord = {
        userCode,
        kind,
        name: trimmed,
        createdAt: now(),
        expiresAt: now() + DEVICE_TTL_MS,
        ip,
        userAgent: origin.userAgent?.slice(0, 300) || null,
        deviceDigest: digest(deviceCode),
        status: "pending",
      };
      byUser.set(userCode, record);
      byDevice.set(record.deviceDigest, record);
      return { deviceCode, userCode, expiresAt: record.expiresAt };
    },
    lookup(userCode: string): DeviceRequest {
      const record = pending(userCode);
      const { kind, name, createdAt, expiresAt, ip, userAgent } = record;
      return {
        userCode: formatUserCode(record.userCode),
        kind,
        name,
        createdAt,
        expiresAt,
        ip,
        userAgent,
      };
    },
    /** issue mints the token for the approving user; host tokens need an administrator. */
    approve(
      userCode: string,
      user: { id: string; role: string },
      issue: (userId: string, kind: RemoteCcTokenKind, name: string) => { token: string },
    ) {
      const record = pending(userCode);
      if (record.kind === "host" && user.role !== "admin")
        throw new RemoteCcError(403, "REMOTE_CC_HOST_ADMIN", "只有管理员可以批准出口主机");
      record.token = issue(user.id, record.kind, record.name).token;
      record.status = "approved";
    },
    /**
     * Requests are not addressed to a user: whoever reads the code off the requesting machine
     * answers it. Denying is held to the same rule as approving, so only an administrator can
     * answer (and so cancel) an exit host's request.
     */
    deny(userCode: string, user: { role: string }) {
      const record = pending(userCode);
      if (record.kind === "host" && user.role !== "admin")
        throw new RemoteCcError(403, "REMOTE_CC_HOST_ADMIN", "只有管理员可以处理出口主机的请求");
      record.status = "denied";
    },
    /** What the requesting machine learns; an approved token is handed out exactly once. */
    poll(deviceCode: string): { status: "pending" } | { status: "approved"; token: string } {
      sweep();
      const record = typeof deviceCode === "string" ? byDevice.get(digest(deviceCode)) : undefined;
      if (!record)
        throw new RemoteCcError(410, "REMOTE_CC_DEVICE_EXPIRED", "连接请求已过期，请重新运行命令");
      if (record.status === "pending") return { status: "pending" };
      byUser.delete(record.userCode);
      byDevice.delete(record.deviceDigest);
      if (record.status === "denied")
        throw new RemoteCcError(410, "REMOTE_CC_DEVICE_DENIED", "连接请求被拒绝");
      return { status: "approved", token: record.token! };
    },
  };
}

// ---------------------------------------------------------------- session grants

export const GRANT_TTL_MS = 10 * 60_000;
export interface GrantClaims {
  /** user id */ u: string;
  /** profile id */ p: string;
  /** node id */ n: string;
  /** expiry, ms */ exp: number;
}

export function createGrants(secret: Buffer, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const key = createHmac("sha256", secret).update("remote-cc session grant v1").digest();
  const sign = (payload: string) => createHmac("sha256", key).update(payload).digest("base64url");
  return {
    issue(userId: string, profileId: string, nodeId: string) {
      const claims: GrantClaims = { u: userId, p: profileId, n: nodeId, exp: now() + GRANT_TTL_MS };
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return { grant: `g1.${payload}.${sign(payload)}`, expiresAt: claims.exp };
    },
    verify(grant: unknown): GrantClaims {
      const invalid = () =>
        new RemoteCcError(401, "REMOTE_CC_GRANT", "会话授权无效或已过期，请重新启动会话");
      if (typeof grant !== "string" || grant.length > 2048) throw invalid();
      const [version, payload, signature] = grant.split(".");
      if (version !== "g1" || !payload || !signature) throw invalid();
      const expected = Buffer.from(sign(payload));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw invalid();
      let claims: GrantClaims;
      try {
        claims = JSON.parse(Buffer.from(payload, "base64url").toString());
      } catch {
        throw invalid();
      }
      if (typeof claims.exp !== "number" || claims.exp <= now()) throw invalid();
      return claims;
    },
  };
}

// ---------------------------------------------------------------- one-click logins

export const LOGIN_TTL_MS = 15 * 60_000;
const CLAUDE_HOSTS = new Set([
  "claude.ai",
  "claude.com",
  "platform.claude.com",
  "console.anthropic.com",
]);

/** Checks a Claude Code sign-in link; returns where its code arrives and its state. */
export function parseAuthorizeUrl(value: unknown): {
  url: string;
  redirect: string;
  state: string;
} {
  const invalid = () =>
    new RemoteCcError(400, "REMOTE_CC_LOGIN_URL", "这不是 Claude Code 的登录链接");
  if (typeof value !== "string" || value.length > 4096) throw invalid();
  let url: URL;
  let redirect: URL;
  try {
    url = new URL(value);
    redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
  } catch {
    throw invalid();
  }
  const state = url.searchParams.get("state") ?? "";
  if (
    url.protocol !== "https:" ||
    !CLAUDE_HOSTS.has(url.hostname) ||
    !url.pathname.endsWith("/oauth/authorize") ||
    !url.searchParams.get("client_id") ||
    !url.searchParams.get("code_challenge") ||
    !state ||
    redirect.protocol !== "https:" ||
    !CLAUDE_HOSTS.has(redirect.hostname)
  )
    throw invalid();
  return { url: url.href, redirect: redirect.origin + redirect.pathname, state };
}

/** The code Claude Code asks for ("code#state") if pageUrl is the callback of this login. */
export function callbackCode(redirect: string, state: string, pageUrl: string): string | undefined {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return undefined;
  }
  if (page.origin + page.pathname !== redirect) return undefined;
  const code = page.searchParams.get("code");
  if (!code || page.searchParams.get("state") !== state) return undefined;
  return `${code}#${state}`;
}

/** "code#state" for this state in a callback page's text (whitespace may wrap it). */
export function codeInText(state: string, text: string): string | undefined {
  // Join a line break only between code characters: the code wraps, labels around it do not.
  const flat = text.replace(/([A-Za-z0-9_#-])[ \t]*\r?\n[ \t]*(?=[A-Za-z0-9_#-])/g, "$1");
  const escaped = state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`([A-Za-z0-9_-]{16,})#${escaped}`).exec(flat);
  return match ? `${match[1]}#${state}` : undefined;
}

export interface LoginRequest {
  id: string;
  userId: string;
  profileId: string;
  url: string;
  redirect: string;
  state: string;
  status: "waiting" | "opened" | "done";
  code?: string;
  createdAt: number;
  /** Name of the client token that started it, so the user knows which machine asked. */
  tokenName: string | null;
  /** The browser it was opened in; if that browser goes away it is opened again. */
  openedIn?: string;
}

export function createLogins(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const logins = new Map<string, LoginRequest>();
  /** Logins whose browser tab is being opened right now. */
  const opening = new Set<string>();
  const sweep = () => {
    for (const [id, login] of logins)
      if (login.createdAt + LOGIN_TTL_MS <= now()) logins.delete(id);
  };
  return {
    create(
      userId: string,
      profileId: string,
      value: unknown,
      tokenName: string | null = null,
    ): LoginRequest {
      sweep();
      const { url, redirect, state } = parseAuthorizeUrl(value);
      // One open sign-in per profile: a new one replaces the previous.
      for (const [id, login] of logins)
        if (login.userId === userId && login.profileId === profileId) logins.delete(id);
      const login: LoginRequest = {
        id: randomUUID(),
        userId,
        profileId,
        url,
        redirect,
        state,
        status: "waiting",
        createdAt: now(),
        tokenName,
      };
      logins.set(login.id, login);
      return login;
    },
    /** Logins still waiting for their browser or for the user's click. */
    active(): LoginRequest[] {
      sweep();
      return [...logins.values()].filter((login) => login.status !== "done");
    },
    forUser(userId: string): LoginRequest[] {
      return this.active().filter((login) => login.userId === userId);
    },
    /**
     * Opens a waiting login through open(), which resolves to the browser it used (or
     * undefined); one open at a time per login, so the create route and the scan cannot
     * both open a tab.
     */
    async open(id: string, open: (login: LoginRequest) => Promise<string | undefined>) {
      const login = logins.get(id);
      if (login?.status !== "waiting" || opening.has(id)) return;
      opening.add(id);
      try {
        let browser: string | undefined;
        try {
          browser = await open(login);
        } catch {
          browser = undefined;
        }
        if (browser !== undefined && logins.get(id) === login && login.status === "waiting") {
          login.status = "opened";
          login.openedIn = browser;
        }
      } finally {
        opening.delete(id);
      }
    },
    /**
     * The user asks to open their login in the browser they are looking at (which the
     * automatic choice cannot know); allowed again while it is not done.
     */
    async openIn(
      userId: string,
      id: string,
      profileId: string,
      browser: string,
      open: (login: LoginRequest) => Promise<void>,
    ) {
      sweep();
      const login = logins.get(id);
      if (!login || login.userId !== userId || login.status === "done")
        throw new RemoteCcError(404, "REMOTE_CC_LOGIN_UNKNOWN", "登录请求已完成或已过期");
      if (login.profileId !== profileId)
        throw new RemoteCcError(
          409,
          "REMOTE_CC_LOGIN_PROFILE",
          "当前浏览器不是这个登录要用的配置，请先打开那个配置",
        );
      await open(login);
      // The scan may have completed it while the tab was opening.
      const now = logins.get(id);
      if (now === login && (now.status as LoginRequest["status"]) !== "done") {
        login.status = "opened";
        login.openedIn = browser;
      }
    },
    /** The browser an opened login was in is gone: open it again on the next scan. */
    reopen(id: string) {
      const login = logins.get(id);
      if (login?.status !== "opened") return;
      login.status = "waiting";
      delete login.openedIn;
    },
    /** The user withdraws their own sign-in; false if there is no such login. */
    cancel(userId: string, id: string): boolean {
      sweep();
      const login = logins.get(id);
      if (!login || login.userId !== userId) return false;
      return logins.delete(id);
    },
    /**
     * Checks the text of a callback page of the login's profile: the page strips the code
     * from its address, but shows "code#state"; true when it showed this login's code.
     */
    observeText(id: string, text: string): boolean {
      const login = logins.get(id);
      if (!login || login.status === "done") return false;
      const code = codeInText(login.state, text);
      if (!code) return false;
      login.status = "done";
      login.code = code;
      return true;
    },
    /** Checks a page address of the login's profile; true when it carried the code. */
    observe(id: string, pageUrl: string): boolean {
      const login = logins.get(id);
      if (!login || login.status === "done") return false;
      const code = callbackCode(login.redirect, login.state, pageUrl);
      if (!code) return false;
      login.status = "done";
      login.code = code;
      return true;
    },
    /** remote-cc's view; a delivered code is forgotten. */
    take(userId: string, id: string): { status: LoginRequest["status"]; code?: string } {
      sweep();
      const login = logins.get(id);
      if (!login || login.userId !== userId)
        throw new RemoteCcError(404, "REMOTE_CC_LOGIN_UNKNOWN", "登录请求已过期，请重新运行 login");
      if (login.status !== "done") return { status: login.status };
      logins.delete(id);
      return { status: "done", code: login.code };
    },
  };
}
