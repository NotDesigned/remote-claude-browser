import { createHash } from "node:crypto";
import {
  EventType,
  SHEET_REF_ATTRIBUTE,
  SHEET_REF_TEXT,
  SHEET_TEXT_ATTRIBUTE,
  encodeMsg,
  resolveSheetRefs,
  type Down,
  type eventWithTime,
} from "@mirror/protocol";

const MIN_EXTERNAL_SHEET_LENGTH = 16 * 1024;

type SnapshotDown = Extract<Down, { t: "snapshot" }>;
interface SheetNode {
  attributes?: Record<string, unknown>;
  childNodes?: SheetNode[];
  textContent?: unknown;
  [key: string]: unknown;
}

const sheetsByEvent = new WeakMap<object, Map<string, string>>();

/** Moves large stylesheets out of a FullSnapshot, leaving content-hash references behind. */
export function externalizeSheets(event: eventWithTime): eventWithTime {
  if (event.type !== EventType.FullSnapshot) return event;
  const sheets = new Map<string, string>();
  const hashOf = (text: string) => {
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    sheets.set(hash, text);
    return hash;
  };
  const large = (value: unknown): value is string =>
    typeof value === "string" && value.length >= MIN_EXTERNAL_SHEET_LENGTH;
  const visit = (node: SheetNode): SheetNode => {
    let result = node;
    const css = node.attributes?.[SHEET_TEXT_ATTRIBUTE];
    if (large(css)) {
      const { [SHEET_TEXT_ATTRIBUTE]: _moved, ...attributes } = node.attributes!;
      result = { ...result, attributes: { ...attributes, [SHEET_REF_ATTRIBUTE]: hashOf(css) } };
    }
    if (node.isStyle === true && large(node.textContent)) {
      const { textContent, ...rest } = result;
      result = { ...rest, [SHEET_REF_TEXT]: hashOf(textContent as string) };
    }
    if (node.childNodes) {
      const children = node.childNodes.map(visit);
      if (children.some((child, index) => child !== node.childNodes![index]))
        result = { ...result, childNodes: children };
    }
    return result;
  };
  const node = visit(event.data.node as unknown as SheetNode);
  if (sheets.size === 0) return event;
  const external = { ...event, data: { ...event.data, node } } as eventWithTime;
  sheetsByEvent.set(external, sheets);
  return external;
}

/** The stylesheets a snapshot message refers to, by content hash. */
export function sheetsOf(message: SnapshotDown): Map<string, string> | undefined {
  for (const event of message.data) {
    const sheets = sheetsByEvent.get(event);
    if (sheets) return sheets;
  }
  return undefined;
}

/** The whole snapshot for a client that did not offer to receive stylesheets separately. */
export function encodeWithInlineSheets(message: SnapshotDown): string {
  const sheets = sheetsOf(message);
  return encodeMsg(
    sheets
      ? { ...message, data: resolveSheetRefs(message.data, (hash) => sheets.get(hash))! }
      : message,
  );
}
