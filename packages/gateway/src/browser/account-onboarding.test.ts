import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createVerification, type OnboardingMailbox } from "./account-onboarding-mail";
import { registerAccountOnboarding } from "./account-onboarding";

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

  it("only hands an authenticated Apple email code to the challenge in the live runtime", async () => {
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
    const apply = vi.fn(async () => true);
    const verification = createVerification(mailbox);
    try {
      verification.start({ ...context, provider: "apple", apply });
      await vi.waitFor(() => expect(verification.status("apple", tab, "alice").ready).toBe(true));
      expect(apply).toHaveBeenCalledExactlyOnceWith("123456");
      disconnect();
      expect(verification.status("apple", tab, "alice")).toEqual({ ready: false, expired: true });
    } finally {
      verification.close();
    }
  });
});

describe("onboarding endpoints", () => {
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
