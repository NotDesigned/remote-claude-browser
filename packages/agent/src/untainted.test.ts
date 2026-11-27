// @vitest-environment node
import { describe, expect, it } from "vitest";
import { captureUntainted } from "./untainted";

/** A small DOM-shaped realm: Element extends Node, as in browsers. */
function realm() {
  class Node {
    get childNodes() {
      return "native childNodes";
    }
    contains() {
      return "native contains";
    }
  }
  class Element extends Node {
    get shadowRoot() {
      return "native shadowRoot";
    }
    querySelector() {
      return "native querySelector";
    }
  }
  class ShadowRoot extends Node {
    get host() {
      return "native host";
    }
  }
  class MutationObserver {}
  return { Node, Element, ShadowRoot, MutationObserver };
}

describe("captureUntainted", () => {
  it("keeps the browser's own accessors and methods after a shim replaces them", () => {
    const win = realm();
    const captured = captureUntainted(win);
    // The closed-shadow shim and page scripts come later.
    Object.defineProperty(win.Element.prototype, "shadowRoot", { get: () => "shim" });
    win.Element.prototype.querySelector = () => "page";

    const element = captured.Element!;
    const getter = Object.getOwnPropertyDescriptor(element, "shadowRoot")!.get!;
    expect(getter.call(new win.Element())).toBe("native shadowRoot");
    // A method is kept as a value, as rrweb reads it.
    expect((element as { querySelector: () => string }).querySelector()).toBe(
      "native querySelector",
    );
    // Inherited ones are found on the chain.
    expect(Object.getOwnPropertyDescriptor(element, "shadowRoot")!.get).toBe(getter);
    expect(Object.getOwnPropertyDescriptor(captured.ShadowRoot!, "childNodes")).toBeUndefined();
    expect(
      Object.getOwnPropertyDescriptor(captured.ShadowRoot!, "host")!.get!.call(
        new win.ShadowRoot(),
      ),
    ).toBe("native host");
    expect((captured.Node as { contains: () => string }).contains()).toBe("native contains");
  });

  it("holds plain objects, with nothing a page could reach, and the observer constructor", () => {
    const win = realm();
    const captured = captureUntainted(win);
    for (const key of ["Node", "Element", "ShadowRoot", "MutationObserver"] as const)
      expect(Object.getPrototypeOf(captured[key]!)).toBeNull();
    expect((captured.MutationObserver as { constructor: unknown }).constructor).toBe(
      win.MutationObserver,
    );
  });
});
