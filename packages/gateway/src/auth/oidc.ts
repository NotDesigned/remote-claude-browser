/**
 * Sign-in through an external OpenID Connect provider (e.g. SphereN Auth / authentik), next to
 * the local username and password. Authorization code flow with PKCE (S256), state and nonce;
 * openid-client verifies the ID token (signature from the provider's JWKS, issuer, audience,
 * expiry, nonce). A person is identified by issuer + subject; the email is only shown.
 */
import { randomBytes } from "node:crypto";
import * as client from "openid-client";
import type { FrontendUser, UserRole, UserStore } from "./users";
import { UserStoreError } from "./users";

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The exact redirect URI registered with the provider. */
  redirectUri: string;
  scopes: string;
  /** Button text on the sign-in page. */
  label: string;
  /** Members of this group (groups claim) become administrators of users created by sign-in. */
  adminGroup?: string;
  /** If any are set, a first sign-in must match one (domain/email need a verified email). */
  allowedDomains: string[];
  allowedEmails: string[];
  allowedGroups: string[];
  /** Lifetime of a session started by this sign-in. */
  sessionTtlMs: number;
  /** remote-cc tokens of external-only users stop working after this long without a sign-in. */
  revalidateMs: number;
}

const DAY = 24 * 60 * 60 * 1000;
const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

/** Settings from MIRROR_OIDC_*; undefined when OIDC is not configured. */
export function oidcSettingsFromEnv(
  env: NodeJS.ProcessEnv,
  publicOrigin: string | undefined,
): OidcSettings | undefined {
  const issuer = env.MIRROR_OIDC_ISSUER?.trim();
  if (!issuer) return undefined;
  const clientId = env.MIRROR_OIDC_CLIENT_ID?.trim();
  const clientSecret = env.MIRROR_OIDC_CLIENT_SECRET?.trim();
  const origin = publicOrigin?.replace(/\/+$/, "");
  if (!clientId || !clientSecret)
    throw new Error("MIRROR_OIDC_ISSUER needs MIRROR_OIDC_CLIENT_ID and MIRROR_OIDC_CLIENT_SECRET");
  if (!origin && !env.MIRROR_OIDC_REDIRECT_URI)
    throw new Error("MIRROR_OIDC_ISSUER needs MIRROR_PUBLIC_ORIGIN (or MIRROR_OIDC_REDIRECT_URI)");
  const days = (name: string, fallback: number) => {
    // Compose passes unset variables as "": treat that as unset.
    const value = Number(env[name]?.trim() || fallback);
    if (!Number.isFinite(value) || value <= 0 || value > 60)
      throw new Error(`${name} must be between 1 and 60 days`);
    return value * DAY;
  };
  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri: env.MIRROR_OIDC_REDIRECT_URI?.trim() || `${origin}/gate/oidc/callback`,
    scopes: env.MIRROR_OIDC_SCOPES?.trim() || "openid profile email",
    label: env.MIRROR_OIDC_LABEL?.trim() || "使用单点登录",
    adminGroup: env.MIRROR_OIDC_ADMIN_GROUP?.trim() || undefined,
    allowedDomains: list(env.MIRROR_OIDC_ALLOWED_DOMAINS).map((d) => d.replace(/^@/, "")),
    allowedEmails: list(env.MIRROR_OIDC_ALLOWED_EMAILS),
    allowedGroups: list(env.MIRROR_OIDC_ALLOWED_GROUPS),
    sessionTtlMs: days("MIRROR_OIDC_SESSION_DAYS", 7),
    revalidateMs: days("MIRROR_OIDC_REVALIDATE_DAYS", 30),
  };
}

export class OidcError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** The claims this integration uses, from the ID token and the userinfo endpoint. */
export interface OidcProfile {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  names: string[];
  groups: string[];
}

/** Whether a first sign-in may create an account. No allow-list = everyone the provider lets in. */
export function admitted(settings: OidcSettings, profile: OidcProfile): boolean {
  const { allowedDomains, allowedEmails, allowedGroups } = settings;
  if (!allowedDomains.length && !allowedEmails.length && !allowedGroups.length) return true;
  const groups = profile.groups.map((group) => group.toLowerCase());
  if (allowedGroups.some((group) => groups.includes(group))) return true;
  const email = profile.emailVerified ? profile.email?.toLowerCase() : undefined;
  if (!email) return false;
  return (
    allowedEmails.includes(email) ||
    allowedDomains.includes(email.slice(email.lastIndexOf("@") + 1))
  );
}

export function roleFor(settings: OidcSettings, profile: OidcProfile): UserRole {
  return settings.adminGroup && profile.groups.includes(settings.adminGroup) ? "admin" : "user";
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Builds the profile from ID token claims merged with userinfo (which may carry groups). */
export function profileFrom(
  claims: Record<string, unknown>,
  userinfo: Record<string, unknown> = {},
): OidcProfile {
  const all = { ...userinfo, ...claims };
  const email = text(all.email);
  return {
    issuer: String(claims.iss),
    subject: String(claims.sub),
    email,
    emailVerified: all.email_verified === true,
    names: [
      text(all.preferred_username),
      text(all.nickname),
      email?.split("@")[0] ?? null,
      text(all.name),
    ].filter((name): name is string => name !== null),
    groups: [...new Set([...strings(claims.groups), ...strings(userinfo.groups)])],
  };
}

interface Pending {
  verifier: string;
  nonce: string;
  purpose: "login" | "link";
  userId?: string;
  createdAt: number;
}
const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 500;

export type Oidc = ReturnType<typeof createOidc>;

export function createOidc(
  settings: OidcSettings,
  options: {
    store: UserStore;
    now?: () => number;
    /** Tests reach a local provider over plain HTTP. */
    insecure?: boolean;
  },
) {
  const now = options.now ?? Date.now;
  const pending = new Map<string, Pending>();
  let discovered: Promise<client.Configuration> | undefined;
  const configuration = () => {
    discovered ??= client
      .discovery(new URL(settings.issuer), settings.clientId, settings.clientSecret, undefined, {
        // Also verify the ID token's signature against the provider's JWKS (by default it
        // is trusted on the strength of TLS alone when it comes from the token endpoint).
        execute: [
          client.enableNonRepudiationChecks,
          ...(options.insecure ? [client.allowInsecureRequests] : []),
        ],
      })
      .catch((error: unknown) => {
        // Retry discovery on the next sign-in instead of caching the failure.
        discovered = undefined;
        console.error("OIDC discovery failed:", error instanceof Error ? error.message : error);
        throw new OidcError(502, "暂时无法连接单点登录服务，请稍后重试");
      });
    return discovered;
  };
  const sweep = () => {
    for (const [state, item] of pending)
      if (item.createdAt + PENDING_TTL_MS <= now()) pending.delete(state);
  };
  const store = options.store;

  return {
    settings,
    /** The provider's authorization URL and the state to bind to this browser (cookie). */
    async start(purpose: "login" | "link", userId?: string) {
      const config = await configuration();
      sweep();
      if (pending.size >= MAX_PENDING) throw new OidcError(429, "正在进行的登录过多，请稍后重试");
      const verifier = client.randomPKCECodeVerifier();
      const state = randomBytes(24).toString("base64url");
      const nonce = randomBytes(24).toString("base64url");
      pending.set(state, { verifier, nonce, purpose, userId, createdAt: now() });
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: settings.redirectUri,
        scope: settings.scopes,
        state,
        nonce,
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      });
      return { url: url.href, state };
    },
    /**
     * Completes the provider's callback. browserState is the state this browser started with
     * (from its cookie): a callback carried to another browser is refused.
     */
    async finish(callbackUrl: URL, browserState: string | undefined) {
      sweep();
      const state = callbackUrl.searchParams.get("state") ?? "";
      const item = pending.get(state);
      if (!item || !browserState || browserState !== state)
        throw new OidcError(400, "登录已过期或不是从这个浏览器发起的，请重新登录");
      pending.delete(state);
      const providerError = callbackUrl.searchParams.get("error");
      if (providerError)
        throw new OidcError(
          403,
          providerError === "access_denied" ? "单点登录拒绝了这次登录" : "单点登录未完成，请重试",
        );
      const config = await configuration();
      let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
      try {
        tokens = await client.authorizationCodeGrant(config, callbackUrl, {
          pkceCodeVerifier: item.verifier,
          expectedState: state,
          expectedNonce: item.nonce,
          idTokenExpected: true,
        });
      } catch (error) {
        console.error(
          "OIDC token exchange failed:",
          error instanceof Error ? error.message : error,
        );
        throw new OidcError(400, "单点登录校验失败，请重新登录");
      }
      const claims = tokens.claims() as Record<string, unknown> | undefined;
      if (!claims?.sub) throw new OidcError(400, "单点登录没有返回身份信息");
      let userinfo: Record<string, unknown> = {};
      try {
        userinfo = (await client.fetchUserInfo(
          config,
          tokens.access_token,
          String(claims.sub),
        )) as Record<string, unknown>;
      } catch {
        // userinfo is optional (groups and email usually come in the ID token too).
      }
      return { profile: profileFrom(claims, userinfo), purpose: item.purpose, userId: item.userId };
    },
    /**
     * The local user for a completed sign-in: an existing identity, or a new account
     * (auto-provisioning) when the allow-list admits the person. Keeps the role of users
     * created by sign-in in step with the admin group.
     */
    async signIn(profile: OidcProfile): Promise<FrontendUser> {
      let user = store.identityLogin(profile.issuer, profile.subject, profile.email);
      if (!user) {
        if (!admitted(settings, profile))
          throw new OidcError(403, "你的单点登录账号没有使用这个工作台的权限，请联系管理员");
        user = store.createIdentityUser({
          issuer: profile.issuer,
          subject: profile.subject,
          email: profile.email,
          names: profile.names,
          role: roleFor(settings, profile),
        });
      } else if (
        settings.adminGroup &&
        store.identity(profile.issuer, profile.subject)?.roleManaged
      ) {
        const role = roleFor(settings, profile);
        if (role !== user.role)
          try {
            user = await store.updateUser(user.id, { role });
          } catch (error) {
            // The last administrator keeps the role; anything else is a real failure.
            if (!(error instanceof UserStoreError && error.code === "USER_LAST_ADMIN")) throw error;
          }
      }
      if (!user.enabled) throw new OidcError(403, "这个账户已停用，请联系管理员");
      return user;
    },
    /** Whether an external-only user still has a recent sign-in (remote-cc tokens depend on it). */
    recentlySignedIn(userId: string): boolean {
      const identities = store.identities(userId);
      if (!identities.length || store.hasPassword(userId)) return true;
      const last = Math.max(...identities.map((identity) => identity.lastLoginAt));
      return now() - last < settings.revalidateMs;
    },
  };
}
