/**
 * Applies rrweb's inline-style diff to a `style` attribute string, the way the replay's
 * `element.style.setProperty` / `removeProperty` would leave it.
 *
 * rrweb records a style change as a diff of longhand properties when that is shorter than the new
 * attribute (record.js, MutationBuffer: `styleDiff`): a value sets a property, `[value, priority]`
 * sets it with a priority, and `false` removes it. The gateway has no CSS engine, so it keeps the
 * attribute as a list of declarations: a set property moves to the end, where it wins over any
 * shorthand before it, and a removal deletes the property's own declaration.
 *
 * A removed longhand that only a shorthand still sets (`margin: 0` with `margin-top` removed)
 * cannot be rewritten without expanding the shorthand. Then the shorthand itself is dropped and
 * the result is `uncertain`: the tree must never keep a value the page no longer has, and the
 * caller counts it (VERIFY compares the tree with the page and reports it).
 */

export type StyleDiff = Record<string, string | false | [string, string] | unknown>;

export interface Declaration {
  /** Lower-cased, except custom properties, which are case-sensitive. */
  name: string;
  value: string;
  important: boolean;
}

/** Splits a declaration block, respecting quotes, parentheses (url(data:...;...)) and escapes. */
export function parseDeclarations(text: string): Declaration[] {
  const declarations: Declaration[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  const flush = (end: number) => {
    const part = text.slice(start, end);
    start = end + 1;
    const colon = findColon(part);
    if (colon < 0) return;
    const rawName = part.slice(0, colon).trim();
    if (rawName === "") return;
    let value = part.slice(colon + 1).trim();
    let important = false;
    const bang = /!\s*important\s*$/i.exec(value);
    if (bang !== null) {
      important = true;
      value = value.slice(0, bang.index).trim();
    }
    const name = rawName.startsWith("--") ? rawName : rawName.toLowerCase();
    declarations.push({ name, value, important });
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\") {
      index++;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) flush(index);
  }
  flush(text.length);
  return declarations;
}

function findColon(part: string): number {
  let quote: string | null = null;
  for (let index = 0; index < part.length; index++) {
    const char = part[index]!;
    if (char === "\\") {
      index++;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ":") return index;
  }
  return -1;
}

export function serializeDeclarations(declarations: readonly Declaration[]): string {
  return declarations
    .map(({ name, value, important }) => `${name}: ${value}${important ? " !important" : ""};`)
    .join(" ");
}

/** Shorthands whose name is not a prefix of all their longhands. */
const EXTRA_SHORTHANDS: Record<string, readonly string[]> = {
  inset: ["top", "right", "bottom", "left"],
  "border-color": [
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
  ],
  "border-style": [
    "border-top-style",
    "border-right-style",
    "border-bottom-style",
    "border-left-style",
  ],
  "border-width": [
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
  ],
  gap: ["row-gap", "column-gap"],
  "grid-gap": ["grid-row-gap", "grid-column-gap", "row-gap", "column-gap"],
  "place-items": ["align-items", "justify-items"],
  "place-content": ["align-content", "justify-content"],
  "place-self": ["align-self", "justify-self"],
  font: [
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "font-variant",
    "font-stretch",
    "line-height",
  ],
  "flex-flow": ["flex-direction", "flex-wrap"],
  "grid-area": ["grid-row-start", "grid-row-end", "grid-column-start", "grid-column-end"],
  "border-block": ["border-block-start-color", "border-block-end-color"],
  "text-decoration": ["text-decoration-line", "text-decoration-color", "text-decoration-style"],
};

/** Whether `shorthand` (as written in a declaration) sets `longhand`. */
export function covers(shorthand: string, longhand: string): boolean {
  if (shorthand === longhand || shorthand.startsWith("--")) return false;
  if (longhand.startsWith(`${shorthand}-`)) return true;
  const extra = EXTRA_SHORTHANDS[shorthand];
  if (extra?.includes(longhand)) return true;
  // border-top covers border-top-color; border covers every border longhand.
  if (shorthand === "border" && longhand.startsWith("border-")) return true;
  return false;
}

export interface StyleResult {
  value: string;
  /** A removed longhand was only set through a shorthand, which was dropped. */
  uncertain: boolean;
}

export function applyStyleDiff(current: string, diff: StyleDiff): StyleResult {
  let declarations = parseDeclarations(current);
  let uncertain = false;
  for (const [rawName, change] of Object.entries(diff)) {
    const name = rawName.startsWith("--") ? rawName : rawName.toLowerCase();
    if (change === false) {
      declarations = declarations.filter((declaration) => declaration.name !== name);
      const shorthands = declarations.filter((declaration) => covers(declaration.name, name));
      if (shorthands.length > 0) {
        uncertain = true;
        declarations = declarations.filter((declaration) => !covers(declaration.name, name));
      }
      continue;
    }
    let value: string;
    let important = false;
    if (Array.isArray(change)) {
      value = String(change[0] ?? "");
      important = String(change[1] ?? "").toLowerCase() === "important";
    } else if (typeof change === "string") value = change;
    else continue;
    declarations = declarations.filter((declaration) => declaration.name !== name);
    // An empty value removes the property, as setProperty does.
    if (value.trim() === "") continue;
    declarations.push({ name, value, important });
  }
  return { value: serializeDeclarations(declarations), uncertain };
}

/** A declaration block as a comparable map (last one wins, as in CSS). */
export function declarationMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const { name, value, important } of parseDeclarations(text))
    map.set(name, `${value.replace(/\s+/g, " ")}${important ? "!important" : ""}`);
  return map;
}
