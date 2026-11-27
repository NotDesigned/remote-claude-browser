/**
 * The DOM accessors rrweb reads through, captured before anything replaces them.
 *
 * rrweb 2.1.1 wants "untainted" Node, ShadowRoot, Element and MutationObserver prototypes. It
 * judges the page's own by whether each accessor prints as native, and Element's list includes
 * querySelector, which has no getter, so in Chrome the test always fails and rrweb appends a hidden
 * iframe to the page to borrow that frame's prototypes: a node the page can see. With hardening the
 * patched rrweb makes no frame and reads from these objects instead: plain objects holding the
 * browser's own descriptors, taken at agent start, before the closed-shadow shim or any page script.
 */

/** rrweb's testableAccessors and testableMethods (record.js), which are what it reads. */
const NAMES = {
  Node: [
    "childNodes",
    "parentNode",
    "parentElement",
    "textContent",
    "ownerDocument",
    "contains",
    "getRootNode",
  ],
  ShadowRoot: ["host", "styleSheets", "getSelection"],
  Element: ["shadowRoot", "querySelector", "querySelectorAll"],
} as const;

export type UntaintedKey = keyof typeof NAMES | "MutationObserver";
export type UntaintedPrototypes = Partial<Record<UntaintedKey, object>>;

interface RealmLike {
  Node?: { prototype: object };
  ShadowRoot?: { prototype: object };
  Element?: { prototype: object };
  MutationObserver?: unknown;
}

/** The descriptor of `name` where the prototype chain from `proto` first has it. */
function findDescriptor(proto: object | null, name: string): PropertyDescriptor | undefined {
  for (let current = proto; current !== null; current = Object.getPrototypeOf(current) as object) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) return descriptor;
  }
  return undefined;
}

/** Must run before the closed-shadow shim and before any page script. */
export function captureUntainted(realm: RealmLike): UntaintedPrototypes {
  const captured: UntaintedPrototypes = {};
  for (const key of Object.keys(NAMES) as Array<keyof typeof NAMES>) {
    const proto = realm[key]?.prototype;
    if (proto === undefined) continue;
    const copy = Object.create(null) as object;
    for (const name of NAMES[key]) {
      const descriptor = findDescriptor(proto, name);
      if (descriptor !== undefined) Object.defineProperty(copy, name, descriptor);
    }
    captured[key] = copy;
  }
  if (typeof realm.MutationObserver === "function") {
    const copy = Object.create(null) as object;
    Object.defineProperty(copy, "constructor", { value: realm.MutationObserver });
    captured.MutationObserver = copy;
  }
  return captured;
}
