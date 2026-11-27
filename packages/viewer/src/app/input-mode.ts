/** Which way a tab types in page mode: single-writer input or the legacy way. */
const INPUT_MODE_KEY = "mirror.input-mode";

/**
 * `?input=legacy` (kept for the tab's session): this tab types the legacy way even where the
 * gateway offers single-writer input; `?input=proxy` drops that again. Single-writer input itself
 * is on only where the gateway offers it (`proxyin1`): no override turns it on, so a tab that once
 * asked for it does not stay in it after the gateway turned it off.
 */
export function inputModeOverride(
  search: string,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null,
): "legacy" | null {
  const asked = new URLSearchParams(search).get("input");
  try {
    if (asked === "legacy") storage?.setItem(INPUT_MODE_KEY, "legacy");
    else if (asked === "proxy") storage?.removeItem(INPUT_MODE_KEY);
    const stored = storage?.getItem(INPUT_MODE_KEY) ?? null;
    // Earlier builds also kept "proxy", which forced single-writer input on.
    if (stored !== null && stored !== "legacy") storage?.removeItem(INPUT_MODE_KEY);
    return asked === "legacy" || stored === "legacy" ? "legacy" : null;
  } catch {
    // No storage: the address alone decides.
    return asked === "legacy" ? "legacy" : null;
  }
}
