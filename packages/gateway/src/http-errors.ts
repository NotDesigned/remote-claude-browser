/**
 * How a route's failure becomes an HTTP answer. There is one Fastify error handler; a route names
 * how its group answers errors (`config.errors`), so each group keeps the JSON shape its pages
 * read, and the group's handlers just throw.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

/** An error whose status and JSON body are already decided. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === "string" ? body.error : `HTTP ${statusCode}`);
  }
}

export interface ErrorAnswer {
  status: number;
  body: unknown;
}

/**
 * The answer a group of routes gives to an error thrown by one of its handlers; undefined leaves
 * it to Fastify's default answer.
 */
export type ErrorStyle = (error: unknown, request: FastifyRequest) => ErrorAnswer | undefined;

declare module "fastify" {
  interface FastifyContextConfig {
    errors?: ErrorStyle;
  }
}

/** The service's typed errors: a status, a stable code and a message for people. */
export interface TypedError {
  statusCode: number;
  code: string;
  message: string;
}

/** `{ error: message, code }`: the workbench's session, account and proxy routes. */
export const messageAnswer = (
  error: TypedError,
  extra: Record<string, unknown> = {},
): ErrorAnswer => ({
  status: error.statusCode,
  body: { error: error.message, code: error.code, ...extra },
});

/** `{ error: code, message }`: the CPA and remote-cc routes. */
export const codeAnswer = (error: TypedError): ErrorAnswer => ({
  status: error.statusCode,
  body: { error: error.code, message: error.message },
});

/** The answer to an unexpected failure: never its message, which may name files or upstreams. */
export const INTERNAL_ERROR_BODY = { error: "服务器内部错误，请稍后重试", code: "INTERNAL_ERROR" };
export const UNAVAILABLE_ERROR_BODY = {
  error: "服务暂时不可用，请稍后重试",
  code: "SERVICE_UNAVAILABLE",
};

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { statusCode, status } = error as { statusCode?: unknown; status?: unknown };
  const value = statusCode ?? status;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/**
 * Registers the error handler. Call it before any hook or route: it marks each request that got
 * past body parsing and validation, so a route's style only answers what its own handler threw.
 * A 4xx no style claims keeps Fastify's answer: Fastify's own (a malformed body, a failed schema,
 * a body too large) and typed errors thrown for the person to read. Anything else is logged and
 * answered generically, so no internal message (a path, an upstream's text) reaches the client.
 */
export function registerErrorHandler(
  app: FastifyInstance,
  report: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error),
): void {
  const handling = new WeakSet<FastifyRequest>();
  app.addHook("preHandler", async (request) => {
    handling.add(request);
  });
  app.setErrorHandler(async (error, request, reply) => {
    // A failed stream may have set the content type of the body it was going to send.
    const json = (status: number, body: unknown) =>
      reply.code(status).type("application/json; charset=utf-8").send(body);
    if (error instanceof HttpError) return json(error.statusCode, error.body);
    const answer = handling.has(request)
      ? request.routeOptions.config?.errors?.(error, request)
      : undefined;
    if (answer) return json(answer.status, answer.body);
    const status = statusOf(error);
    // Rethrowing hands the error to Fastify's default handler, unchanged.
    if (status !== undefined && status >= 400 && status < 500) throw error;
    report(`${request.method} ${request.routeOptions.url ?? "(no route)"} failed:`, error);
    return status === 503 ? json(503, UNAVAILABLE_ERROR_BODY) : json(500, INTERNAL_ERROR_BODY);
  });
}
