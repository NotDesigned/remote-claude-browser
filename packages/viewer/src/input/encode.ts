/**
 * Wire encoders shared by page mode (input/*) and pixel mode (pxview.tsx, px-ime.ts): the same
 * modifier bits, key pairs and pointer messages whichever surface the person is using.
 */
import { Mod, type TabId, type Up } from "@mirror/protocol";

export type KeyMessage = Extract<Up, { t: "key" }>;
export type PointerMessage = Extract<Up, { t: "ptr" }>;
export type ModifierKeys = Pick<MouseEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">;

/** CDP modifier bits (protocol Mod) of a mouse, key or input event. */
export function eventMods(event: ModifierKeys): number {
  return (
    (event.altKey ? Mod.Alt : 0) |
    (event.ctrlKey ? Mod.Ctrl : 0) |
    (event.metaKey ? Mod.Meta : 0) |
    (event.shiftKey ? Mod.Shift : 0)
  );
}

/** The wire's mouse button: primary, middle or secondary; anything else is left out. */
export function mouseButton(button: number): 0 | 1 | 2 | undefined {
  return button === 0 || button === 1 || button === 2 ? button : undefined;
}

/** A click count from an event's `detail`, capped at `max` (page mode 2, pixel mode 3). */
export function clickCount(detail: number, max: 2 | 3): 1 | 2 | 3 {
  if (max === 3 && detail >= 3) return 3;
  return detail >= 2 ? 2 : 1;
}

export function keyMessage(
  tab: TabId,
  kind: KeyMessage["kind"],
  key: string,
  code: string,
  mods: number,
): KeyMessage {
  return { t: "key", tab, kind, key, code, mods };
}

/** The key message for a keyboard event as pressed. */
export function keyEventMessage(
  tab: TabId,
  kind: KeyMessage["kind"],
  event: Pick<KeyboardEvent, "key" | "code"> & ModifierKeys,
): KeyMessage {
  return keyMessage(tab, kind, event.key, event.code, eventMods(event));
}

/** A whole key press (down, then up), for a key the local event stream never delivered as such. */
export function sendKeyPress(
  send: (message: Up) => void,
  tab: TabId,
  key: string,
  code: string,
  mods: number,
): void {
  for (const kind of ["down", "up"] as const) send(keyMessage(tab, kind, key, code, mods));
}

/**
 * An OS paste shortcut. The paste event carries this device's clipboard; forwarding the shortcut
 * would paste the remote browser's clipboard instead.
 */
export function isPasteShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "key">,
): boolean {
  return (
    (!event.altKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") ||
    (event.shiftKey && event.key === "Insert")
  );
}

export type PointerPosition = Pick<PointerMessage, "nodeId" | "rx" | "ry" | "vx" | "vy">;

export type PointerFields = ModifierKeys &
  Pick<MouseEvent, "button" | "buttons" | "detail"> & { deltaX?: number; deltaY?: number };

/** A mouse pointer message at `position`; a wheel carries its deltas. */
export function pointerMessage(
  tab: TabId,
  kind: PointerMessage["kind"],
  position: PointerPosition,
  event: PointerFields,
  maxClicks: 2 | 3,
): PointerMessage {
  return {
    t: "ptr",
    tab,
    kind,
    ...position,
    button: mouseButton(event.button),
    buttons: event.buttons,
    mods: eventMods(event),
    clicks: clickCount(event.detail, maxClicks),
    ...(kind === "wheel" ? { dx: event.deltaX ?? 0, dy: event.deltaY ?? 0 } : {}),
  };
}
