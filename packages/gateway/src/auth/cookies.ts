import type { IncomingMessage } from "node:http";

/**
 * The value of the first cookie called `name` in a Cookie header, trimmed; "" when it is present
 * but empty. The only cookie parser the gateway uses.
 */
export function readCookie(
  source: IncomingMessage | string | undefined,
  name: string,
): string | undefined {
  const header = typeof source === "object" ? source.headers.cookie : source;
  for (const part of header?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index >= 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
