import { describe, expect, it } from "vitest";
import { passwordReplacement } from "./password";

describe("editing a password known only to the remote browser", () => {
  it.each([
    ["insert", [2, 2], "**X**", [3, 3], "AbX9!"],
    ["backspace", [2, 2], "***", [1, 1], "A9!"],
    ["delete", [2, 2], "***", [2, 2], "Ab!"],
    ["replace selection", [1, 3], "*x*", [2, 2], "Ax!"],
    ["literal star over a masked character", [1, 2], "****", [2, 2], "A*9!"],
    ["paste over all", [0, 4], "New1!", [5, 5], "New1!"],
  ] as const)(
    "preserves unknown characters on %s",
    (_name, oldSelection, value, selection, expected) => {
      const replacement = passwordReplacement(
        { value: "****", start: oldSelection[0], end: oldSelection[1] },
        { value, start: selection[0], end: selection[1] },
      );
      const secret = "Ab9!";
      expect(
        secret.slice(0, replacement.edit.start) +
          replacement.value +
          secret.slice(replacement.edit.end),
      ).toBe(expected);
    },
  );
});
