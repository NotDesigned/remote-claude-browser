// @vitest-environment node
import { describe, expect, it } from "vitest";
import { togglesLocally } from "./default-actions";

const element = (tagName: string, extra: Record<string, unknown> = {}) =>
  ({ nodeType: 1, tagName, closest: () => null, ...extra }) as unknown as EventTarget;

describe("controls that would toggle in the mirror", () => {
  it("includes checkboxes and radio buttons", () => {
    expect(togglesLocally(element("INPUT", { type: "checkbox" }))).toBe(true);
    expect(togglesLocally(element("INPUT", { type: "RADIO" }))).toBe(true);
  });

  it("includes what is inside a label for one", () => {
    const label = { control: { type: "checkbox" } };
    expect(togglesLocally(element("SPAN", { closest: () => label }))).toBe(true);
  });

  it("leaves other controls and plain text alone", () => {
    expect(togglesLocally(element("INPUT", { type: "text" }))).toBe(false);
    expect(
      togglesLocally(element("SPAN", { closest: () => ({ control: { type: "text" } }) })),
    ).toBe(false);
    expect(togglesLocally(element("DIV"))).toBe(false);
    expect(togglesLocally(null)).toBe(false);
  });
});
