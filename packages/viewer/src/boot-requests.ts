/**
 * Requests index.html starts before the scripts have arrived: on a phone network the picker's
 * profiles and the signed-in user would otherwise wait for the whole bundle to download and run
 * first. Each is handed out once, to the first API call for exactly that path.
 */
declare global {
  interface Window {
    __mirrorBootRequests?: Record<string, Promise<Response> | undefined>;
  }
}

export function takeBootRequest(path: string): Promise<Response> | undefined {
  const requests = typeof window === "undefined" ? undefined : window.__mirrorBootRequests;
  const request = requests?.[path];
  if (request) delete requests[path];
  return request;
}
