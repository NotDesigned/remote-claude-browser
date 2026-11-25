import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import type { FrontendUser } from "../auth/users";
import { messageAnswer, type ErrorStyle } from "../http-errors";
import type { ExitHealth } from "./timezone";
import {
  ProxyCatalogError,
  type ProxyCatalog,
  type ProxySourceInput,
  type ProxySourceUpdate,
} from "./catalog";

/** Proxy routes answer `{ error: message, code }`; anything else is a source the catalog refused. */
export const proxyErrors: ErrorStyle = (error) =>
  error instanceof ProxyCatalogError
    ? messageAnswer(error)
    : {
        status: 400,
        body: {
          error: error instanceof Error ? error.message : "代理源操作失败",
          code: "PROXY_SOURCE_INVALID",
        },
      };

export function registerProxyRoutes(
  app: FastifyInstance,
  options: {
    catalog: ProxyCatalog;
    currentUser(request: IncomingMessage): FrontendUser | null;
    checkProxy(user: FrontendUser, id: string): Promise<ExitHealth>;
  },
) {
  const userFor = (request: IncomingMessage) => {
    const user = options.currentUser(request);
    if (!user) throw new ProxyCatalogError(401, "LOGIN_REQUIRED", "请重新登录");
    return user;
  };
  const config = { errors: proxyErrors };
  const sourceBody = { bodyLimit: 2 * 1024 * 1024, config };
  app.get("/api/proxy-sources", { config }, async (request, reply) =>
    reply
      .header("cache-control", "no-store")
      .send({ sources: options.catalog.listSources(userFor(request.raw)) }),
  );
  app.get("/api/proxies", { config }, async (request, reply) =>
    reply
      .header("cache-control", "no-store")
      .send({ proxies: options.catalog.listNodes(userFor(request.raw)) }),
  );
  app.post<{ Params: { id: string } }>(
    "/api/proxies/:id/check",
    { config },
    async (request, reply) => {
      const user = userFor(request.raw);
      options.catalog.getNodeConfig(user, request.params.id);
      return reply.header("cache-control", "no-store").send({
        health: await options.checkProxy(user, request.params.id),
      });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/proxy-sources/:id/usage",
    { config },
    async (request, reply) =>
      reply.header("cache-control", "no-store").send({
        usage: options.catalog.sourceUsage(userFor(request.raw), request.params.id),
      }),
  );
  app.post<{ Body: ProxySourceInput }>("/api/proxy-sources", sourceBody, async (request) => ({
    source: await options.catalog.importSource(userFor(request.raw), request.body),
  }));
  app.patch<{ Params: { id: string }; Body: ProxySourceUpdate }>(
    "/api/proxy-sources/:id",
    sourceBody,
    async (request) => ({
      source: await options.catalog.updateSource(
        userFor(request.raw),
        request.params.id,
        request.body,
      ),
    }),
  );
  app.post<{ Params: { id: string } }>(
    "/api/proxy-sources/:id/refresh",
    { config },
    async (request) => ({
      source: await options.catalog.refreshSource(userFor(request.raw), request.params.id),
    }),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/proxy-sources/:id",
    { config },
    async (request, reply) => {
      await options.catalog.removeSource(userFor(request.raw), request.params.id);
      return reply.code(204).send();
    },
  );
}
