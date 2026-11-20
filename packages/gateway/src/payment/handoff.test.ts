import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createPaymentHandoffs, registerPaymentHandoffRoutes } from "./handoff";

describe("payment handoff store", () => {
  it("expires a one-time handoff and accepts a signed provider result", () => {
    let now = 1_000;
    const store = createPaymentHandoffs({
      now: () => now,
      ttlMs: 100,
      allowedOrigins: ["https://merchant.example"],
      webhookSecret: "secret",
    });
    const created = store.create({
      sid: "client-1",
      userId: "user-1",
      profileId: "profile-1",
      provider: "google-pay",
      merchantOrigin: "https://merchant.example",
      resumeUrl: "https://merchant.example/checkout/one",
    });
    expect(store.forUser("user-1", "client-1", created.record.id)?.status).toBe("pending");
    expect(store.markOpened(created.token)?.status).toBe("opened");
    const body = { status: "authorized" as const, providerReference: "psp-1" };
    const signature = createHmac("sha256", "secret").update(JSON.stringify(body)).digest("hex");
    expect(store.completeSigned(created.token, body, `sha256=${signature}`)?.status).toBe(
      "authorized",
    );
    now = 1_101;
    expect(store.resolve(created.token)).toBeUndefined();
  });

  it("requires the resume URL to use the approved merchant origin", () => {
    const store = createPaymentHandoffs({ allowedOrigins: ["https://merchant.example"] });
    expect(() =>
      store.create({
        sid: "client-1",
        userId: "user-1",
        profileId: "profile-1",
        provider: "apple-pay",
        merchantOrigin: "https://merchant.example",
        resumeUrl: "https://other.example/checkout",
      }),
    ).toThrow("resumeUrl");
    expect(() =>
      store.create({
        sid: "client-1",
        userId: "user-1",
        profileId: "profile-1",
        provider: "apple-pay",
        merchantOrigin: "https://other.example",
        resumeUrl: "https://other.example/checkout",
      }),
    ).toThrow("白名单");
  });
});

describe("payment handoff routes", () => {
  it("creates, opens, reports capability, and reads status", async () => {
    const app = Fastify();
    registerPaymentHandoffRoutes(app, {
      requireSession: async () => undefined,
      currentUserId: () => "user-1",
      profileForSession: vi.fn(() => "profile-1"),
      allowedOrigins: ["https://merchant.example"],
      publicOrigin: "https://remote.example",
    });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/client/session/client-1/payment/handoff",
        payload: {
          provider: "google-pay",
          merchantOrigin: "https://merchant.example",
          resumeUrl: "https://merchant.example/checkout/one",
          orderRef: "order-1",
        },
      });
      expect(created.statusCode).toBe(200);
      const { handoffId, url } = created.json();
      expect(url).toMatch(/^https:\/\/remote\.example\/pay\/handoff\//);
      const token = url.split("/").at(-1);
      expect(token).toBeTruthy();
      expect((await app.inject({ method: "GET", url: `/pay/handoff/${token}` })).statusCode).toBe(
        200,
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/pay/handoff/${token}/capability`,
            payload: { googlePay: true, browser: "Chrome" },
          })
        ).json(),
      ).toEqual({ ok: true, capabilities: { googlePay: true, browser: "Chrome" } });
      expect(
        (
          await app.inject({
            url: `/api/client/session/client-1/payment/handoff/${handoffId}`,
          })
        ).json(),
      ).toMatchObject({ status: "opened", provider: "google-pay", orderRef: "order-1" });
    } finally {
      await app.close();
    }
  });
});
