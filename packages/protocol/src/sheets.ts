import { EventType, type eventWithTime } from "./rrweb";

/**
 * Large stylesheets make up over 90% of a full snapshot but rarely change, so they travel once per
 * connection in a `css` message and snapshots refer to them by content hash.
 */
export const SHEET_REF_ATTRIBUTE = "_cssRef";
export const SHEET_TEXT_ATTRIBUTE = "_cssText";
export const SHEET_REF_TEXT = "cssRef";
export const MAX_KNOWN_SHEETS = 16;
export const SHEET_HASH = /^[0-9a-f]{16}$/;

interface SheetNode {
  attributes?: Record<string, unknown>;
  childNodes?: SheetNode[];
  [key: string]: unknown;
}

/**
 * Returns the node with each sheet reference replaced by its text, sharing unchanged subtrees, or
 * null when a referenced sheet is unknown.
 */
function resolveNode<T>(root: T, lookup: (hash: string) => string | undefined): T | null {
  let missing = false;
  const text = (hash: unknown): string => {
    const value = typeof hash === "string" ? lookup(hash) : undefined;
    if (value === undefined) missing = true;
    return value ?? "";
  };
  const visit = (node: SheetNode): SheetNode => {
    let result = node;
    if (node.attributes && SHEET_REF_ATTRIBUTE in node.attributes) {
      const { [SHEET_REF_ATTRIBUTE]: hash, ...attributes } = node.attributes;
      result = { ...result, attributes: { ...attributes, [SHEET_TEXT_ATTRIBUTE]: text(hash) } };
    }
    if (SHEET_REF_TEXT in node) {
      const { [SHEET_REF_TEXT]: hash, ...rest } = result;
      result = { ...rest, textContent: text(hash) };
    }
    if (node.childNodes) {
      const children = node.childNodes.map(visit);
      if (children.some((child, index) => child !== node.childNodes![index]))
        result = { ...result, childNodes: children };
    }
    return result;
  };
  const resolved = visit(root as SheetNode) as T;
  return missing ? null : resolved;
}

/** Restores the stylesheets of a snapshot message's events; null when one is not known. */
export function resolveSheetRefs(
  events: eventWithTime[],
  lookup: (hash: string) => string | undefined,
): eventWithTime[] | null {
  const resolved: eventWithTime[] = [];
  for (const event of events) {
    if (event.type !== EventType.FullSnapshot) {
      resolved.push(event);
      continue;
    }
    const node = resolveNode(event.data.node, lookup);
    if (node === null) return null;
    resolved.push(
      node === event.data.node
        ? event
        : ({ ...event, data: { ...event.data, node } } as eventWithTime),
    );
  }
  return resolved;
}
