import { useLayoutEffect, useRef } from "preact/hooks";

const FOCUSABLE =
  'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]';

/** Where focus goes when the control that opened a dialog is gone: the ⋯ menu that leads there. */
const FOCUS_FALLBACK = "#shell-menu-toggle, .workspace-menu-trigger";

/** Open dialogs, innermost last: only the innermost one answers Escape and Tab. */
const openDialogs: object[] = [];

export function focusableIn(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.getClientRects().length > 0,
  );
}

/**
 * Moves focus to `element`, or to the ⋯ trigger when it has left the page. The page itself
 * (body) counts as gone: it is where focus falls when the control that had it was removed, such
 * as a ⋯ menu item that closed its menu and opened a panel.
 */
export function restoreFocus(element: Element | null): void {
  const target =
    element instanceof HTMLElement &&
    element.isConnected &&
    element !== document.body &&
    element !== document.documentElement
      ? element
      : document.querySelector<HTMLElement>(FOCUS_FALLBACK);
  target?.focus();
}

/** Shared focus and keyboard behavior for workbench dialogs. */
export function useDialog(open: boolean, onClose: () => void) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const root = panel.current;
    if (!open || !root) return;
    const token = {};
    openDialogs.push(token);
    const previous = document.activeElement;
    const first = root.querySelector<HTMLElement>(FOCUSABLE);
    if (first) first.focus();
    else {
      // Nothing to press yet (still loading): the dialog itself takes focus.
      if (!root.hasAttribute("tabindex")) root.tabIndex = -1;
      root.focus();
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || openDialogs.at(-1) !== token) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusableIn(root);
      const outside = !root.contains(document.activeElement);
      if (controls.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = controls[0]!,
        last = controls.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      openDialogs.splice(openDialogs.indexOf(token), 1);
      // Focus stays where it is when it already moved somewhere else on purpose.
      const active = document.activeElement;
      if (
        active === null ||
        active === document.body ||
        root.contains(active) ||
        !active.isConnected
      )
        restoreFocus(previous);
    };
  }, [open]);
  return panel;
}
