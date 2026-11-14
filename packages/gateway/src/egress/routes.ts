import type { FastifyInstance, FastifyReply } from "fastify";
import type { IncomingMessage } from "node:http";
import type { FrontendUser } from "../auth/users";
import {
  ProxyCatalogError,
  type ProxyCatalog,
  type ProxySourceInput,
  type ProxySourceUpdate,
} from "./catalog";

export function registerProxyRoutes(
  app: FastifyInstance,
  options: { catalog: ProxyCatalog; currentUser(request: IncomingMessage): FrontendUser | null },
) {
  const userFor = (request: IncomingMessage) => {
    const user = options.currentUser(request);
    if (!user) throw new ProxyCatalogError(401, "LOGIN_REQUIRED", "请重新登录");
    return user;
  };
  const failed = (reply: FastifyReply, error: unknown) =>
    error instanceof ProxyCatalogError
      ? reply.code(error.statusCode).send({ error: error.message, code: error.code })
      : reply.code(400).send({
          error: error instanceof Error ? error.message : "代理源操作失败",
          code: "PROXY_SOURCE_INVALID",
        });
  app.get("/api/proxy-sources", async (request, reply) => {
    try {
      return reply
        .header("cache-control", "no-store")
        .send({ sources: options.catalog.listSources(userFor(request.raw)) });
    } catch (error) {
      return failed(reply, error);
    }
  });
  app.get("/api/proxies", async (request, reply) => {
    try {
      return reply
        .header("cache-control", "no-store")
        .send({ proxies: options.catalog.listNodes(userFor(request.raw)) });
    } catch (error) {
      return failed(reply, error);
    }
  });
  app.post<{ Body: ProxySourceInput }>(
    "/api/proxy-sources",
    { bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      try {
        return { source: await options.catalog.importSource(userFor(request.raw), request.body) };
      } catch (error) {
        return failed(reply, error);
      }
    },
  );
  app.patch<{ Params: { id: string }; Body: ProxySourceUpdate }>(
    "/api/proxy-sources/:id",
    { bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      try {
        return {
          source: await options.catalog.updateSource(
            userFor(request.raw),
            request.params.id,
            request.body,
          ),
        };
      } catch (error) {
        return failed(reply, error);
      }
    },
  );
  app.post<{ Params: { id: string } }>("/api/proxy-sources/:id/refresh", async (request, reply) => {
    try {
      return {
        source: await options.catalog.refreshSource(userFor(request.raw), request.params.id),
      };
    } catch (error) {
      return failed(reply, error);
    }
  });
  app.delete<{ Params: { id: string } }>("/api/proxy-sources/:id", async (request, reply) => {
    try {
      await options.catalog.removeSource(userFor(request.raw), request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return failed(reply, error);
    }
  });
}
