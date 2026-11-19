import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { createMailboxService, registerMailboxRoutes, RESEND_WEBHOOK_PATH } from "./mailboxes";

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

function event(to: string[], receivedFor: string[] = []) {
  return JSON.stringify(
    {
      type: "email.received",
      data: {
        email_id: "test-email",
        to,
        from: "sender@example.com",
        subject: "Verify your email",
        created_at: new Date(now).toISOString(),
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
  const store = await createMailboxService({ file: ":memory:", ...provider, fetcher });
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
    const second = store.createAddress("owner");
    const third = store.createAddress("other");
    expect(first.label).toBe("我的账号");
    expect(first.address).toMatch(/^mail-[0-9a-f]{32}@mail\.example\.com$/);
    expect(first.address).not.toBe(second.address);
    expect((await app.inject({ url: mailboxPath, headers: owner })).json()).toEqual({
      enabled: true,
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
      message: { ...summary, text: "Code: 123456 Verify [https://example.com/verify]" },
    });
    expect(await store.readMessage("owner", first.id, "test-email")).toMatchObject({
      authenticated: true,
    });
    fetcher.mockResolvedValueOnce(
      Response.json({
        from: "sender@example.com",
        text: "Unverified email",
        headers: { "authentication-results": "dmarc=pass" },
      }),
    );
    expect(await store.readMessage("owner", first.id, "test-email")).toMatchObject({
      authenticated: false,
    });
  } finally {
    await app.close();
    store.close();
  }
});

it("deletes addresses and their messages while Resend is disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mirror-mailbox-"));
  const file = join(dir, "mail.sqlite");
  try {
    const enabled = await createMailboxService({ file, ...provider });
    const address = enabled.createAddress("owner");
    const payload = event([address.address]);
    enabled.receive(Buffer.from(payload), signed(payload));
    enabled.close();

    const disabled = await createMailboxService({ file });
    const app = Fastify();
    registerMailboxRoutes(app, disabled, () => "owner");
    try {
      expect((await app.inject({ url: mailboxPath })).json()).toEqual({
        enabled: false,
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
