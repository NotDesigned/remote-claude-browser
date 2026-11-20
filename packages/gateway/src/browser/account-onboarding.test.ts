import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createVerification, type OnboardingMailbox } from "./account-onboarding-mail";
import { registerAccountOnboarding } from "./account-onboarding";
import type { TargetRef } from "../types";

function mailFixture() {
  const email = "workspace@example.test";
  const since = Date.now();
  const tab = { sid: "session", tab: "tab" };
  const messages: NonNullable<Awaited<ReturnType<OnboardingMailbox["readMessage"]>>>[] = [];
  const readMessage = vi.fn(async (_owner: string, _alias: string, id: string) =>
    messages.find((mail) => mail.id === id),
  );
  const mailbox: OnboardingMailbox = {
    enabled: true,
    getAddress: (owner, id) =>
      owner === "alice" && id === "alias" ? { id, address: email } : undefined,
    listMessages: () => messages,
    readMessage,
  };
  let current = true;
  const context = {
    ...tab,
    owner: "alice",
    mailboxId: "alias",
    email,
    since,
    isActive: () => current,
  };
  return {
    mailbox,
    messages,
    readMessage,
    context,
    tab,
    disconnect: () => {
      current = false;
    },
  };
}

describe("mail verification", () => {
  it("opens an authenticated Apple-forwarded link for the saved relay address only", async () => {
    const { mailbox, messages, context, tab } = mailFixture();
    const email = "a1b2c3@private.icloud.com";
    const link = (address: string) =>
      `https://claude.ai/magic-link#0123456789abcdef0123456789abcdef:${Buffer.from(address).toString("base64")}`;
    const mail = {
      from: "Relay <forwarded@privaterelay.appleid.com>",
      subject: "Your secure link to Claude is here | 2026-11-20 03:31:13",
    };
    messages.push(
      {
        ...mail,
        id: "valid",
        text: link(email),
        receivedAt: context.since + 1,
        authenticated: true,
      },
      {
        ...mail,
        id: "wrong-account",
        text: link(context.email),
        receivedAt: context.since + 2,
        authenticated: true,
      },
      {
        ...mail,
        id: "unauthenticated",
        text: link(email),
        receivedAt: context.since + 3,
        authenticated: false,
      },
    );
    const apply = vi.fn(async () => "submitted" as const);
    const verification = createVerification(mailbox);
    try {
      verification.start({ ...context, provider: "claude", email, apply });
      await vi.waitFor(() =>
        expect(verification.status("claude", tab, "alice")).toEqual({
          ready: true,
          submitted: true,
          expired: false,
        }),
      );
      expect(apply).toHaveBeenCalledExactlyOnceWith(link(email));
      expect(verification.status("claude", tab, "bob").expired).toBe(true);
    } finally {
      verification.close();
    }
  });

  it("uses current authenticated mail for the same alias and opens the newest official link once", async () => {
    const { mailbox, messages, readMessage, context, tab } = mailFixture();
    const token = "0123456789abcdef0123456789abcdef";
    const link = (email: string) =>
      `https://claude.ai/magic-link#${token}:${Buffer.from(email).toString("base64")}`;
    const url = link(context.email);
    const mail = {
      from: "Claude <login@mail.anthropic.com>",
      subject: "Secure link to log in to Claude.ai",
      authenticated: true,
    };
    for (const [id, delta, text, authenticated] of [
      ["before-request", -1, url, true],
      ["older", 1, url, true],
      ["newest", 2, url, true],
      ["tracking-link", 3, `https://mailer.example.test/?url=${url}`, true],
      ["other-alias", 4, link("other@example.test"), true],
      ["unauthenticated", 5, url, false],
    ] as const) {
      messages.push({ ...mail, id, text, authenticated, receivedAt: context.since + delta });
    }
    const verification = createVerification(mailbox);
    try {
      verification.start({ ...context, provider: "claude" });
      await vi.waitFor(() => expect(verification.status("claude", tab, "alice").ready).toBe(true));
      expect(verification.status("claude", tab, "bob")).toEqual({ ready: false, expired: true });
      expect(verification.status("claude", { ...tab, sid: "another" }, "alice").expired).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1_550));
      expect(readMessage.mock.calls.map((call) => call[2])).toEqual([
        "unauthenticated",
        "other-alias",
        "tracking-link",
        "newest",
      ]);
      let release!: (result: boolean) => void;
      const navigate = vi.fn(
        (_url: string) =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
      );
      expect(await verification.open(tab, "bob", navigate)).toBe(false);
      const opening = verification.open(tab, "alice", navigate);
      expect(await verification.open(tab, "alice", navigate)).toBe(false);
      expect(navigate).toHaveBeenCalledExactlyOnceWith(url);
      release(true);
      expect(await opening).toBe(true);
      expect(verification.status("claude", tab, "alice").expired).toBe(true);
    } finally {
      verification.close();
    }
  });

  it.each(["filled", "submitted"] as const)(
    "records an authenticated Apple email code as %s in the live runtime",
    async (action) => {
      const { mailbox, messages, context, tab, disconnect } = mailFixture();
      const mail = {
        from: "Apple <appleid@id.apple.com>",
        subject: "Verify your Apple Account email address",
        receivedAt: context.since,
        authenticated: true,
      };
      messages.push(
        {
          ...mail,
          id: "spoofed",
          text: "Code 234567",
          receivedAt: context.since + 2,
          authenticated: false,
        },
        {
          ...mail,
          id: "unrelated",
          text: "Order 345678",
          receivedAt: context.since + 1,
          subject: "Your receipt",
        },
        { ...mail, id: "official", text: "Your verification code is 123456" },
      );
      const apply = vi.fn(async () => action);
      const verification = createVerification(mailbox);
      try {
        verification.start({ ...context, provider: "apple", apply });
        await vi.waitFor(() =>
          expect(verification.status("apple", tab, "alice")).toEqual({
            ready: true,
            expired: false,
            ...(action === "submitted" && { submitted: true }),
          }),
        );
        expect(apply).toHaveBeenCalledExactlyOnceWith("123456");
        disconnect();
        expect(verification.status("apple", tab, "alice")).toEqual({ ready: false, expired: true });
      } finally {
        verification.close();
      }
    },
  );
});

describe("onboarding endpoints", () => {
  it("opens Gmail for Google registration and tracks the same tab", async () => {
    const app = Fastify();
    let targets: TargetRef[] = [{ targetId: "google-tab", type: "page", sessionId: "cdp" }];
    const browser = {
      targets: () => targets,
      send: vi.fn(async () => ({})),
    };
    const open = vi.fn(async () => "google-tab");
    registerAccountOnboarding(
      app,
      async () => {},
      () => ({ browser, open }),
      { currentUserId: () => "alice" },
    );
    try {
      const opened = await app.inject({
        method: "POST",
        url: "/api/client/session/session/onboarding/google",
      });
      expect(open).toHaveBeenCalledExactlyOnceWith("https://mail.google.com/", true);
      expect(opened.statusCode).toBe(200);
      expect(opened.json()).toMatchObject({ tab: "google-tab", url: "https://mail.google.com/" });
      const { attempt } = opened.json();
      expect(
        (
          await app.inject({
            url: `/api/client/session/session/onboarding/google/google-tab/status?attempt=${attempt}`,
          })
        ).json(),
      ).toEqual({ active: true, tab: "google-tab" });
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/client/session/session/onboarding/google/google-tab?attempt=${attempt}`,
            payload: {
              firstName: "First",
              lastName: "Last",
              birthday: "2000-01-02",
              gender: "female",
              username: "first.last",
              password: "ExamplePass123!",
              passwordConfirmation: "DifferentPass123!",
            },
          })
        ).statusCode,
      ).toBe(400);
      targets = [];
      expect(
        (
          await app.inject({
            url: `/api/client/session/session/onboarding/google/google-tab/status?attempt=${attempt}`,
          })
        ).statusCode,
      ).toBe(410);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/client/session/session/onboarding/google?attempt=${attempt}`,
          })
        ).statusCode,
      ).toBe(204);
    } finally {
      await app.close();
    }
  });

  it.each([false, true])("opens the Apple widget with a slow iCloud sign-in=%s", async (slow) => {
    const home = "https://www.icloud.com/";
    const account = "https://account.apple.com/account";
    const widget = { frame: { id: "widget", url: "https://appleid.apple.com/widget/account/" } };
    const auth = {
      frame: { id: "auth", url: "https://idmsa.apple.com/appleauth/auth/authorize/signin" },
    };
    const options = { countries: [["USA", "United States"]], phoneCodes: [["US", "+1"]] };
    const app = Fastify();
    let url = home;
    let signIn = false;
    let created = false;
    let fallbackPolls = 0;
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const send = vi.fn(async (_session, method, params) => {
      if (method === "Page.getFrameTree") {
        const childFrames = [];
        if (url === home) {
          if (signIn) childFrames.push(auth);
          if (created) childFrames.push(widget);
        } else if (++fallbackPolls === 1) {
          now += 21_000;
        } else {
          childFrames.push(widget);
        }
        return { frameTree: { frame: { id: "main", url }, childFrames } };
      }
      if (method === "Page.createIsolatedWorld") return { executionContextId: params.frameId };
      if (method === "Runtime.evaluate") {
        if (params.contextId === "main") return { result: { value: { x: 10, y: 10 } } };
        if (params.contextId === "auth") {
          if (slow) now += 35_001;
          else created = true;
          return { result: { value: created || null } };
        }
        return { result: { value: options } };
      }
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") signIn = true;
      if (method === "Page.navigate") url = params.url;
      return {};
    });
    const browser = {
      targets: () => [{ targetId: "tab", type: "page" as const, sessionId: "cdp" }],
      send,
    };
    const open = vi.fn(async () => "tab");
    registerAccountOnboarding(
      app,
      async () => {},
      () => ({ browser, open }),
      {
        currentUserId: () => "alice",
      },
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/client/session/session/onboarding/apple",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ tab: "tab", options });
      expect(open).toHaveBeenCalledExactlyOnceWith(home);
      expect(send.mock.calls.filter((call) => call[1] === "Page.navigate")).toEqual(
        slow ? [["cdp", "Page.navigate", { url: account }]] : [],
      );
      expect(fallbackPolls).toBe(slow ? 2 : 0);
    } finally {
      clock.mockRestore();
      await app.close();
    }
  });

  it("starts Apple mail verification after partial autofill and expires it after ten minutes", async () => {
    const { mailbox } = mailFixture();
    const app = Fastify();
    const browser = {
      targets: () => [{ targetId: "tab", type: "page" as const, sessionId: "cdp" }],
      async send(_session: string, method: string) {
        if (method === "Page.getFrameTree") {
          return {
            frameTree: { frame: { id: "main", url: "https://appleid.apple.com/widget/account/" } },
          };
        }
        if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
        return { result: { value: false } };
      },
    };
    registerAccountOnboarding(
      app,
      async () => {},
      () => ({ browser, open: async () => "tab" }),
      { currentUserId: () => "alice", mailbox },
    );
    const url = "/api/client/session/session/onboarding/apple/tab";
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      const response = await app.inject({
        method: "POST",
        url,
        payload: {
          mailboxId: "alias",
          firstName: "First",
          lastName: "Last",
          country: "USA",
          birthday: "1990-01-01",
          phoneCode: "US",
          phone: "5550100",
        },
      });
      expect(response.json()).toEqual({ filled: false, watching: true });
      const status = async () => (await app.inject({ url: `${url}/verification` })).json();
      clock.mockReturnValue(start + 10 * 60_000 - 1);
      expect(await status()).toEqual({ ready: false, expired: false });
      clock.mockReturnValue(start + 10 * 60_000);
      expect(await status()).toEqual({ ready: false, expired: true });
    } finally {
      clock.mockRestore();
      await app.close();
    }
  });

  it.each([true, false])(
    "keeps aliases private and supports manual entry when mailbox enabled=%s",
    async (enabled) => {
      const { mailbox } = mailFixture();
      const app = Fastify();
      const send = vi.fn(async (_session, method, params) => {
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { id: "main", url: "https://claude.ai/login" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
        if (method === "Runtime.evaluate")
          return { result: { value: params.expression.includes("example.test") } };
      });
      const browser = {
        targets: () => [{ targetId: "tab", type: "page" as const, sessionId: "cdp" }],
        send,
      };
      const open = vi.fn(async () => "tab");
      registerAccountOnboarding(
        app,
        async () => {},
        () => ({ browser, open }),
        {
          currentUserId: (request) => request.headers["x-user"] as string,
          mailbox: { ...mailbox, enabled },
        },
      );
      const url = "/api/client/session/session/onboarding/claude";
      const post = (user: string, payload: object) =>
        app.inject({
          method: "POST",
          url,
          payload,
          headers: { "x-user": user },
        });
      try {
        expect((await post("bob", { mailboxId: "alias" })).statusCode).toBe(404);
        expect((await post("alice", {})).statusCode).toBe(400);
        expect(open).not.toHaveBeenCalled();
        const manual = await post("alice", { email: "manual@example.test" });
        expect(manual.json()).toEqual({ tab: "tab", filled: true, watching: false });
        const managed = await post("alice", { mailboxId: "alias", email: "override@example.test" });
        if (enabled) {
          expect(managed.json()).toEqual({ tab: "tab", filled: true, watching: true });
          const expression = send.mock.calls
            .filter((call) => call[1] === "Runtime.evaluate")
            .at(-1)?.[2].expression;
          expect(expression).toContain("workspace@example.test");
          expect(expression).not.toContain("override@example.test");
        } else {
          expect(managed.statusCode).toBe(404);
        }
        const status = await app.inject({
          url: `${url}/tab/verification`,
          headers: { "x-user": "alice" },
        });
        expect(status.headers["cache-control"]).toBe("no-store");
        expect(status.json()).toEqual({ ready: false, expired: !enabled });
      } finally {
        await app.close();
      }
    },
  );
});
