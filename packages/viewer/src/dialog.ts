import { useLayoutEffect, useRef } from "preact/hooks";

/** Shared focus and keyboard behavior for workbench dialogs. */
export function useDialog(open: boolean, onClose: () => void) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    panel.current!.querySelector<HTMLButtonElement>("button")!.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key !== "Tab") return;
      const controls = [
        ...panel.current!.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]',
        ),
      ].filter((element) => element.getClientRects().length > 0);
      const first = controls[0]!,
        last = controls.at(-1)!;
      const outside = !panel.current!.contains(document.activeElement);
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
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);
  return panel;
}
