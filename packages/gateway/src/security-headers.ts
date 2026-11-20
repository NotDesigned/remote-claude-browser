import type { FastifyInstance, FastifyReply } from "fastify";

export const PAYMENT_HANDOFF_PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), payment=(self), usb=(), serial=(), bluetooth=()";

export const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' blob:",
  ].join("; "),
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy":
    "camera=(), microphone=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (reply.getHeader(name) === undefined) reply.header(name, value);
    }
    return payload;
  });
}

/** Allow payment APIs only on an explicitly controlled local handoff page. */
export function allowPaymentHandoff(reply: FastifyReply): void {
  reply.header("permissions-policy", PAYMENT_HANDOFF_PERMISSIONS_POLICY);
}
