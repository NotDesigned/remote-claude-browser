/**
 * One mask for every function the agent (and rrweb) puts in place of a browser built-in.
 *
 * A page can tell a replacement from the browser's own function by how it prints, by its name and
 * length, by whether it has a `prototype` or can be constructed, and by how its property is
 * described. This makes each replacement match the function it replaces on all of those, in its own
 * realm: `Function.prototype.toString` is replaced once, by a function that is itself masked, and
 * reads the text from a WeakMap holding what the browser printed for the original.
 *
 * What it cannot hide is tracked in the stealth baseline (packages/gateway/src/browser): another
 * realm's toString, stack frames, and the wrapper's realm.
 */

type AnyFunction = (...args: never[]) => unknown;

export interface NativeMask {
  /** `fake` prints as `original` does and has its name and length. Returns `fake`. */
  asNative<T extends object>(fake: T, original: object): T;
  /** `fake` prints as a built-in called `name`, with that name and length. Returns `fake`. */
  asNativeNamed<T extends object>(fake: T, name: string, length: number): T;
  /**
   * A method that calls `impl` with the same `this` and arguments, made the way browsers make
   * methods: no `prototype`, not constructible, printed and measured as `original` (or as a
   * built-in called `name` with `length` arguments when there is no original).
   */
  method<T extends AnyFunction>(
    name: string,
    impl: (this: never, ...args: never[]) => unknown,
    original?: object | number,
  ): T;
  /**
   * Replaces the getter and/or setter of `proto[key]` with ones calling `get`/`set`, keeping the
   * native descriptor's flags and whichever half is not replaced.
   */
  accessor(
    proto: object,
    key: string,
    parts: { get?: (this: never) => unknown; set?: (this: never, value: never) => void },
  ): void;
  /**
   * rrweb's hook: `wrapper` stands in for `original`. `target` is the realm rrweb installed it in
   * when that is another one (a same-origin frame it records from above): that realm's own
   * toString must print it as native too, so it gets a mask of its own.
   */
  mask(wrapper: object, original: object, target?: Window): void;
}

const masks = new WeakMap<object, NativeMask>();

/** Idempotent per realm. Must run before any page script. */
export function installNativeMask(win: Window): NativeMask {
  const existing = masks.get(win);
  if (existing !== undefined) return existing;
  const realm = win as Window & typeof globalThis;
  const FunctionPrototype = realm.Function.prototype;
  const nativeToString = FunctionPrototype.toString;
  // Captured now: a page may replace any of these later, and would see every call through them.
  const apply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const weakGet = WeakMap.prototype.get;
  const weakSet = WeakMap.prototype.set;
  const texts = new WeakMap<object, string>();
  const textOf = (value: object): string | undefined => apply(weakGet, texts, [value]);
  const remember = (value: object, text: string): void => {
    apply(weakSet, texts, [value, text]);
  };
  /** What the browser prints for `original`, or what was registered for it. */
  const printed = (original: object): string =>
    textOf(original) ?? (apply(nativeToString, original, []) as string);
  const setNameAndLength = (fake: object, name: unknown, length: unknown): void => {
    // A native function's own `length` and `name` are non-writable, non-enumerable, configurable.
    try {
      defineProperty(fake, "length", { value: length, configurable: true });
      defineProperty(fake, "name", { value: name, configurable: true });
    } catch {
      // A frozen function keeps what it has.
    }
  };

  const mask: NativeMask = {
    asNative(fake, original) {
      const text = printed(original);
      const source = original as { name?: unknown; length?: unknown };
      if (
        (fake as { name?: unknown }).name !== source.name ||
        (fake as { length?: unknown }).length !== source.length
      )
        setNameAndLength(fake, source.name, source.length);
      remember(fake, text);
      return fake;
    },
    asNativeNamed(fake, name, length) {
      setNameAndLength(fake, name, length);
      remember(fake, `function ${name}() { [native code] }`);
      return fake;
    },
    method<T extends AnyFunction>(
      name: string,
      impl: (this: never, ...args: never[]) => unknown,
      original?: object | number,
    ): T {
      const holder = {
        [name](this: unknown, ...args: unknown[]): unknown {
          return apply(impl as AnyFunction, this, args);
        },
      };
      const fake = holder[name] as unknown as T;
      if (typeof original === "object" || typeof original === "function")
        return mask.asNative(fake, original);
      return mask.asNativeNamed(fake, name, original ?? 0);
    },
    accessor(proto, key, parts) {
      const native = getOwnPropertyDescriptor(proto, key);
      const get = parts.get;
      const set = parts.set;
      const holder = {
        get [key](): unknown {
          return apply(get as AnyFunction, this, []);
        },
        set [key](value: unknown) {
          apply(set as AnyFunction, this, [value]);
        },
      };
      const made = getOwnPropertyDescriptor(holder, key)!;
      const named = (fake: object, original: unknown, prefix: string): object =>
        typeof original === "function"
          ? mask.asNative(fake, original)
          : mask.asNativeNamed(fake, `${prefix} ${key}`, prefix === "get" ? 0 : 1);
      defineProperty(proto, key, {
        get:
          get === undefined ? native?.get : (named(made.get!, native?.get, "get") as () => unknown),
        set:
          set === undefined
            ? native?.set
            : (named(made.set!, native?.set, "set") as (value: unknown) => void),
        enumerable: native?.enumerable ?? true,
        configurable: native?.configurable ?? true,
      });
    },
    mask(wrapper, original, target) {
      mask.asNative(wrapper, original);
      if (target === undefined || target === win) return;
      let other: NativeMask | undefined;
      try {
        other = installNativeMask(target);
      } catch {
        // A realm this one cannot reach has nothing of ours in it.
      }
      other?.asNative(wrapper, original);
    },
  };

  const lookup = function (this: unknown): string {
    if ((typeof this === "function" || typeof this === "object") && this !== null) {
      const text = textOf(this);
      if (text !== undefined) return text;
    }
    return apply(nativeToString, this, []) as string;
  };
  // Another realm's (a same-origin frame's) toString is a Proxy of the one it has: a function made
  // here would carry this realm's Function.prototype, and the Proxy keeps that realm's own name,
  // length and prototype. What it wraps may be that frame's agent's mask, which still answers.
  const foreign = realm.Function !== Function;
  const toString = foreign
    ? new Proxy(nativeToString, {
        apply: (_target, thisArg: unknown) => apply(lookup, thisArg, []) as string,
      })
    : mask.method<() => string>("toString", lookup as (this: never) => unknown, nativeToString);
  if (foreign) remember(toString, printed(nativeToString));
  const descriptor = getOwnPropertyDescriptor(FunctionPrototype, "toString");
  defineProperty(FunctionPrototype, "toString", {
    value: toString,
    writable: descriptor?.writable ?? true,
    enumerable: descriptor?.enumerable ?? false,
    configurable: descriptor?.configurable ?? true,
  });
  masks.set(win, mask);
  return mask;
}
