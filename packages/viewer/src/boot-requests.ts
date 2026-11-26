/**
 * Requests index.html starts before the scripts have arrived: on a phone network the picker's
 * profiles, the signed-in user and a reloaded tab's session would otherwise wait for the whole
 * bundle to download and run first. Each is handed out once, to the first API call with exactly
 * its method, path and body.
 */
declare global {
  interface Window {
    __mirrorBootRequests?: Record<string, Promise<Response> | undefined>;
  }
}

/** How index.html names a request: "GET /api/me", or "POST <path> <JSON body>". */
export function bootRequestKey(method: string, path: string, body = ""): string {
  return `${method.toUpperCase()} ${path}${body ? ` ${body}` : ""}`;
}

export function takeBootRequest(
  method: string,
  path: string,
  body = "",
): Promise<Response> | undefined {
  const requests = typeof window === "undefined" ? undefined : window.__mirrorBootRequests;
  const key = bootRequestKey(method, path, body);
  const request = requests?.[key];
  if (request) delete requests[key];
  return request;
}
