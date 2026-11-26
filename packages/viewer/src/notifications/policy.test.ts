// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  decideSite,
  devicePolicy,
  deviceTag,
  loadNotifySettings,
  notifyStorageKey,
  notifySummary,
  saveNotifySettings,
  siteLabel,
} from "./policy";

const memory = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
};

describe("notification settings", () => {
  it("defaults to on with no sites, and survives bad storage", () => {
    const storage = memory();
    expect(loadNotifySettings(storage, "k")).toEqual({ enabled: true, origins: {} });
    storage.setItem("k", "{not json");
    expect(loadNotifySettings(storage, "k")).toEqual({ enabled: true, origins: {} });
    storage.setItem(
      "k",
      JSON.stringify({
        enabled: false,
        origins: { "https://claude.ai": "granted", "https://x.test/p": "granted", bad: "denied" },
      }),
    );
    expect(loadNotifySettings(storage, "k")).toEqual({
      enabled: false,
      origins: { "https://claude.ai": "granted" },
    });
  });

  it("round-trips per profile", () => {
    const storage = memory();
    const settings = { enabled: true, origins: { "https://claude.ai": "granted" as const } };
    saveNotifySettings(storage, notifyStorageKey("p1"), settings);
    expect(loadNotifySettings(storage, notifyStorageKey("p1"))).toEqual(settings);
    expect(loadNotifySettings(storage, notifyStorageKey("p2")).origins).toEqual({});
  });

  it("reports the device's permission, denied when off, and nothing when unsupported", () => {
    const settings = { enabled: true, origins: { "https://claude.ai": "granted" as const } };
    expect(devicePolicy(settings, "granted")).toEqual({
      state: "granted",
      origins: settings.origins,
    });
    expect(devicePolicy(settings, "default")?.state).toBe("default");
    expect(devicePolicy({ ...settings, enabled: false }, "granted")?.state).toBe("denied");
    expect(devicePolicy(settings, "unsupported")).toBeNull();
  });

  it("keeps the newest site answers", () => {
    let settings = { enabled: true, origins: {} as Record<string, "granted" | "denied"> };
    for (let index = 0; index < 70; index++)
      settings = decideSite(settings, `https://s${index}.test`, "granted");
    settings = decideSite(settings, "https://s10.test", "denied");
    const origins = Object.keys(settings.origins);
    expect(origins).toHaveLength(64);
    expect(origins.at(-1)).toBe("https://s10.test");
    expect(settings.origins["https://s69.test"]).toBe("granted");
    expect(settings.origins["https://s0.test"]).toBeUndefined();
  });

  it("names sites and tags notifications per site", () => {
    expect(siteLabel("https://claude.ai")).toBe("Claude");
    expect(siteLabel("https://www.example.com")).toBe("example.com");
    expect(deviceTag("https://claude.ai", "chat", "g1")).toBe("mirror:https://claude.ai:chat");
    expect(deviceTag("https://claude.ai", undefined, "g1")).toBe("mirror:g1");
  });

  it("summarises the setting for the menu", () => {
    const on = { enabled: true, origins: {} };
    expect(notifySummary(on, "granted").tone).toBe("on");
    expect(notifySummary(on, "denied").tone).toBe("blocked");
    expect(notifySummary({ ...on, enabled: false }, "granted").tone).toBe("off");
    expect(notifySummary(on, "unsupported").text).toContain("主屏幕");
  });
});
