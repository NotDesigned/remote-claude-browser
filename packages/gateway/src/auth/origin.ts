/**
 * Is a browser-sent Origin this gateway's own?
 *
 * With MIRROR_PUBLIC_ORIGIN set it must match exactly. Without it (local evaluation; production
 * refuses to start that way) the Origin's host must equal the Host the request was sent to, so a
 * page on another site still cannot drive a signed-in browser through cookies.
 */
export function isOwnOrigin(
  origin: string | undefined,
  host: string | undefined,
  publicOrigin: string | undefined,
): boolean {
  if (origin === undefined || origin === "" || origin === "null") return false;
  const configured = publicOrigin?.replace(/\/+$/, "");
  if (configured) return origin === configured;
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    // Parse Host with the Origin's scheme so an explicit default port compares equal.
    return parsed.host === new URL(`${parsed.protocol}//${host}`).host;
  } catch {
    return false;
  }
}
