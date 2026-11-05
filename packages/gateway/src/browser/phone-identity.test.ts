import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

import type { TargetRef } from "../types";
import { createPhoneTargetPreparer, isPhoneRequest, PHONE_IDENTITY_SOURCE } from "./phone-identity";

const page: TargetRef = { targetId: "t", sessionId: "s", type: "page" };

describe("phone requests", () => {
  it("takes phones and leaves desktops and tablets on the desktop interface", () => {
    expect(isPhoneRequest("Mozilla/5.0 (Linux; Android 14) Chrome/140 Mobile Safari/537")).toBe(
      true,
    );
    expect(isPhoneRequest("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile/15E148 Safari")).toBe(
      true,
    );
    expect(isPhoneRequest("Mozilla/5.0 (Linux; Android 14; SM-X910) Chrome/140 Safari/537")).toBe(
      false,
    );
    expect(isPhoneRequest("Mozilla/5.0 (Macintosh; Intel Mac OS X) Version/18 Safari/605")).toBe(
      false,
    );
    expect(isPhoneRequest(undefined)).toBe(false);
  });
});

describe("the identity a page sees", () => {
  it("reports a phone with the browser's real version", async () => {
    const context = vm.createContext({});
    vm.runInContext(
      `class Navigator { get userAgent() { return "Mozilla/5.0 (X11; Linux x86_64) Chrome/156.0.8078.79 Safari/537.36"; } }
       var navigator = new Navigator();`,
      context,
    );
    vm.runInContext(PHONE_IDENTITY_SOURCE, context);
    const seen = vm.runInContext(
      `({ ua: navigator.userAgent, mobile: navigator.userAgentData.mobile, platform: navigator.platform })`,
      context,
    ) as { ua: string; mobile: boolean; platform: string };
    expect(seen.ua).toContain("Android 14");
    expect(seen.ua).toContain("Chrome/156.0.0.0 Mobile");
    expect(seen.mobile).toBe(true);
    expect(seen.platform).toBe("Linux armv8l");
  });
});

describe("createPhoneTargetPreparer", () => {
  const setup = (ownerOf: (targetId: string) => string | undefined, phone = true) => {
    const send = vi.fn(async (_session: string, _method: string, _params?: object) => ({}));
    const sleep = vi.fn(async () => {});
    const prepare = createPhoneTargetPreparer({
      send,
      ownerOf,
      isPhoneSession: () => phone,
      sleep,
    });
    return { send, sleep, prepare };
  };
  const methods = (send: { mock: { calls: unknown[][] } }) =>
    send.mock.calls.map(([, method]) => method);

  it("gives a phone's page the identity and touch", async () => {
    const { send, prepare } = setup(() => "client-1");
    await prepare(page);
    expect(methods(send)).toEqual([
      "Page.addScriptToEvaluateOnNewDocument",
      "Emulation.setTouchEmulationEnabled",
    ]);
  });

  it("gives a phone's frame only the identity, as touch belongs to the page", async () => {
    const { send, prepare } = setup(() => "client-1");
    await prepare({ ...page, type: "iframe" });
    expect(methods(send)).toEqual(["Page.addScriptToEvaluateOnNewDocument"]);
  });

  it("leaves a desktop session as it is", async () => {
    const { send, prepare } = setup(() => "client-1", false);
    await prepare(page);
    expect(send).not.toHaveBeenCalled();
  });

  it("waits for a new window's owner to be known", async () => {
    let calls = 0;
    const { send, sleep, prepare } = setup(() => (++calls > 3 ? "client-1" : undefined));
    await prepare(page);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalled();
  });

  it("does not hold a window nobody owns for long", async () => {
    const { send, sleep, prepare } = setup(() => undefined);
    await prepare(page);
    expect(sleep).toHaveBeenCalledTimes(50);
    expect(send).not.toHaveBeenCalled();
  });
});
