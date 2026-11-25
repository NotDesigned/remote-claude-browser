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

/**
 * Registers the error handler. Call it before any hook or route: it marks each request that got
 * past body parsing and validation, so a route's style only answers what its own handler threw.
 * Fastify's errors (a malformed body, a failed schema, a body too large) keep Fastify's answer.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  const handling = new WeakSet<FastifyRequest>();
  app.addHook("preHandler", async (request) => {
    handling.add(request);
  });
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.statusCode).send(error.body);
    const answer = handling.has(request)
      ? request.routeOptions.config?.errors?.(error, request)
      : undefined;
    // Rethrowing hands the error to Fastify's default handler, unchanged.
    if (!answer) throw error;
    return reply.code(answer.status).send(answer.body);
  });
}
