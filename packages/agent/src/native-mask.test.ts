// @vitest-environment node
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { installNativeMask } from "./native-mask";

/** A realm of its own, so replacing its Function.prototype.toString leaves the tests' alone. */
function realm() {
  const context = createContext({});
  const win = runInContext("globalThis", context) as Window & typeof globalThis;
  const toString = (value: unknown): string =>
    runInContext("(v) => Function.prototype.toString.call(v)", context)(value);
  return { win, toString, run: (code: string) => runInContext(code, context) };
}

/** What a page measures about a function. */
function shape(f: unknown, toString: (value: unknown) => string) {
  const fn = f as { name: string; length: number };
  let constructible = true;
  try {
    Reflect.construct(Object, [], f as () => void);
  } catch {
    constructible = false;
  }
  return {
    keys: Reflect.ownKeys(f as object).map(String),
    name: fn.name,
    length: fn.length,
    text: toString(f),
    prototype: "prototype" in (f as object),
    constructible,
  };
}

describe("native mask", () => {
  it("replaces toString once, with a function that looks like the browser's own", () => {
    const { win, toString } = realm();
    const native = shape(win.Function.prototype.toString, toString);
    const mask = installNativeMask(win);
    expect(installNativeMask(win)).toBe(mask);
    expect(shape(win.Function.prototype.toString, toString)).toEqual(native);
    expect(Object.getOwnPropertyDescriptor(win.Function.prototype, "toString")).toMatchObject({
      writable: true,
      enumerable: false,
      configurable: true,
    });
    // Everything else still prints its own source.
    expect(
      toString(function example(a: number) {
        return a;
      }),
    ).toContain("return a");
    expect(() => toString({})).toThrow(/requires that 'this' be a Function/);
  });

  it("makes methods the way browsers do: printed and measured as the original", () => {
    const { win, toString, run } = realm();
    const push = run("Array.prototype.push") as (...items: unknown[]) => number;
    const before = shape(push, toString);
    const mask = installNativeMask(win);
    const seen: unknown[] = [];
    const fake = mask.method<typeof push>(
      "push",
      function (this: unknown[], ...items: unknown[]) {
        seen.push(this, ...items);
        return push.apply(this, items);
      },
      push,
    );
    expect(shape(fake, toString)).toEqual(before);
    const list: unknown[] = [];
    expect(fake.call(list, 1, 2)).toBe(2);
    expect(seen).toEqual([list, 1, 2]);
    // Without an original: a built-in of that name and arity.
    const named = mask.method("query", () => 1, 1);
    expect(shape(named, toString)).toMatchObject({
      name: "query",
      length: 1,
      text: "function query() { [native code] }",
      prototype: false,
      constructible: false,
    });
  });

  it("replaces an accessor half and keeps the other half and the descriptor's flags", () => {
    const { win, toString, run } = realm();
    const proto = run("Map.prototype") as object;
    const native = Object.getOwnPropertyDescriptor(proto, "size")!;
    const before = shape(native.get, toString);
    const mask = installNativeMask(win);
    mask.accessor(proto, "size", {
      get: function (this: Map<unknown, unknown>) {
        return (native.get as () => number).call(this) + 100;
      },
    });
    const after = Object.getOwnPropertyDescriptor(proto, "size")!;
    expect(after.enumerable).toBe(native.enumerable);
    expect(after.configurable).toBe(native.configurable);
    expect(after.set).toBe(native.set);
    expect(shape(after.get, toString)).toEqual(before);
    expect(run("new Map([[1, 2]]).size")).toBe(101);
    // A setter where the browser has none is named and printed as a setter would be.
    const holder = {};
    Object.defineProperty(holder, "value", { get: () => 1, configurable: true, enumerable: true });
    mask.accessor(holder, "value", { set: () => undefined });
    expect(toString(Object.getOwnPropertyDescriptor(holder, "value")!.set)).toBe(
      "function set value() { [native code] }",
    );
  });

  it("masks rrweb's wrappers and Proxies, and chains to what was registered before", () => {
    const { win, toString, run } = realm();
    const insert = run("Array.prototype.splice") as () => void;
    const mask = installNativeMask(win);
    const proxy = new Proxy(insert, {
      apply: (target, self, args) => Reflect.apply(target, self, args),
    });
    expect(toString(proxy)).toBe("function () { [native code] }");
    mask.mask(proxy, insert);
    expect(toString(proxy)).toBe("function splice() { [native code] }");
    // A wrapper of a wrapper prints as the browser's function, not as the first wrapper's source.
    const first = mask.method("splice", () => undefined, insert);
    const second = function wrapped() {
      return 1;
    };
    mask.mask(second, first);
    expect(shape(second, toString)).toMatchObject({
      name: "splice",
      length: 2,
      text: "function splice() { [native code] }",
    });
    expect(mask.asNativeNamed(() => 1, "Notification", 1)).toHaveProperty("name", "Notification");
  });
});
