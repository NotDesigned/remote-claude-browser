/** Capture the native local picker result without suppressing the real user gesture. */
import type { TabId } from "@mirror/protocol";
import { isElement } from "./pointer";

export interface FileCaptureOptions {
  doc: Document;
  tab: TabId;
  select(tab: TabId, input: HTMLInputElement): void;
  /** A click reached a file input of the mirror, so the browser opened that input's own picker. */
  opened?(): void;
  canceled?(tab: TabId): void;
}

const isFileInput = (element: Element | null | undefined): boolean =>
  element?.tagName.toLowerCase() === "input" &&
  (element as HTMLInputElement).type.toLowerCase() === "file";

/** The element a click would open a picker for: the input itself, or the input of its label. */
function clickedFileControl(target: Element): boolean {
  const control = target.closest("input, label");
  if (control?.tagName.toLowerCase() === "label") {
    return isFileInput((control as HTMLLabelElement).control);
  }
  return isFileInput(control);
}

export function attachFileCapture(options: FileCaptureOptions): () => void {
  const onChange = (event: Event) => {
    if (!event.isTrusted || !isElement(event.target)) return;
    if (!isFileInput(event.target)) return;
    options.select(options.tab, event.target as HTMLInputElement);
  };
  const onClick = (event: Event) => {
    if (event.isTrusted && isElement(event.target) && clickedFileControl(event.target)) {
      options.opened?.();
    }
  };
  const onCancel = (event: Event) => {
    if (event.isTrusted && isElement(event.target) && isFileInput(event.target)) {
      options.canceled?.(options.tab);
    }
  };

  options.doc.addEventListener("change", onChange, true);
  options.doc.addEventListener("click", onClick, true);
  options.doc.addEventListener("cancel", onCancel, true);
  return () => {
    options.doc.removeEventListener("change", onChange, true);
    options.doc.removeEventListener("click", onClick, true);
    options.doc.removeEventListener("cancel", onCancel, true);
  };
}
