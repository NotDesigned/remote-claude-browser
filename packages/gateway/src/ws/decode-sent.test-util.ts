import { decodeDown, decodePxBinary, type Down } from "@mirror/protocol";

/** Test doubles see what a real viewer receives: JSON text, or a binary pixel frame. */
export function decodeSent(serialized: string | Uint8Array): Down {
  if (typeof serialized === "string") return decodeDown(serialized);
  const frame = decodePxBinary(serialized);
  if (frame === null) throw new Error("unknown binary frame");
  const data = Buffer.from(frame.jpeg).toString("base64");
  return { t: "px", tab: frame.tab, data, w: frame.w, h: frame.h };
}
