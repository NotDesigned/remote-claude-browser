// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quietKeyboardCorrections } from "./keys";

class FakeElement {
  readonly nodeType = 1;
  readonly attributes = new Map<string, string>();
  constructor(
    readonly tagName: string,
    type?: string,
  ) {
    if (type !== undefined) this.attributes.set("type", type);
  }
  get type() {
    return this.attributes.get("type") ?? "text";
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
}
beforeEach(() => vi.stubGlobal("Element", FakeElement));
afterEach(() => vi.unstubAllGlobals());

describe("keyboard corrections in mirrored fields", () => {
  it.each([undefined, "email", "password", "tel", "url", "search", "number"])(
    "turns them off in a single-line %s input",
    (type) => {
      const input = new FakeElement("INPUT", type);
      quietKeyboardCorrections(input as unknown as Element);
      expect(Object.fromEntries(input.attributes)).toMatchObject({
        autocapitalize: "off",
        autocorrect: "off",
        spellcheck: "false",
      });
    },
  );

  it("leaves prose fields and other controls alone", () => {
    for (const element of [
      new FakeElement("TEXTAREA"),
      new FakeElement("DIV"),
      new FakeElement("INPUT", "checkbox"),
    ]) {
      quietKeyboardCorrections(element as unknown as Element);
      expect(element.attributes.has("autocapitalize")).toBe(false);
    }
  });
});
