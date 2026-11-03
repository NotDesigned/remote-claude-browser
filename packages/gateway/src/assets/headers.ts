import { validateHeaderName, validateHeaderValue } from "node:http";

/** CDP joins repeated response headers with LF; Node requires separate, valid values. */
export function normalizeAssetHeaders(value: unknown): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = Object.create(null);
  const entries: [unknown, unknown][] = Array.isArray(value)
    ? value.flatMap((item): [unknown, unknown][] =>
        item && typeof item === "object" ? [[item.name, item.value]] : [],
      )
    : value && typeof value === "object"
      ? Object.entries(value)
      : [];

  for (const [rawName, rawValue] of entries) {
    if (typeof rawName !== "string") continue;
    const name = rawName.toLowerCase();
    const values = typeof rawValue === "string" ? [rawValue] : rawValue;
    if (
      !Array.isArray(values) ||
      !values.length ||
      !values.every((part) => typeof part === "string")
    )
      continue;
    const parts: string[] = values.flatMap((part) => part.split("\n"));
    try {
      validateHeaderName(name);
      for (const part of parts) validateHeaderValue(name, part);
    } catch {
      // A bad upstream/cache field must fail independently of the browser session.
      continue;
    }
    const previous = result[name];
    const combined =
      previous === undefined
        ? parts
        : [...(Array.isArray(previous) ? previous : [previous]), ...parts];
    result[name] = combined.length === 1 ? combined[0]! : combined;
  }
  return result;
}
