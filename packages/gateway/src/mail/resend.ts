import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { compile } from "html-to-text";

const emailText = compile({ wordwrap: false });

export class MailboxError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ReceivedEmail {
  id: string;
  to: string[];
  from: string;
  subject: string;
  receivedAt: number;
}

export function createResendReceiving(
  apiKey: string,
  webhookSecret: string,
  now: () => number,
  fetcher: typeof fetch,
) {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(webhookSecret))
    throw new Error("RESEND_WEBHOOK_SECRET must be a Resend webhook signing secret");
  const signingKey = Buffer.from(webhookSecret.slice(6), "base64");
  if (!signingKey.length) throw new Error("RESEND_WEBHOOK_SECRET is empty");

  return {
    event(body: Buffer, headers: IncomingHttpHeaders): ReceivedEmail | undefined {
      const id = headers["svix-id"];
      const timestamp = headers["svix-timestamp"];
      const signatures = headers["svix-signature"];
      if (
        typeof id !== "string" ||
        typeof timestamp !== "string" ||
        typeof signatures !== "string" ||
        !/^\d+$/.test(timestamp) ||
        Math.abs(Math.floor(now() / 1000) - Number(timestamp)) > 300
      )
        throw new MailboxError(401, "邮件通知签名无效");

      const expected = Buffer.from(
        createHmac("sha256", signingKey)
          .update(`${id}.${timestamp}.`)
          .update(body)
          .digest("base64"),
      );
      const verified = signatures.split(" ").some((entry) => {
        if (!entry.startsWith("v1,")) return false;
        const actual = Buffer.from(entry.slice(3));
        return actual.length === expected.length && timingSafeEqual(actual, expected);
      });
      if (!verified) throw new MailboxError(401, "邮件通知签名无效");

      let event: {
        type?: string;
        data?: {
          email_id?: string;
          to?: unknown[];
          from?: string;
          subject?: string;
          created_at?: string;
        };
      } | null;
      try {
        event = JSON.parse(body.toString("utf8"));
      } catch {
        throw new MailboxError(400, "邮件通知格式无效");
      }
      if (typeof event?.type !== "string") throw new MailboxError(400, "邮件通知格式无效");
      if (event.type !== "email.received") return undefined;
      const data = event.data;
      const receivedAt = Date.parse(data?.created_at ?? "");
      if (
        typeof data?.email_id !== "string" ||
        !data.email_id ||
        !Array.isArray(data.to) ||
        typeof data.from !== "string" ||
        !Number.isFinite(receivedAt)
      )
        throw new MailboxError(400, "邮件通知格式无效");
      // Match provider recipient addresses only. Forwarding and raw message headers are sender data.
      return {
        id: data.email_id,
        to: data.to.flatMap((recipient) =>
          typeof recipient === "string" ? [recipient.trim().toLowerCase()] : [],
        ),
        from: data.from,
        subject: typeof data.subject === "string" ? data.subject : "",
        receivedAt,
      };
    },
    async read(id: string): Promise<{
      text: string;
      html?: string;
      from?: string;
      authenticated: boolean;
    }> {
      try {
        const response = await fetcher(
          `https://api.resend.com/emails/receiving/${encodeURIComponent(id)}?html_format=cid`,
          {
            headers: { Authorization: `Bearer ${apiKey}` },
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!response.ok) throw new Error();
        const body = (await response.json()) as {
          text: string | null;
          html: string | null;
          from?: string;
          authentication?: { dmarc: string } | null;
        };
        const html = body.html ?? undefined;
        return {
          text: body.text?.trim() ? body.text : emailText(html ?? ""),
          html,
          from: body.from,
          authenticated: typeof body.from === "string" && body.authentication?.dmarc === "pass",
        };
      } catch {
        throw new MailboxError(502, "暂时无法读取邮件内容，请重试");
      }
    },
    async send(message: {
      from: string;
      to: string;
      subject: string;
      text: string;
    }): Promise<void> {
      try {
        const response = await fetcher("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ...message, to: [message.to] }),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error();
      } catch {
        throw new MailboxError(502, "暂时无法发送验证码，请稍后重试");
      }
    },
  };
}
