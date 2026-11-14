import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { FrontendUser } from "../auth/users";
import { CpaError } from "./store";
import type { CpaRuntime } from "./runtime";

interface RouteOptions {
  runtime: CpaRuntime;
  currentUser(request: IncomingMessage): FrontendUser | null | undefined;
}
const textField = { type: "string", minLength: 1, maxLength: 2048 };
const bodySchema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const handleError = (reply: FastifyReply, error: unknown) => {
  if (error instanceof CpaError)
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  return reply.code(502).send({ error: "CPA_OPERATION", message: "CPA 操作失败，请检查实例状态" });
};

export function registerCpaRoutes(app: FastifyInstance, options: RouteOptions) {
  const root = "/api/cpa/instances";
  const route = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    operation: (user: FrontendUser, request: FastifyRequest) => unknown,
    body?: unknown,
  ) => {
    app.route({
      method,
      url: `${root}${path}`,
      schema: body ? { body } : undefined,
      async handler(request, reply) {
        reply.header("cache-control", "no-store");
        const user = options.currentUser(request.raw);
        if (!user?.enabled)
          return reply.code(401).send({ error: "LOGIN_REQUIRED", message: "请先登录" });
        try {
          return await operation(user, request);
        } catch (error) {
          return handleError(reply, error);
        }
      },
    });
  };
  const id = (request: FastifyRequest) => (request.params as { id: string }).id;
  const runtime = options.runtime;
  route("GET", "", async (user) => ({ instances: await runtime.list(user) }));
  route(
    "POST",
    "",
    async (user, req) => ({
      instance: await runtime.create(user, (req.body as { scope: "user" | "shared" }).scope),
    }),
    bodySchema({ scope: { enum: ["user", "shared"] } }, ["scope"]),
  );
  route("POST", "/:id/start", async (user, req) => ({
    instance: await runtime.start(user, id(req)),
  }));
  route("POST", "/:id/stop", async (user, req) => ({
    instance: await runtime.stop(user, id(req)),
  }));
  route("GET", "/:id/credentials", async (user, req) => ({
    credentials: await runtime.credentials(user, id(req)),
  }));
  route(
    "PATCH",
    "/:id/credentials/status",
    async (user, req) => {
      const body = req.body as { name: string; disabled: boolean };
      await runtime.credentialStatus(user, id(req), body.name, body.disabled);
      return { ok: true };
    },
    bodySchema({ name: textField, disabled: { type: "boolean" } }, ["name", "disabled"]),
  );
  route(
    "PATCH",
    "/:id/credentials/proxy",
    async (user, req) => {
      const body = req.body as { name: string; proxyId: string | null };
      await runtime.credentialProxy(user, id(req), body.name, body.proxyId);
      return { ok: true };
    },
    bodySchema({ name: textField, proxyId: { anyOf: [textField, { type: "null" }] } }, [
      "name",
      "proxyId",
    ]),
  );
  route("DELETE", "/:id/credentials", async (user, req) => {
    const name = (req.query as { name?: string }).name;
    if (!name) throw new CpaError(400, "CPA_CREDENTIAL", "需要凭据名称");
    await runtime.deleteCredential(user, id(req), name);
    return { ok: true };
  });
  route(
    "POST",
    "/:id/oauth",
    (user, req) => runtime.startOAuth(user, id(req), (req.body as { proxyId?: string }).proxyId),
    bodySchema({ provider: { const: "claude" }, proxyId: textField }, ["provider"]),
  );
  route("GET", "/:id/oauth/status", (user, req) => {
    const state = (req.query as { state?: string }).state;
    if (!state) throw new CpaError(400, "CPA_OAUTH_STATE", "需要登录会话标识");
    return runtime.oauthStatus(user, id(req), state);
  });
  route(
    "POST",
    "/:id/oauth/callback",
    async (user, req) => {
      await runtime.oauthCallback(
        user,
        id(req),
        req.body as { state: string; code?: string; redirectUrl?: string; error?: string },
      );
      return { ok: true };
    },
    bodySchema(
      {
        state: textField,
        code: textField,
        redirectUrl: { ...textField, maxLength: 8192 },
        error: textField,
      },
      ["state"],
    ),
  );
  route("GET", "/:id/keys", (user, req) => ({ keys: runtime.listKeys(user, id(req)) }));
  route(
    "POST",
    "/:id/keys",
    (user, req) => ({ key: runtime.issueKey(user, id(req), (req.body as { name: string }).name) }),
    bodySchema({ name: { type: "string", minLength: 1, maxLength: 160 } }, ["name"]),
  );
  route("DELETE", "/:id/keys/:keyId", (user, req) => {
    runtime.revokeKey(user, id(req), (req.params as { keyId: string }).keyId);
    return { ok: true };
  });
}

const HOP_HEADERS = new Set([
  "connection",
  "transfer-encoding",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
]);
export function registerCpaInferenceRoutes(app: FastifyInstance, runtime: CpaRuntime) {
  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    url: "/v1/*",
    bodyLimit: 33_554_432,
    async handler(request, reply) {
      try {
        const auth = request.headers.authorization;
        const token =
          typeof auth === "string" && auth.startsWith("Bearer ")
            ? auth.slice(7)
            : request.headers["x-api-key"];
        const instance = runtime.inference(typeof token === "string" ? token : "");
        const headers: IncomingHttpHeaders = {
          ...request.headers,
          authorization: `Bearer ${instance.apiKey}`,
        };
        delete headers.host;
        delete headers["x-api-key"];
        delete headers.cookie;
        delete headers["content-length"];
        for (const name of HOP_HEADERS) delete headers[name];
        const body =
          request.body === undefined
            ? undefined
            : Buffer.isBuffer(request.body)
              ? request.body
              : JSON.stringify(request.body);
        const response = await runtime.driver.request(instance, {
          method: request.method,
          path: request.raw.url!,
          headers,
          body,
        });
        reply.code(response.statusCode ?? 502);
        for (const [name, value] of Object.entries(response.headers))
          if (value !== undefined && !HOP_HEADERS.has(name) && name !== "set-cookie")
            reply.header(name, value);
        return reply.send(response);
      } catch (error) {
        return handleError(reply, error);
      }
    },
  });
}
