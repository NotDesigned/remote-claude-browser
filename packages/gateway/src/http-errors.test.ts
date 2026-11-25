import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  codeAnswer,
  HttpError,
  messageAnswer,
  registerErrorHandler,
  type ErrorStyle,
} from "./http-errors";

class TypedFailure extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const style: ErrorStyle = (error) =>
  error instanceof TypedFailure
    ? messageAnswer(error, { extra: true })
    : { status: 503, body: { error: "unavailable" } };

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function fixture() {
  const app = Fastify();
  apps.push(app);
  registerErrorHandler(app);
  const config = { errors: style };
  app.get("/typed", { config }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    throw new TypedFailure(409, "TAKEN", "已被占用");
  });
  app.get("/other", { config }, async () => {
    throw new Error("disk failure");
  });
  app.get("/decided", { config }, async () => {
    throw new HttpError(401, { error: "请重新登录" });
  });
  app.get("/plain", async () => {
    throw new TypedFailure(409, "TAKEN", "已被占用");
  });
  app.post(
    "/body",
    {
      config,
      bodyLimit: 64,
      schema: { body: { type: "object", required: ["name"] } },
    },
    async () => ({ ok: true }),
  );
  return app;
}

describe("the gateway error handler", () => {
  it("answers a handler's typed error in its route group's shape, keeping headers", async () => {
    const response = await fixture().inject({ url: "/typed" });
    expect(response.statusCode).toBe(409);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ error: "已被占用", code: "TAKEN", extra: true });
  });

  it("uses the group's fallback for any other handler error", async () => {
    const response = await fixture().inject({ url: "/other" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "unavailable" });
  });

  it("sends an already decided answer as is", async () => {
    const response = await fixture().inject({ url: "/decided" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "请重新登录" });
  });

  it("leaves routes without a style to Fastify's default answer", async () => {
    const response = await fixture().inject({ url: "/plain" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      statusCode: 409,
      code: "TAKEN",
      error: "Conflict",
      message: "已被占用",
    });
  });

  it("leaves Fastify's own body errors to Fastify, even on a styled route", async () => {
    const app = fixture();
    const invalid = await app.inject({ method: "POST", url: "/body", payload: {} });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "FST_ERR_VALIDATION" });
    const malformed = await app.inject({
      method: "POST",
      url: "/body",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ statusCode: 400, error: "Bad Request" });
    const large = await app.inject({
      method: "POST",
      url: "/body",
      payload: { name: "x".repeat(100) },
    });
    expect(large.statusCode).toBe(413);
    expect(large.json()).toMatchObject({ code: "FST_ERR_CTP_BODY_TOO_LARGE" });
    expect(
      (await app.inject({ method: "POST", url: "/body", payload: { name: "a" } })).json(),
    ).toEqual({ ok: true });
  });

  it("builds the two typed shapes", () => {
    const error = new TypedFailure(404, "UNKNOWN", "没有");
    expect(messageAnswer(error)).toEqual({
      status: 404,
      body: { error: "没有", code: "UNKNOWN" },
    });
    expect(codeAnswer(error)).toEqual({ status: 404, body: { error: "UNKNOWN", message: "没有" } });
  });
});
