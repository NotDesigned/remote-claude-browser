/**
 * Which element has focus in the remote page, sent as an rrweb custom event so that it travels
 * with the replay and names nodes by the same ids (a cross-origin frame's recorder has its ids
 * translated by rrweb on the way up, like any of its events).
 *
 * The viewer moves its own focus to match on desktop, so that typing, and the local IME, go to the
 * field the remote page will type into. Older agents send nothing; the viewer then keeps its
 * previous behaviour.
 */
export const REMOTE_FOCUS_EVENT = "mirror:focus";

export interface RemoteFocus {
  /** The focused element's node id, or -1 when the top document reports no element. */
  id: number;
  /** A text field or editing host: typing there inserts text. */
  editable: boolean;
  /** A password field: the viewer turns off its keyboard's suggestions while it is focused. */
  password?: boolean;
}

export function isRemoteFocus(value: unknown): value is RemoteFocus {
  if (typeof value !== "object" || value === null) return false;
  const focus = value as Partial<RemoteFocus>;
  return (
    typeof focus.id === "number" &&
    Number.isSafeInteger(focus.id) &&
    typeof focus.editable === "boolean" &&
    (focus.password === undefined || typeof focus.password === "boolean")
  );
}
