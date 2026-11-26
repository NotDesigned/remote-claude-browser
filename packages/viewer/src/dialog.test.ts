// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreFocus } from "./dialog";

class FakeElement {
  focused = 0;
  constructor(public isConnected = true) {}
  focus() {
    this.focused++;
  }
}

describe("restoreFocus", () => {
  afterEach(() => vi.unstubAllGlobals());

  function page() {
    const body = new FakeElement();
    const documentElement = new FakeElement();
    const trigger = new FakeElement();
    vi.stubGlobal("HTMLElement", FakeElement);
    vi.stubGlobal("document", {
      body,
      documentElement,
      querySelector: (selector: string) =>
        selector.includes("#shell-menu-toggle") ? trigger : null,
    });
    return { body, documentElement, trigger };
  }

  it("returns focus to the control that opened the dialog", () => {
    const { trigger } = page();
    const opener = new FakeElement();
    restoreFocus(opener as unknown as Element);
    expect(opener.focused).toBe(1);
    expect(trigger.focused).toBe(0);
  });

  it("falls back to the ⋯ trigger when the opener was removed or focus had fallen to the page", () => {
    const { body, documentElement, trigger } = page();
    // A ⋯ menu item opens a panel and closes its menu: focus was on body when the panel opened.
    restoreFocus(body as unknown as Element);
    restoreFocus(documentElement as unknown as Element);
    restoreFocus(new FakeElement(false) as unknown as Element);
    restoreFocus(null);
    expect(body.focused).toBe(0);
    expect(trigger.focused).toBe(4);
  });
});
