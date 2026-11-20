import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import {
  allowPaymentHandoff,
  PAYMENT_HANDOFF_PERMISSIONS_POLICY,
  registerSecurityHeaders,
  SECURITY_HEADERS,
} from "./security-headers";

describe("security headers", () => {
  it("applies the browser-facing baseline to every response", async () => {
    const app = Fastify();
    registerSecurityHeaders(app);
    app.get("/", async () => ({ ok: true }));

    const response = await app.inject({ method: "GET", url: "/" });

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers[name]).toBe(value);
    }
    await app.close();
  });

  it("does not replace a stricter route-specific value", async () => {
    const app = Fastify();
    registerSecurityHeaders(app);
    app.get("/", async (_request, reply) => {
      reply.header("referrer-policy", "same-origin");
      return { ok: true };
    });

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.headers["referrer-policy"]).toBe("same-origin");
    await app.close();
  });

  it("allows payment only on the dedicated handoff route", async () => {
    const app = Fastify();
    registerSecurityHeaders(app);
    app.get("/", async () => ({ ok: true }));
    app.get("/pay/handoff/test", async (_request, reply) => {
      allowPaymentHandoff(reply);
      return { ok: true };
    });

    const baseline = await app.inject({ method: "GET", url: "/" });
    const handoff = await app.inject({ method: "GET", url: "/pay/handoff/test" });

    expect(baseline.headers["permissions-policy"]).toBe(SECURITY_HEADERS["permissions-policy"]);
    expect(handoff.headers["permissions-policy"]).toBe(PAYMENT_HANDOFF_PERMISSIONS_POLICY);
    await app.close();
  });
});
