import { describe, expect, it, vi } from "vitest";

import type { TargetRef } from "../types";
import { createPhoneTargetPreparer, isPhoneRequest } from "./phone-identity";

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

  it("sets the initial screen and touch without overriding browser identity", async () => {
    const { send, prepare } = setup(() => "client-1");
    await prepare(page);
    expect(methods(send)).toEqual([
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
    ]);
  });

  it("leaves child frame identity untouched", async () => {
    const { send, prepare } = setup(() => "client-1");
    await prepare({ ...page, type: "iframe" });
    expect(methods(send)).toEqual([]);
  });

  it("sets a desktop screen before navigation without identity scripts", async () => {
    const { send, prepare } = setup(() => "client-1", false);
    await prepare(page);
    expect(methods(send)).toEqual(["Emulation.setDeviceMetricsOverride"]);
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
