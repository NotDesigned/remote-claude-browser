import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerErrorHandler } from "../http-errors";
import {
  createMailboxService,
  MAX_ADDRESSES_PER_USER,
  registerMailboxRoutes,
  RESEND_WEBHOOK_PATH,
} from "./mailboxes";

const signingKey = Buffer.from("mailboxes-test-svix-key");
const now = 1_789_000_000_000;
const provider = {
  apiKey: "re_test",
  webhookSecret: `whsec_${signingKey.toString("base64")}`,
  domain: "mail.example.com",
  now: () => now,
};
const mailboxPath = "/api/me/mailboxes";

function signed(body: string, timestamp = now / 1000) {
  const id = "msg_test";
  const signature = createHmac("sha256", signingKey)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": `v2,ignored v1,${signature}`,
  };
}

function event(to: string[], receivedFor: string[] = [], receivedAt = now) {
  return JSON.stringify(
    {
      type: "email.received",
      data: {
        email_id: "test-email",
        to,
        from: "sender@example.com",
        subject: "Verify your email",
        created_at: new Date(receivedAt).toISOString(),
        received_for: receivedFor,
      },
    },
    null,
    2,
  );
}

it("routes verified delivery to matching addresses and serves message bodies only to their owners", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      from: "sender@example.com",
      text: null,
      html: '<p>Code: <strong>123456</strong> <a href="https://example.com/verify">Verify</a></p>',
      authentication: { dmarc: "pass" },
    }),
  );
  const secondDomain = "inbox.example.net";
  const store = await createMailboxService({
    file: ":memory:",
    ...provider,
    domain: `${provider.domain}, ${secondDomain}`,
    fetcher,
  });
  const app = Fastify();
  registerMailboxRoutes(app, store, (request) => request.headers["x-test-user"] as string);
  try {
    expect((await app.inject({ url: mailboxPath })).statusCode).toBe(401);
    const owner = { "x-test-user": "owner" };
    const other = { "x-test-user": "other" };
    const response = await app.inject({
      method: "POST",
      url: mailboxPath,
      headers: owner,
      payload: { label: "  我的账号  " },
    });
    expect(response.statusCode).toBe(201);
    const { address: first } = response.json();
    const second = store.createAddress("owner", undefined, undefined, secondDomain);
    const third = store.createAddress("other");
    expect(first.label).toBe("我的账号");
    expect(first.address).toMatch(/^[a-z]+-[a-z]+@mail\.example\.com$/);
    expect(second.address).toMatch(/^[a-z]+-[a-z]+@inbox\.example\.net$/);
    expect((await app.inject({ url: mailboxPath, headers: owner })).json()).toEqual({
      enabled: true,
      domain: provider.domain,
      domains: [provider.domain, secondDomain],
      addresses: [first, second].sort((a, b) => a.id.localeCompare(b.id)),
    });

    const payload = event(
      [first.address.toUpperCase(), second.address, second.address],
      [third.address],
    );
    const webhook = { method: "POST", url: RESEND_WEBHOOK_PATH, payload } as const;
    expect((await app.inject({ ...webhook, headers: signed(payload + " ") })).statusCode).toBe(401);
    expect(
      (await app.inject({ ...webhook, headers: signed(payload, now / 1000 - 301) })).statusCode,
    ).toBe(401);
    expect(store.listMessages("owner", first.id)).toEqual([]);
    for (let retry = 0; retry < 2; retry++)
      expect((await app.inject({ ...webhook, headers: signed(payload) })).statusCode).toBe(200);

    const summary = {
      id: "test-email",
      from: "sender@example.com",
      subject: "Verify your email",
      receivedAt: now,
    };
    expect(store.listMessages("owner", first.id)).toEqual([summary]);
    expect(store.listMessages("owner", second.id)).toEqual([summary]);
    expect(store.listMessages("owner", first.id, now + 1)).toEqual([]);
    expect(store.listMessages("other", third.id)).toEqual([]);
    const messages = `${mailboxPath}/${first.id}/messages`;
    expect((await app.inject({ url: messages, headers: owner })).json()).toEqual({
      messages: [summary],
    });
    expect((await app.inject({ url: messages, headers: other })).statusCode).toBe(404);
    expect((await app.inject({ url: `${messages}/test-email`, headers: other })).statusCode).toBe(
      404,
    );
    expect(fetcher).not.toHaveBeenCalled();

    const detail = await app.inject({ url: `${messages}/test-email`, headers: owner });
    expect(detail.headers["cache-control"]).toBe("no-store");
    expect(detail.json()).toEqual({
      message: {
        ...summary,
        authenticated: true,
        text: "Code: 123456 Verify [https://example.com/verify]",
        html: '<div class="mail-canvas"><p>Code: <strong>123456</strong> <button type="button" class="mail-remote-link" data-mail-url="https://example.com/verify">Verify</button></p></div>',
      },
    });
    expect(await store.readMessage("owner", first.id, "test-email")).toMatchObject({
      authenticated: true,
    });
    fetcher.mockResolvedValueOnce(
      Response.json({
        from: "sender\u202e@example.com",
        text: "Unverified email",
        headers: { "authentication-results": "dmarc=pass" },
      }),
    );
    const unverified = await app.inject({ url: `${messages}/test-email`, headers: owner });
    expect(unverified.json()).toMatchObject({
      message: {
        from: "sender@example.com",
        authenticated: false,
      },
    });
    fetcher.mockResolvedValueOnce(
      Response.json({
        from: "noreply@anthropic.com",
        text: null,
        html: '<img alt="Logo" src="https://claude.ai/pixel.png?uid=1" width="1" height="1"><p>Sign in: <a href="https://claude.ai/magic-link#tok">Open Claude</a></p><img src="https://tracker.example/open.gif">',
        authentication: { dmarc: "pass" },
      }),
    );
    expect(await store.readMessage("owner", first.id, "test-email")).toMatchObject({
      text: "Sign in: Open Claude [https://claude.ai/magic-link#tok]",
      authenticated: true,
    });
    const url = `${mailboxPath}/${first.id}`;
    expect((await app.inject({ method: "DELETE", url, headers: other })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url, headers: owner })).statusCode).toBe(204);
    await app.inject({ ...webhook, headers: signed(payload) });
    expect(store.getAddress("owner", first.id)).toBeUndefined();
    expect(store.listMessages("owner", first.id)).toEqual([]);
    expect(store.listMessages("owner", second.id)).toEqual([summary]);
  } finally {
    await app.close();
    store.close();
  }
});

it("only indexes mail received after an address was assigned and never reuses a retired address", async () => {
  const store = await createMailboxService({ file: ":memory:", ...provider });
  try {
    const { id, address } = store.assignAddress("owner", "Existing@MAIL.EXAMPLE.COM");
    const earlier = event([address], [], now - 1);
    store.receive(Buffer.from(earlier), signed(earlier));
    expect(store.listMessages("owner", id)).toEqual([]);
    const current = event([address]);
    store.receive(Buffer.from(current), signed(current));
    expect(store.listMessages("owner", id)).toHaveLength(1);
    store.deleteAddress("owner", id);
    expect(() => store.assignAddress("other", address)).toThrow("已被分配或停用");
  } finally {
    store.close();
  }
});

it("binds an existing address only after its request owner supplies the delivered code", async () => {
  let time = now;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "sent-test" }));
  const store = await createMailboxService({
    file: ":memory:",
    ...provider,
    domain: `${provider.domain}, amadeus.example.net`,
    verificationFrom: "verify@mail.example.com",
    now: () => time,
    fetcher,
  });
  const app = Fastify();
  registerMailboxRoutes(app, store, (request) => request.headers["x-test-user"] as string);
  const address = "alice@amadeus.example.net";
  const claims = `${mailboxPath}/claims`;
  const owner = { "x-test-user": "owner" };
  const post = (url: string, payload: object, headers?: typeof owner) =>
    app.inject({ method: "POST", url, payload, headers });
  const begin = () => post(claims, { address: address.toUpperCase() }, owner);
  const confirm = (code: string, headers = owner) =>
    post(`${claims}/confirm`, { address, code }, headers);
  const latestCode = () => {
    const [url, request] = fetcher.mock.lastCall!;
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({ from: "verify@mail.example.com", to: [address] });
    return body.text.match(/\b\d{8}\b/)[0] as string;
  };
  try {
    expect((await post(claims, { address })).statusCode).toBe(401);
    expect((await post(claims, { address: "alice@example.org" }, owner)).statusCode).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await begin()).json()).toEqual({ address });
    const initialCode = latestCode();
    expect((await begin()).statusCode).toBe(429);
    const listed = await app.inject({ url: mailboxPath, headers: owner });
    expect(listed.json()).toMatchObject({ canClaim: true, pendingClaim: address, addresses: [] });
    expect(listed.body).not.toContain(initialCode);
    const early = event([address]);
    store.receive(Buffer.from(early), signed(early));
    expect((await confirm(initialCode, { "x-test-user": "other" })).statusCode).toBe(400);
    expect((await confirm("incorrect")).statusCode).toBe(400);
    expect(store.listAddresses("owner")).toEqual([]);
    time += 10 * 60_000;
    expect((await confirm(initialCode)).statusCode).toBe(400);
    expect((await begin()).statusCode).toBe(200);
    const confirmed = await confirm(latestCode());
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json().address.address).toBe(address);
    expect(store.listMessages("owner", confirmed.json().address.id)).toEqual([]);
    expect((await confirm(latestCode())).statusCode).toBe(400);
    expect((await post(claims, { address }, { "x-test-user": "other" })).statusCode).toBe(409);
    expect(store.listAddresses("other")).toEqual([]);
  } finally {
    await app.close();
    store.close();
  }
});

it("routes messages to existing addresses and deletes them while Resend is disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mirror-mailbox-"));
  const file = join(dir, "mail.sqlite");
  try {
    const enabled = await createMailboxService({ file, ...provider });
    const address = {
      ...enabled.createAddress("owner"),
      address: "mail-0123456789abcdef0123456789abcdef@mail.example.com",
    };
    const db = new DatabaseSync(file);
    db.prepare("UPDATE mailbox_addresses SET address = ? WHERE id = ?").run(
      address.address,
      address.id,
    );
    db.close();
    const payload = event([address.address]);
    enabled.receive(Buffer.from(payload), signed(payload));
    enabled.close();

    const disabled = await createMailboxService({ file });
    const app = Fastify();
    registerMailboxRoutes(app, disabled, () => "owner");
    try {
      expect((await app.inject({ url: mailboxPath })).json()).toEqual({
        enabled: false,
        domains: [],
        addresses: [],
      });
      expect((await app.inject({ method: "POST", url: RESEND_WEBHOOK_PATH })).statusCode).toBe(404);
      expect(disabled.getAddress("owner", address.id)).toEqual(address);
      expect(disabled.listMessages("owner", address.id)).toHaveLength(1);
      disabled.deleteUser("owner");
      expect(disabled.getAddress("owner", address.id)).toBeUndefined();
      expect(disabled.listMessages("owner", address.id)).toEqual([]);
    } finally {
      await app.close();
      disabled.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("caps the addresses a user creates or claims, but not an administrator's assignment", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "sent-test" }));
  const store = await createMailboxService({
    file: ":memory:",
    ...provider,
    verificationFrom: "verify@mail.example.com",
    fetcher,
  });
  const app = Fastify();
  registerErrorHandler(app, () => undefined);
  registerMailboxRoutes(app, store, () => "owner");
  try {
    for (let index = 0; index < MAX_ADDRESSES_PER_USER; index++) store.createAddress("owner");
    const refused = await app.inject({ method: "POST", url: mailboxPath, payload: {} });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toContain(String(MAX_ADDRESSES_PER_USER));
    expect(() => store.createAddress("owner", "", "spare")).toThrow("最多");
    await expect(store.startClaim("owner", "someone@mail.example.com")).rejects.toThrow("最多");
    expect(fetcher).not.toHaveBeenCalled();
    store.assignAddress("owner", "assigned@mail.example.com");
    expect(store.listAddresses("owner")).toHaveLength(MAX_ADDRESSES_PER_USER + 1);
  } finally {
    await app.close();
    store.close();
  }
});

it("leaves no pending claim when the code could not be sent, and says so to the person", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("upstream detail", { status: 500 }));
  let time = now;
  const store = await createMailboxService({
    file: ":memory:",
    ...provider,
    verificationFrom: "verify@mail.example.com",
    now: () => time,
    fetcher,
  });
  const app = Fastify();
  registerErrorHandler(app, () => undefined);
  registerMailboxRoutes(app, store, () => "owner");
  const begin = (address: string) =>
    app.inject({ method: "POST", url: `${mailboxPath}/claims`, payload: { address } });
  try {
    const failed = await begin("first@mail.example.com");
    expect(failed.statusCode).toBe(502);
    expect(failed.json().message).toBe("暂时无法发送验证码，请稍后重试");
    expect(failed.body).not.toContain("upstream detail");
    expect(store.pendingClaim("owner")).toBeUndefined();

    fetcher.mockResolvedValue(Response.json({ id: "sent" }));
    expect((await begin("first@mail.example.com")).statusCode).toBe(200);
    expect(store.pendingClaim("owner")).toBe("first@mail.example.com");
    time += 2 * 60_000;
    fetcher.mockResolvedValue(new Response("down", { status: 503 }));
    expect((await begin("second@mail.example.com")).statusCode).toBe(502);
    // The earlier claim, whose code did arrive, is still the one pending.
    expect(store.pendingClaim("owner")).toBe("first@mail.example.com");
  } finally {
    await app.close();
    store.close();
  }
});
