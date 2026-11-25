import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import { useDialog } from "./dialog";
import "./panel.css";

/**
 * Closing on a backdrop click only when the press also started there: selecting text in a field
 * and letting go over the backdrop is not a request to close.
 */
export interface BackdropDismiss {
  onPointerDown(event: { target: EventTarget | null; currentTarget: EventTarget | null }): void;
  onClick(event: { target: EventTarget | null; currentTarget: EventTarget | null }): void;
}

export function createBackdropDismiss(close: () => void): BackdropDismiss {
  let pressedBackdrop = false;
  return {
    onPointerDown(event) {
      pressedBackdrop = event.target === event.currentTarget;
    },
    onClick(event) {
      const fromBackdrop = pressedBackdrop && event.target === event.currentTarget;
      pressedBackdrop = false;
      if (fromBackdrop) close();
    },
  };
}

export interface PanelProps {
  /** Kept mounted while closed (the network panel keeps its tabs' state). Default true. */
  open?: boolean;
  onClose(): void;
  /** `user` panels (account, admin, mailbox) or the wider `network` panel. */
  variant: "user" | "network";
  /** Extra classes for the dialog itself. */
  class?: string;
  titleId: string;
  title: ComponentChildren;
  description?: ComponentChildren;
  descriptionId?: string;
  closeLabel: string;
  children?: ComponentChildren;
}

/** A workbench panel: backdrop, dialog focus handling, heading and close button. */
export function Panel(props: PanelProps) {
  const open = props.open ?? true;
  const panel = useDialog(open, props.onClose);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  const [dismiss] = useState(() => createBackdropDismiss(() => close.current()));
  const user = props.variant === "user";
  return (
    <div
      class={user ? "user-panel-backdrop" : "network-panel-backdrop"}
      style={open ? undefined : { display: "none" }}
      onPointerDown={dismiss.onPointerDown}
      onClick={dismiss.onClick}
    >
      <section
        class={`${user ? "user-panel" : "network-panel"}${props.class ? ` ${props.class}` : ""}`}
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.titleId}
        aria-describedby={props.description ? props.descriptionId : undefined}
      >
        <header class={user ? "user-panel-heading" : "network-panel-heading"}>
          <div>
            <h2 id={props.titleId}>{props.title}</h2>
            {props.description && (
              <p id={props.descriptionId} class={user ? undefined : "network-muted"}>
                {props.description}
              </p>
            )}
          </div>
          <button
            type="button"
            class={`panel-close ${user ? "user-panel-close" : "network-close"}`}
            aria-label={props.closeLabel}
            onClick={props.onClose}
          >
            ×
          </button>
        </header>
        {props.children}
      </section>
    </div>
  );
}

export interface ConfirmRequest {
  title: string;
  /** One paragraph per entry. */
  message: string | string[];
  confirmLabel?: string;
  /** A destructive action: the confirm button is red. */
  danger?: boolean;
}

interface PendingConfirm extends ConfirmRequest {
  resolve(confirmed: boolean): void;
}

function ConfirmDialog({ request }: { request: PendingConfirm }) {
  const cancel = () => request.resolve(false);
  const dialog = useDialog(true, cancel);
  const [dismiss] = useState(() => createBackdropDismiss(cancel));
  const paragraphs = Array.isArray(request.message) ? request.message : [request.message];
  return (
    <div class="confirm-backdrop" onPointerDown={dismiss.onPointerDown} onClick={dismiss.onClick}>
      <section
        class="confirm-dialog"
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
      >
        <h2 id="confirm-dialog-title">{request.title}</h2>
        <div id="confirm-dialog-message">
          {paragraphs.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
        <div class="confirm-actions">
          <button type="button" class="confirm-cancel" onClick={cancel}>
            取消
          </button>
          <button
            type="button"
            class="confirm-accept"
            data-danger={request.danger ? "true" : undefined}
            onClick={() => request.resolve(true)}
          >
            {request.confirmLabel ?? "确定"}
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * A confirmation in the page's own style instead of `window.confirm`. Render `dialog` somewhere in
 * the component; `confirm()` resolves true only when the person presses the confirm button.
 */
export function useConfirm(): {
  confirm(request: ConfirmRequest): Promise<boolean>;
  dialog: ComponentChildren;
} {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const current = useRef<PendingConfirm | null>(null);
  const confirm = (request: ConfirmRequest) =>
    new Promise<boolean>((resolve) => {
      // A newer question replaces an unanswered one, which counts as cancelled.
      current.current?.resolve(false);
      const next: PendingConfirm = {
        ...request,
        resolve: (confirmed) => {
          if (current.current !== next) return;
          current.current = null;
          setPending(null);
          resolve(confirmed);
        },
      };
      current.current = next;
      setPending(next);
    });
  return { confirm, dialog: pending && <ConfirmDialog request={pending} /> };
}
