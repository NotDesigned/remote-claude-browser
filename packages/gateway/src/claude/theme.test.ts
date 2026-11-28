import { describe, expect, it, vi } from "vitest";
import {
  createClaudeTheme,
  createThemeCopies,
  isClaudeTheme,
  parseStoredTheme,
  READ_THEME_EXPRESSION,
  setThemeExpression,
  themeCopySource,
} from "./theme";
import type { TargetRef } from "../types";

const PAGE = { targetId: "t", sessionId: "s", type: "page" } as TargetRef;
const copies = (send: unknown) => createThemeCopies(send as never);

describe("Claude's theme", () => {
  it("accepts only Claude's three modes", () => {
    expect(["light", "dark", "auto"].every(isClaudeTheme)).toBe(true);
    expect(isClaudeTheme("system")).toBe(false);
  });

  it("reads the mode whatever wraps it", () => {
    expect(parseStoredTheme('"dark"')).toBe("dark");
    expect(parseStoredTheme("light")).toBe("light");
    expect(parseStoredTheme('{"value":"auto"}')).toBe("auto");
    expect(parseStoredTheme(null)).toBeNull();
  });

  it("pushes JSON, tells the running page and uses Claude's name for automatic without literal mirror keys", () => {
    const script = setThemeExpression("auto");
    expect(script).not.toContain("mirror-push");
    expect(script).not.toContain("mirror-chosen");
    expect(script).toContain('key: "LSS-userThemeMode", newValue: "\\"auto\\""');
    expect(script).toContain('dataset.mode = "system"');
    expect(setThemeExpression("dark")).toContain('dataset.mode = "dark"');
    expect(themeCopySource("dark")).not.toContain("mirror");
    expect(READ_THEME_EXPRESSION).not.toContain("mirror");
  });

  it("says whether a Claude page took the setting, so the viewer knows to try again", async () => {
    const value = { current: undefined as unknown };
    const send = vi.fn(async () => ({ result: { value: value.current } }));
    const theme = createClaudeTheme({
      send: send as never,
      pages: () => [PAGE],
      copies: copies(send),
    });
    value.current = false;
    expect(await theme.set("dark", false)).toBe(false);
    value.current = true;
    expect(await theme.set("dark", false)).toBe(true);
    expect(
      await createClaudeTheme({ send: send as never, pages: () => [], copies: copies(send) }).set(
        "dark",
        false,
      ),
    ).toBe(false);
  });

  it("follows the viewer's device, not the server's, for automatic", async () => {
    const send = vi.fn(async () => ({}));
    await createClaudeTheme({ send: send as never, pages: () => [PAGE], copies: copies(send) }).set(
      "auto",
      true,
    );
    expect(send).toHaveBeenCalledWith("s", "Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
  });

  describe("reading back", () => {
    const setup = (seen: { current: unknown }) => {
      const send = vi.fn(
        async (_session: string, method: string, params: { expression?: string }) =>
          method === "Runtime.evaluate" && params.expression === READ_THEME_EXPRESSION
            ? { result: { value: seen.current } }
            : {},
      );
      const theme = createClaudeTheme({
        send: send as never,
        pages: () => [PAGE],
        copies: copies(send),
      });
      const pushes = () =>
        send.mock.calls.filter(([, method, params]) => {
          return method === "Runtime.evaluate" && params.expression !== READ_THEME_EXPRESSION;
        }).length;
      return { send, theme, pushes };
    };

    it("says it does not know until told, as after a restart, whatever the page starts with", async () => {
      const { theme } = setup({ current: ['"auto"', '"auto"', "system"] });
      expect(await theme.read()).toBeNull();
      expect(theme.current()).toBeNull();
    });

    it("takes what a page itself chose", async () => {
      const seen = { current: ['"light"', null, "light"] as unknown[] };
      const { theme } = setup(seen);
      await theme.set("light", false);
      seen.current = ['"dark"', '"dark"', "dark"];
      expect(await theme.read()).toBe("dark");
      expect(theme.current()).toBe("dark");
    });

    it("does not take a page that has merely not caught up, and puts it right", async () => {
      const seen = { current: ['"light"', null, "light"] as unknown[] };
      const { theme, pushes } = setup(seen);
      await theme.set("dark", false);
      const before = pushes();

      expect(await theme.read()).toBe("dark");

      expect(theme.current()).toBe("dark");
      expect(pushes()).toBe(before + 1);
    });

    it("puts right a page that has drifted from the mode it holds", async () => {
      const seen = { current: ['"dark"', null, "light"] as unknown[] };
      const { theme, pushes } = setup(seen);
      await theme.set("dark", false);
      const before = pushes();

      await theme.read();

      expect(pushes()).toBe(before + 1);
    });

    it("leaves a page alone when it matches, including the mode Claude resolves automatic to", async () => {
      const seen = { current: ['"auto"', null, "dark"] as unknown[] };
      const { theme, pushes } = setup(seen);
      await theme.set("auto", true);
      const before = pushes();

      expect(await theme.read()).toBe("auto");

      expect(pushes()).toBe(before);
    });
  });

  describe("each client's own copy", () => {
    /** Runs the copy's source against a fake page, as Chromium would before the page's scripts. */
    function page(theme: "light" | "dark" | "auto", empty = false) {
      const shared = new Map(empty ? [] : [["LSS-userThemeMode", '"light"']]);
      class RealmFunction extends Function {}
      Object.defineProperty(RealmFunction.prototype, "toString", {
        value: Function.prototype.toString,
        writable: true,
        enumerable: false,
        configurable: true,
      });
      class Storage {
        getItem(name: string) {
          return shared.get(name) ?? null;
        }
        setItem(name: string, value: string) {
          shared.set(name, value);
        }
        removeItem(name: string) {
          shared.delete(name);
        }
      }
      const localStorage = new Storage();
      const session = new Storage();
      const doc = { documentElement: { dataset: {} as Record<string, string> } };
      const win = {
        localStorage,
        Function: RealmFunction,
        dispatchEvent: () => true,
      };
      new Function("location", "Storage", "window", themeCopySource(theme))(
        { origin: "https://claude.ai" },
        Storage,
        win,
      );
      const evalInPage = (expr: string) =>
        new Function(
          "location",
          "localStorage",
          "window",
          "document",
          "StorageEvent",
          `return ${expr}`,
        )(
          { origin: "https://claude.ai" },
          localStorage,
          win,
          doc,
          class {
            constructor(_type: string, _init?: unknown) {}
          },
        );
      return { shared, localStorage, session, Storage, evalInPage };
    }

    it("gives the page its own mode, whatever the shared storage holds, and seeds empty storage", () => {
      expect(page("dark").localStorage.getItem("LSS-userThemeMode")).toBe('"dark"');
      const seeded = page("dark", true);
      expect(seeded.shared.get("LSS-userThemeMode")).toBe('"dark"');
    });

    it("keeps a change made in the page out of the shared storage without exposing Storage calls", () => {
      const { shared, localStorage, Storage, evalInPage } = page("dark");
      const observedStorageCalls: string[] = [];
      const origGet = Storage.prototype.getItem;
      const origSet = Storage.prototype.setItem;
      Storage.prototype.getItem = function (k: string) {
        observedStorageCalls.push(`get:${k}`);
        return origGet.apply(this, arguments as never);
      };
      Storage.prototype.setItem = function (k: string, v: string) {
        observedStorageCalls.push(`set:${k}=${v}`);
        return origSet.apply(this, arguments as never);
      };

      localStorage.setItem("LSS-userThemeMode", '"auto"');
      observedStorageCalls.length = 0;

      // Gateway read & push never invoke page-wrapped Storage.prototype methods
      expect(evalInPage(READ_THEME_EXPRESSION)).toEqual(['"auto"', '"auto"', null]);
      expect(shared.get("LSS-userThemeMode")).toBe('"light"');
      expect(evalInPage(setThemeExpression("dark"))).toBe(true);
      expect(evalInPage(READ_THEME_EXPRESSION)).toEqual(['"dark"', null, "dark"]);
      expect(observedStorageCalls).toEqual([]);

      localStorage.removeItem("LSS-userThemeMode");
      expect(shared.get("LSS-userThemeMode")).toBe('"light"');

      // Proxy traps on Function.prototype.toString.call(proxy) must never fire or leak tokens
      expect(
        evalInPage(
          `(() => { const keys = []; try { window.Function.prototype.toString.call(new Proxy({}, { has(_t, k) { keys.push(String(k)); return false; } })); return { threw: false, keys }; } catch (e) { return { threw: e instanceof TypeError, keys }; } })()`,
        ),
      ).toEqual({ threw: true, keys: [] });
    });

    it("leaves every other key and sessionStorage alone", () => {
      const { shared, localStorage, session } = page("dark");
      localStorage.setItem("other", "1");
      expect(shared.get("other")).toBe("1");
      expect(session.getItem("LSS-userThemeMode")).toBe('"light"');
    });

    it("keeps Storage.prototype methods shaped and printed like browser built-ins", () => {
      class RealmFunction extends Function {}
      const nativeTexts = new Map<object, string>();
      Object.defineProperty(RealmFunction.prototype, "toString", {
        value: {
          toString() {
            return nativeTexts.get(this as object) ?? Function.prototype.toString.call(this);
          },
        }.toString,
        writable: true,
        enumerable: false,
        configurable: true,
      });
      nativeTexts.set(RealmFunction.prototype.toString, "function toString() { [native code] }");
      class Storage {
        getItem(_name: string) {
          return null;
        }
        setItem(_name: string, _value: string) {}
        removeItem(_name: string) {}
      }
      nativeTexts.set(Storage.prototype.getItem, "function getItem() { [native code] }");
      nativeTexts.set(Storage.prototype.setItem, "function setItem() { [native code] }");
      nativeTexts.set(Storage.prototype.removeItem, "function removeItem() { [native code] }");
      new Function("location", "Storage", "window", themeCopySource("dark"))(
        { origin: "https://claude.ai" },
        Storage,
        { localStorage: new Storage(), Function: RealmFunction },
      );

      for (const [key, length] of [
        ["getItem", 1],
        ["setItem", 2],
        ["removeItem", 1],
      ] as const) {
        const fn = Storage.prototype[key];
        expect(fn.name).toBe(key);
        expect(fn.length).toBe(length);
        expect("prototype" in fn).toBe(false);
        expect(Reflect.ownKeys(fn)).toEqual(["length", "name"]);
        expect(() => Reflect.construct(Object, [], fn)).toThrow(TypeError);
        expect(RealmFunction.prototype.toString.call(fn)).toBe(
          `function ${key}() { [native code] }`,
        );
      }
      expect(RealmFunction.prototype.toString.call(RealmFunction.prototype.toString)).toBe(
        "function toString() { [native code] }",
      );
    });

    it("does nothing on another site", () => {
      class Storage {}
      const before = Storage.prototype;
      const getItem = before.constructor;
      new Function("location", "Storage", "window", themeCopySource("dark"))(
        { origin: "https://example.com" },
        Storage,
        { localStorage: new Storage() },
      );
      expect(Object.keys(Storage.prototype)).toEqual([]);
      expect(before.constructor).toBe(getItem);
    });

    it("replaces the script when the choice changes, so a reload keeps it", async () => {
      let next = 0;
      const send = vi.fn(async (_session: string, method: string) =>
        method === "Page.addScriptToEvaluateOnNewDocument"
          ? { identifier: `script-${++next}` }
          : {},
      );
      const theme = createClaudeTheme({
        send: send as never,
        pages: () => [PAGE],
        copies: copies(send),
      });
      await theme.set("dark", false);
      await theme.set("light", false);
      expect(send).toHaveBeenCalledWith("s", "Page.removeScriptToEvaluateOnNewDocument", {
        identifier: "script-1",
      });
      expect(send).toHaveBeenLastCalledWith("s", "Runtime.evaluate", expect.anything());
    });

    it("takes a change under Settings in one page to the client's other pages", async () => {
      const other = { targetId: "u", sessionId: "o", type: "page" } as TargetRef;
      const send = vi.fn(
        async (session: string, method: string, params: { expression?: string }) =>
          method === "Runtime.evaluate" && params.expression === READ_THEME_EXPRESSION
            ? {
                result: {
                  value:
                    session === "o" ? ['"dark"', '"dark"', "dark"] : ['"light"', null, "light"],
                },
              }
            : {},
      );
      const theme = createClaudeTheme({
        send: send as never,
        pages: () => [PAGE, other],
        copies: copies(send),
      });
      await theme.set("light", false);
      expect(await theme.read()).toBe("dark");
      expect(theme.current()).toBe("dark");
      expect(send).toHaveBeenCalledWith("s", "Runtime.evaluate", {
        expression: setThemeExpression("dark"),
        returnByValue: true,
        silent: true,
      });
    });
  });
});
