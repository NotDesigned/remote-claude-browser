/** Passwords remain masked in the recording, including after a site's show-password toggle. */
const passwordFields = new WeakSet<Element>();

export function isPasswordField(element: Element): element is HTMLInputElement {
  if (element.tagName.toLowerCase() !== "input") return false;
  const input = element as HTMLInputElement;
  if (input.type === "password" || input.getAttribute("data-rr-is-password") !== null)
    passwordFields.add(input);
  return passwordFields.has(input);
}

export interface PasswordSelection {
  value: string;
  start: number;
  end: number;
}

export function passwordSelection(input: HTMLInputElement): PasswordSelection {
  return { value: input.value, start: input.selectionStart!, end: input.selectionEnd! };
}

/** Use both selections to disambiguate edits among identical masked characters. */
export function passwordReplacement(before: PasswordSelection, after: PasswordSelection) {
  let start = 0;
  const prefixLimit = Math.min(before.start, after.start);
  while (start < prefixLimit && before.value[start] === after.value[start]) start++;
  let suffix = 0;
  const suffixLimit = Math.min(before.value.length - before.end, after.value.length - after.end);
  while (
    suffix < suffixLimit &&
    before.value[before.value.length - suffix - 1] === after.value[after.value.length - suffix - 1]
  )
    suffix++;
  return {
    edit: { start, end: before.value.length - suffix },
    value: after.value.slice(start, after.value.length - suffix),
  };
}
