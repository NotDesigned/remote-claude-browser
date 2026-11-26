import { describe, expect, it } from "vitest";
import {
  effectiveNotifyPermission,
  mergedNotifyPermission,
  notifyOrigin,
  readNotifyPolicy,
} from "./notify";
import { decodeDown, decodeUp, encodeMsg, type Down, type Up } from "./wire";

describe("notification permission", () => {
  it("is default until a viewer reports", () => {
    expect(effectiveNotifyPermission(null, "https://claude.ai")).toBe("default");
  });

  it("follows the site's answer only while the device can show notifications", () => {
    const origins = { "https://claude.ai": "granted", "https://x.test": "denied" } as const;
    expect(effectiveNotifyPermission({ state: "granted", origins }, "https://claude.ai")).toBe(
      "granted",
    );
    expect(effectiveNotifyPermission({ state: "default", origins }, "https://claude.ai")).toBe(
      "default",
    );
    expect(effectiveNotifyPermission({ state: "denied", origins }, "https://claude.ai")).toBe(
      "denied",
    );
    expect(effectiveNotifyPermission({ state: "granted", origins }, "https://x.test")).toBe(
      "denied",
    );
    expect(effectiveNotifyPermission({ state: "granted", origins }, "https://new.test")).toBe(
      "default",
    );
  });

  it("reads only well-formed policies", () => {
    expect(readNotifyPolicy(null)).toBeNull();
    expect(readNotifyPolicy({ state: "maybe", origins: {} })).toBeNull();
    expect(
      readNotifyPolicy({
        state: "granted",
        origins: {
          "https://claude.ai": "granted",
          "https://claude.ai/path": "granted",
          "javascript:alert(1)": "granted",
          "https://x.test": "sure",
        },
      }),
    ).toEqual({ state: "granted", origins: { "https://claude.ai": "granted" } });
    const many = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`https://s${index}.test`, "denied"]),
    );
    expect(Object.keys(readNotifyPolicy({ state: "denied", origins: many })!.origins)).toHaveLength(
      64,
    );
  });

  it("names origins of web pages only", () => {
    expect(notifyOrigin("https://claude.ai/new?x=1")).toBe("https://claude.ai");
    expect(notifyOrigin("http://localhost:8080/")).toBe("http://localhost:8080");
    expect(notifyOrigin("data:text/html,x")).toBeNull();
    expect(notifyOrigin(42)).toBeNull();
  });
});

describe("notification messages", () => {
  it("round-trip both ways", () => {
    const down: Down[] = [
      {
        t: "notify",
        id: "n1",
        tab: "T1",
        origin: "https://claude.ai",
        title: "Claude",
        body: "Done",
        tag: "chat",
        silent: false,
      },
      { t: "notify-close", id: "n1" },
      { t: "notify-ask", id: "a1", tab: "T1", origin: "https://claude.ai" },
      { t: "notify-ask-end", id: "a1" },
    ];
    for (const message of down) expect(decodeDown(encodeMsg(message))).toEqual(message);
    const up: Up[] = [
      { t: "notify-permission", state: "granted", origins: { "https://claude.ai": "granted" } },
      { t: "notify-event", id: "n1", type: "click" },
      { t: "notify-answer", id: "a1", state: "denied" },
    ];
    for (const message of up) expect(decodeUp(encodeMsg(message))).toEqual(message);
  });
});

describe("several devices", () => {
  it("grant when any device can show, deny only when all refuse", () => {
    const granted = { state: "granted", origins: { "https://claude.ai": "granted" } } as const;
    const phone = { state: "default", origins: {} } as const;
    const off = { state: "denied", origins: {} } as const;
    expect(mergedNotifyPermission([], "https://claude.ai")).toBe("default");
    expect(mergedNotifyPermission([phone, granted], "https://claude.ai")).toBe("granted");
    expect(mergedNotifyPermission([phone, off], "https://claude.ai")).toBe("default");
    expect(mergedNotifyPermission([off, off], "https://claude.ai")).toBe("denied");
  });
});
