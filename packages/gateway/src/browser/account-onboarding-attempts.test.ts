import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { OnboardingMailbox } from "./account-onboarding-mail";
import { registerAccountOnboarding } from "./account-onboarding";

const route = "/api/client/session/session/onboarding/apple";
const details = {
  mailboxId: "alias",
  firstName: "First",
  lastName: "Last",
  country: "USA",
  birthday: "1990-01-01",
  phoneCode: "US",
  phone: "5550100",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

function fixture() {
  const app = Fastify();
  const query = `?attempt=${randomUUID()}`;
  const targets = [{ type: "page" as const, targetId: "tab", sessionId: "cdp" }];
  const listMessages = vi.fn<OnboardingMailbox["listMessages"]>(() => []);
  const readMessage = vi.fn<OnboardingMailbox["readMessage"]>(async () => undefined);
  let browserAvailable = true;
  const send = vi.fn(async (_sid: string, method: string, params?: Record<string, unknown>) => {
    if (method === "Page.getFrameTree") {
      return {
        frameTree: {
          frame: { id: "home", url: "https://www.icloud.com/" },
          childFrames: [
            {
              frame: { id: "auth", url: "https://idmsa.apple.com/appleauth/auth/authorize/signin" },
            },
            { frame: { id: "widget", url: "https://appleid.apple.com/widget/account/" } },
          ],
        },
      };
    }
    if (method === "Page.createIsolatedWorld") return { executionContextId: params?.frameId };
    if (method === "Runtime.evaluate") {
      const value =
        params?.contextId === "home"
          ? { x: 10, y: 20 }
          : String(params?.expression).includes("phoneCodes: options")
            ? { countries: [], phoneCodes: [] }
            : true;
      return { result: { value } };
    }
    return {};
  });
  const browser = { targets: () => targets, send };
  const open = vi.fn(async (_url: string) => "tab");
  registerAccountOnboarding(
    app,
    async (request, reply) => {
      if (request.headers["x-user"] !== "alice") await reply.code(403).send({ error: "Forbidden" });
    },
    () => (browserAvailable ? { browser, open } : undefined),
    {
      currentUserId: (request) => String(request.headers["x-user"]),
      mailbox: {
        enabled: true,
        getAddress: (owner, id) =>
          owner === "alice" && id === "alias"
            ? { id, address: "workspace@example.test" }
            : undefined,
        listMessages,
        readMessage,
      },
    },
  );
  const request = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { "x-user": "alice" } });
  return {
    app,
    query,
    targets,
    listMessages,
    readMessage,
    send,
    open,
    request,
    start: () => request("POST", route + query),
    fill: () => request("POST", route + "/tab" + query, details),
    cancel: () => request("DELETE", route + query),
    disconnect: () => {
      browserAvailable = false;
    },
  };
}

describe("Apple attempt cancellation", () => {
  it("aborts an opening wait even with CDP busy and leaves the existing Apple tab", async () => {
    const fx = fixture();
    const pending = deferred<object>();
    fx.send.mockImplementationOnce(() => pending.promise);
    try {
      const opening = fx.start();
      await vi.waitFor(() => expect(fx.send).toHaveBeenCalledWith("cdp", "Page.getFrameTree"));
      expect((await fx.cancel()).statusCode).toBe(204);
      expect((await opening).statusCode).toBe(410);
      pending.resolve({});
      await setImmediate();
      expect(fx.send.mock.calls).toEqual([["cdp", "Page.getFrameTree"]]);
      expect(fx.targets).toHaveLength(1);
    } finally {
      pending.resolve({});
      await fx.app.close();
    }
  });

  it("handles DELETE before the opening POST and scopes the cancellation by session and ID", async () => {
    const fx = fixture();
    try {
      const foreign = await fx.app.inject({ method: "DELETE", url: route + fx.query });
      expect(foreign.statusCode).toBe(403);
      expect((await fx.cancel()).statusCode).toBe(204);
      expect((await fx.cancel()).statusCode).toBe(204);
      expect((await fx.start()).statusCode).toBe(410);
      expect(fx.open).not.toHaveBeenCalled();
      expect(
        (await fx.request("POST", route.replace("/session/session/", "/session/other/") + fx.query))
          .statusCode,
      ).toBe(200);
      expect((await fx.request("POST", route + `?attempt=${randomUUID()}`)).statusCode).toBe(200);
    } finally {
      await fx.app.close();
    }
  });

  it("does not create a mailbox watcher after a filling request is canceled", async () => {
    const fx = fixture();
    const reached = deferred<void>();
    const pending = deferred<object>();
    const send = fx.send.getMockImplementation()!;
    try {
      expect((await fx.start()).statusCode).toBe(200);
      fx.send.mockImplementation((sid, method, params) => {
        if (
          method === "Runtime.evaluate" &&
          String(params?.expression).includes("birthday.split")
        ) {
          reached.resolve();
          return pending.promise;
        }
        return send(sid, method, params);
      });
      const filling = fx.fill();
      await reached.promise;
      expect((await fx.cancel()).statusCode).toBe(204);
      expect((await filling).statusCode).toBe(410);
      pending.resolve({ result: { value: true } });
      await setImmediate();
      expect(fx.listMessages).not.toHaveBeenCalled();
      const status = await fx.request("GET", route + "/tab/verification" + fx.query);
      expect(status.statusCode).toBe(410);
    } finally {
      pending.resolve({});
      await fx.app.close();
    }
  });

  it("stops a running mailbox watcher when its message read returns after cancellation", async () => {
    const fx = fixture();
    const pending = deferred<Awaited<ReturnType<OnboardingMailbox["readMessage"]>>>();
    const mail = {
      id: "mail",
      from: "Apple <appleid@id.apple.com>",
      subject: "Verify your email address",
      receivedAt: Date.now() + 1000,
      text: "Your verification code is 123456",
      authenticated: true,
    };
    fx.listMessages.mockReturnValue([mail]);
    fx.readMessage.mockReturnValue(pending.promise);
    try {
      expect((await fx.start()).statusCode).toBe(200);
      expect((await fx.fill()).json()).toEqual({ filled: true, watching: true });
      expect(fx.readMessage).toHaveBeenCalledExactlyOnceWith("alice", "alias", "mail");
      fx.send.mockClear();
      expect((await fx.cancel()).statusCode).toBe(204);
      pending.resolve(mail);
      await setImmediate();
      expect(fx.send).not.toHaveBeenCalled();
      expect((await fx.request("GET", route + "/tab/verification")).json()).toEqual({
        ready: false,
        expired: true,
      });
    } finally {
      pending.resolve(undefined);
      await fx.app.close();
    }
  });

  it("returns 410 for a closed or disconnected attempt while keeping the legacy missing-tab response", async () => {
    const fx = fixture();
    try {
      expect((await fx.start()).statusCode).toBe(200);
      fx.targets.length = 0;
      expect((await fx.fill()).statusCode).toBe(410);
      expect((await fx.request("POST", route + "/tab", details)).statusCode).toBe(404);
      fx.disconnect();
      expect((await fx.request("GET", route + "/tab/verification" + fx.query)).statusCode).toBe(
        410,
      );
      expect((await fx.cancel()).statusCode).toBe(204);
    } finally {
      await fx.app.close();
    }
  });
});
