import { describe, expect, it, vi } from "vitest";
import {
  createClaudeTheme,
  isClaudeTheme,
  parseStoredTheme,
  READ_THEME_EXPRESSION,
  setThemeExpression,
} from "./theme";
import type { TargetRef } from "../types";

const PAGE = { targetId: "t", sessionId: "s", type: "page" } as TargetRef;

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

  it("writes JSON, tells the running page and uses Claude's name for automatic", () => {
    const script = setThemeExpression("auto");
    expect(script).toContain('"LSS-userThemeMode", "\\"auto\\""');
    expect(script).toContain('dataset.mode = "system"');
    expect(setThemeExpression("dark")).toContain('dataset.mode = "dark"');
  });

  it("follows the viewer's device, not the server's, for automatic", async () => {
    const send = vi.fn(async () => ({}));
    await createClaudeTheme({ send: send as never, pages: () => [PAGE] }).set("auto", true);
    expect(send).toHaveBeenCalledWith("s", "Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
  });

  it("gives a Claude page without a setting the viewer's choice, instead of adopting its default", async () => {
    const value = { current: undefined as unknown };
    const send = vi.fn(async (_session: string, method: string, params: { expression?: string }) =>
      method === "Runtime.evaluate" && params.expression === READ_THEME_EXPRESSION
        ? { result: { value: value.current } }
        : {},
    );
    const theme = createClaudeTheme({ send: send as never, pages: () => [PAGE] });
    expect(await theme.read()).toBeNull();
    value.current = null;
    expect(await theme.read()).toBeNull();
    await theme.set("light", false);
    expect(await theme.read()).toBe("light");
    value.current = '"dark"';
    expect(await theme.read()).toBe("dark");
  });
});
