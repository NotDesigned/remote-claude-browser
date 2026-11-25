import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { mintInvite } from "./invite";
import { createSessionGuard, SESSION_COOKIE } from "./middleware";

const KEY = Buffer.from("sec-2-middleware-key");
const NOW = 10_000;

describe("SEC-2 device cookie", () => {
  it("authorizes WS requests from the cookie at upgrade time", () => {
    const guard = createSessionGuard({ key: KEY, now: () => NOW });
    const token = mintInvite({ sid: "s1", role: "viewer", exp: NOW + 60 }, KEY);
    const request = (cookie?: string): IncomingMessage =>
      ({ headers: cookie === undefined ? {} : { cookie } }) as IncomingMessage;

    expect(guard.authorizeUpgrade(request())).toBe(false);
    expect(guard.authorizeUpgrade(request(`${SESSION_COOKIE}=garbled`))).toBe(false);
    expect(guard.authorizeUpgrade(request(`${SESSION_COOKIE}=${token}`))).toBe(true);
    expect(guard.session(request(`${SESSION_COOKIE}=${token}`))).toEqual({
      sid: "s1",
      role: "viewer",
      exp: NOW + 60,
    });
  });
});
