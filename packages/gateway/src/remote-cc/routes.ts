import type { IncomingMessage } from "node:http";
import type { FastifyInstance, FastifyReply } from "fastify";
import { codeAnswer, type ErrorStyle } from "../http-errors";
import type { FrontendUser } from "../auth/users";
import type { MihomoProxy } from "../egress/mihomo";
import type { ExitHealth, ExitMetadata } from "../egress/timezone";
import type { ProfileRecord } from "../session/profiles";
import {
  createDeviceFlows,
  createGrants,
  createLogins,
  DEVICE_TTL_MS,
  formatUserCode,
} from "./flows";
import { RemoteCcError, type RemoteCcStore, type RemoteCcTokenKind } from "./store";

/** Paths remote-cc and egress hosts call without a login cookie; each authenticates itself. */
export const REMOTE_CC_TOKEN_PATH = "/api/remote-cc/v1/";

export interface RemoteCcNode {
  id: string;
  name: string;
  proxy: MihomoProxy;
}
export interface RemoteCcRouteOptions {
  store: RemoteCcStore;
  /** Signs session grants; keep it stable across restarts. */
  secret: Buffer;
  /** The workbench address users open, for approval links. */
  publicOrigin(request: IncomingMessage): string;
  currentUser(request: IncomingMessage): FrontendUser | null | undefined;
  getUser(id: string): FrontendUser | undefined;
  /** The browser profiles the user owns. */
  profilesFor(user: FrontendUser): ProfileRecord[];
  /** The proxy nodes the user can see, with their full configuration. */
  nodesFor(user: FrontendUser): RemoteCcNode[];
  /** A fresh exit check through a node, as the user. */
  checkExit(user: FrontendUser, nodeId: string): Promise<ExitHealth>;
  /** Records a profile's exit after a fresh check. */
  saveExit(profileId: string, metadata: ExitMetadata): Promise<void>;
  /** The profile's running browsers, if the user has any open. */
  browser: {
    /** Opens url in a live browser of the profile; resolves to that browser's id, if any. */
    open(profileId: string, url: string): Promise<string | undefined>;
    /** Page addresses in every live browser of the profile. */
    pageUrls(profileId: string): string[];
    /** The visible text of the profile's pages on this origin (callback pages). */
    pageTexts?(profileId: string, origin: string): Promise<string[]>;
    /** Whether a browser open() used is still running. */
    isLive(browserId: string): boolean;
  };
  now?: () => number;
  /**
   * Open new sign-ins in a browser of the profile on our own. Off by default: with several
   * windows of a profile open, the server cannot tell which one the user is looking at, so
   * the user opens it from the one in front of them (openLoginIn).
   */
  autoOpen?: boolean;
  /** Whether the user may still use remote-cc (e.g. signed in through OIDC recently enough). */
  userActive?(user: FrontendUser): boolean;
}

/** What remote-cc learns about a profile: identity and exit, never browser data or secrets. */
export function clientProfile(record: ProfileRecord, nodeName: (id: string) => string | undefined) {
  const nodeId = record.proxyId ?? null;
  return {
    id: record.id,
    name: record.name,
    email: record.email ?? null,
    signedIn: record.signedIn === true,
    unavailable: record.unavailable === true,
    node: nodeId ? { id: nodeId, name: nodeName(nodeId) ?? null } : null,
    exit: record.exitIp
      ? {
          ip: record.exitIp,
          city: record.exitCity ?? null,
          country: record.exitCountry ?? null,
          timeZone: record.timeZone ?? null,
          checkedAt: record.checkedAt ?? null,
        }
      : null,
  };
}

/**
 * Whether an account change ends all the user's remote-cc tokens: a new password or
 * role, or disabling, must not leave a machine connected on the old terms.
 */
export function accountChangeRevokesRemoteCc(
  before: Pick<FrontendUser, "role" | "enabled"> | undefined,
  after: Pick<FrontendUser, "role" | "enabled">,
  passwordChanged: boolean,
): boolean {
  return passwordChanged || before?.role !== after.role || !after.enabled;
}

/** remote-cc routes answer `{ error: code, message }`; anything else is logged as a failure. */
export const remoteCcErrors: ErrorStyle = (error) => {
  if (error instanceof RemoteCcError) return codeAnswer(error);
  console.error("remote-cc route failed:", error instanceof Error ? error.name : error);
  return { status: 500, body: { error: "REMOTE_CC_FAILED", message: "操作失败" } };
};
const bearer = (request: IncomingMessage) => {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : undefined;
};
const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const body = (properties: Record<string, unknown>) => ({
  body: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

export function registerRemoteCcRoutes(app: FastifyInstance, options: RemoteCcRouteOptions) {
  const { store } = options;
  const devices = createDeviceFlows({ now: options.now });
  const grants = createGrants(options.secret, { now: options.now });
  const logins = createLogins({ now: options.now });
  const now = options.now ?? Date.now;

  const loggedIn = (request: IncomingMessage) => {
    const user = options.currentUser(request);
    if (!user?.enabled) throw new RemoteCcError(401, "LOGIN_REQUIRED", "请先登录");
    return user;
  };
  /** The live token and its enabled owner, or a uniform 401; host tokens need an admin owner. */
  const tokenUser = (request: IncomingMessage, kind: RemoteCcTokenKind) => {
    const token = store.resolve(bearer(request), kind);
    const user = token && options.getUser(token.userId);
    if (!token || !user?.enabled || (kind === "host" && user.role !== "admin"))
      throw new RemoteCcError(401, "REMOTE_CC_TOKEN", "连接已失效，请重新连接");
    if (options.userActive && !options.userActive(user))
      throw new RemoteCcError(
        401,
        "REMOTE_CC_SIGN_IN",
        "太久没有通过单点登录进入工作台，请先登录一次工作台再继续",
      );
    return { token, user };
  };
  const ownProfile = (user: FrontendUser, id: string) => {
    const profile = options.profilesFor(user).find((record) => record.id === id);
    if (!profile) throw new RemoteCcError(404, "REMOTE_CC_PROFILE_UNKNOWN", "没有这个浏览器配置");
    return profile;
  };
  const boundNode = (user: FrontendUser, profile: ProfileRecord) => {
    const node = profile.proxyId
      ? options.nodesFor(user).find((item) => item.id === profile.proxyId)
      : undefined;
    if (!node)
      throw new RemoteCcError(409, "REMOTE_CC_PROFILE_NODE", "这个浏览器配置没有可用的出口节点");
    return node;
  };
  const route = <B = unknown, P = Record<string, string>, Q = Record<string, unknown>>(
    method: "GET" | "POST" | "DELETE",
    url: string,
    handler: (
      request: { raw: IncomingMessage; body: B; params: P; query: Q; ip: string },
      reply: FastifyReply,
    ) => unknown,
    schema?: unknown,
  ) =>
    app.route({
      method,
      url,
      schema: schema as never,
      config: { errors: remoteCcErrors },
      async handler(request, reply) {
        reply.header("cache-control", "no-store");
        return await handler(request as never, reply);
      },
    });

  // ---------------------------------------------------------- workbench (login cookie)
  route("GET", "/api/remote-cc/tokens", (request) => ({
    tokens: store.list(loggedIn(request.raw).id),
  }));
  route<unknown, { id: string }>("DELETE", "/api/remote-cc/tokens/:id", (request, reply) => {
    if (!store.revoke(loggedIn(request.raw).id, request.params.id))
      throw new RemoteCcError(404, "REMOTE_CC_TOKEN_UNKNOWN", "没有这个连接");
    return reply.code(204).send();
  });
  route<unknown, { code: string }>("GET", "/api/remote-cc/devices/:code", (request) => {
    loggedIn(request.raw);
    return { request: devices.lookup(request.params.code) };
  });
  route<unknown, { code: string }>("POST", "/api/remote-cc/devices/:code/approve", (request) => {
    const user = loggedIn(request.raw);
    devices.approve(request.params.code, user, (userId, kind, name) =>
      store.issue(userId, kind, name),
    );
    return { ok: true };
  });
  route<unknown, { code: string }>("POST", "/api/remote-cc/devices/:code/deny", (request) => {
    devices.deny(request.params.code, loggedIn(request.raw));
    return { ok: true };
  });
  route("GET", "/api/remote-cc/logins", (request) => {
    const user = loggedIn(request.raw);
    const names = new Map(options.profilesFor(user).map((record) => [record.id, record.name]));
    return {
      logins: logins.forUser(user.id).map((login) => ({
        id: login.id,
        profileId: login.profileId,
        profileName: names.get(login.profileId) ?? null,
        status: login.status,
        createdAt: login.createdAt,
        tokenName: login.tokenName,
      })),
    };
  });
  route<unknown, { id: string }>("DELETE", "/api/remote-cc/logins/:id", (request, reply) => {
    if (!logins.cancel(loggedIn(request.raw).id, request.params.id))
      throw new RemoteCcError(404, "REMOTE_CC_LOGIN_UNKNOWN", "没有这个登录请求");
    return reply.code(204).send();
  });

  // ---------------------------------------------------------- device approval (no token yet)
  route<{ kind: RemoteCcTokenKind; name: string }>(
    "POST",
    `${REMOTE_CC_TOKEN_PATH}devices`,
    (request) => {
      const userAgent = request.raw.headers["user-agent"];
      const started = devices.start(request.body.kind, request.body.name, {
        ip: request.ip,
        userAgent: typeof userAgent === "string" ? userAgent : null,
      });
      const code = formatUserCode(started.userCode);
      return {
        deviceCode: started.deviceCode,
        userCode: code,
        verifyUrl: `${options.publicOrigin(request.raw)}/?remote-cc=${code}`,
        interval: 3,
        expiresIn: DEVICE_TTL_MS / 1000,
      };
    },
    body({ kind: { enum: ["client", "host"] }, name: text(160) }),
  );
  route<{ deviceCode: string }>(
    "POST",
    `${REMOTE_CC_TOKEN_PATH}devices/token`,
    (request, reply) => {
      const result = devices.poll(request.body.deviceCode);
      return result.status === "pending" ? reply.code(202).send(result) : result;
    },
    body({ deviceCode: text(200) }),
  );

  // ---------------------------------------------------------- remote-cc (client token)
  route("GET", `${REMOTE_CC_TOKEN_PATH}profiles`, (request) => {
    const { user } = tokenUser(request.raw, "client");
    const names = new Map(options.nodesFor(user).map((node) => [node.id, node.name]));
    return {
      profiles: options
        .profilesFor(user)
        .map((record) => clientProfile(record, (id) => names.get(id))),
    };
  });
  route<unknown, { id: string }>("POST", `${REMOTE_CC_TOKEN_PATH}profiles/:id/grant`, (request) => {
    const { user } = tokenUser(request.raw, "client");
    const profile = ownProfile(user, request.params.id);
    const node = boundNode(user, profile);
    return {
      ...grants.issue(user.id, profile.id, node.id),
      node: { id: node.id, name: node.name },
    };
  });
  route<unknown, { id: string }>(
    "POST",
    `${REMOTE_CC_TOKEN_PATH}profiles/:id/check`,
    async (request) => {
      const { user } = tokenUser(request.raw, "client");
      const profile = ownProfile(user, request.params.id);
      const node = boundNode(user, profile);
      const health = await options.checkExit(user, node.id);
      if (health.status !== "healthy" || !health.exitIp || !health.timeZone)
        throw new RemoteCcError(
          503,
          "REMOTE_CC_EXIT_UNAVAILABLE",
          health.error ?? "出口检测失败，请检查节点后重试",
        );
      const metadata: ExitMetadata = {
        timeZone: health.timeZone,
        exitIp: health.exitIp,
        exitCity: health.exitCity,
        exitCountry: health.exitCountry,
        checkedAt: health.checkedAt ?? now(),
      };
      await options.saveExit(profile.id, metadata);
      return {
        exit: {
          ip: health.exitIp,
          city: health.exitCity ?? null,
          country: health.exitCountry ?? null,
          timeZone: health.timeZone,
          checkedAt: metadata.checkedAt,
        },
      };
    },
  );
  route<{ url: string }, { id: string }>(
    "POST",
    `${REMOTE_CC_TOKEN_PATH}profiles/:id/logins`,
    async (request) => {
      const { token, user } = tokenUser(request.raw, "client");
      const profile = ownProfile(user, request.params.id);
      const login = logins.create(user.id, profile.id, request.body.url, token.name);
      if (options.autoOpen) await openLogin(login.id);
      return { id: login.id, status: login.status };
    },
    body({ url: text(4096) }),
  );
  route<unknown, { id: string }>("GET", `${REMOTE_CC_TOKEN_PATH}logins/:id`, (request) => {
    const { user } = tokenUser(request.raw, "client");
    return logins.take(user.id, request.params.id);
  });

  // ---------------------------------------------------------- egress host (host token)
  /** The node for a host if the user still has it bound to a profile they own. */
  const nodeForUser = (userId: string, nodeId: string, profileId?: string) => {
    const user = options.getUser(userId);
    if (!user?.enabled) return undefined;
    const bound = options
      .profilesFor(user)
      .some((record) => record.proxyId === nodeId && (!profileId || record.id === profileId));
    return bound ? options.nodesFor(user).find((node) => node.id === nodeId) : undefined;
  };
  route<{ grant: string }>(
    "POST",
    `${REMOTE_CC_TOKEN_PATH}egress/redeem`,
    (request) => {
      const { token } = tokenUser(request.raw, "host");
      const claims = grants.verify(request.body.grant);
      const node = nodeForUser(claims.u, claims.n, claims.p);
      if (!node)
        throw new RemoteCcError(
          403,
          "REMOTE_CC_GRANT_NODE",
          "这个配置已不再使用该节点，请重新启动会话",
        );
      store.recordHostNode(token.id, node.id, claims.u);
      return { node, userId: claims.u };
    },
    body({ grant: text(2048) }),
  );
  // ?user= re-checks only the user one session runs as, so one user losing the node
  // ends just their sessions on the host; only users whose grant the host redeemed count.
  route<unknown, { id: string }, { user?: unknown }>(
    "GET",
    `${REMOTE_CC_TOKEN_PATH}egress/nodes/:id`,
    (request) => {
      const { token } = tokenUser(request.raw, "host");
      const only = request.query.user;
      const candidates = store
        .hostNodeUsers(token.id, request.params.id)
        .filter((userId) => only === undefined || userId === only);
      for (const userId of candidates) {
        const node = nodeForUser(userId, request.params.id);
        if (node) return { node };
        store.forgetHostNode(token.id, request.params.id, userId);
      }
      throw new RemoteCcError(404, "REMOTE_CC_NODE_GONE", "这个节点已不再授权给本出口主机");
    },
  );

  const openLogin = (id: string) =>
    logins.open(id, (login) => options.browser.open(login.profileId, login.url));
  // Open pending sign-ins in their profile's browser, and pick up the callback code.
  const scan = async () => {
    for (const login of logins.active()) {
      if (
        login.status === "opened" &&
        login.openedIn !== undefined &&
        !options.browser.isLive(login.openedIn)
      )
        logins.reopen(login.id);
      if (login.status === "waiting" && options.autoOpen) await openLogin(login.id);
      if (login.status === "opened")
        for (const url of options.browser.pageUrls(login.profileId))
          if (logins.observe(login.id, url)) break;
      if (login.status === "opened" && options.browser.pageTexts)
        for (const text of await options.browser.pageTexts(
          login.profileId,
          new URL(login.redirect).origin,
        ))
          if (logins.observeText(login.id, text)) break;
    }
  };
  let scanning = false;
  const timer = setInterval(() => {
    if (scanning) return;
    scanning = true;
    void scan()
      .catch(() => {})
      .finally(() => (scanning = false));
  }, 1000);
  timer.unref?.();
  return {
    close() {
      clearInterval(timer);
    },
    /** For tests: run one scan now. */
    scan,
    /** Opens a user's login in a browser session they chose (the one they are looking at). */
    openLoginIn: logins.openIn.bind(logins),
  };
}
