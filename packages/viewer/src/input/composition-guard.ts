/**
 * Which IME compositions a local text surface may commit (px-ime.ts, proxy-input.ts).
 *
 * Only a composition this browser started (trusted events) counts. Some native Chromium IME
 * traces end with an untrusted compositionend: its text is used only when it repeats the preedit
 * already seen through trusted events, never as text of its own.
 */
export interface CompositionGuard {
  /** A composition is open. */
  readonly composing: boolean;
  /** compositionstart; ignored unless trusted. */
  start(event: CompositionEvent): void;
  /** compositionupdate; ignored unless trusted. */
  update(event: CompositionEvent): void;
  /** A trusted `input` that is part of a composition (isComposing). */
  composingInput(event: InputEvent): void;
  /**
   * compositionend: the text it commits (possibly ""), or null when the event must be ignored.
   * The composition is over once it returns non-null.
   */
  end(event: CompositionEvent): string | null;
  /** Forget the open composition (a flush, or dispose). */
  reset(): void;
}

export function createCompositionGuard(): CompositionGuard {
  let composing = false;
  let trustedComposition = false;
  let trustedPreedit: string | null = null;
  const reset = () => {
    composing = false;
    trustedComposition = false;
    trustedPreedit = null;
  };
  return {
    get composing() {
      return composing;
    },
    start(event) {
      if (!event.isTrusted) return;
      composing = true;
      trustedComposition = true;
      trustedPreedit = event.data;
    },
    update(event) {
      if (!event.isTrusted) return;
      composing = true;
      if (trustedComposition) trustedPreedit = event.data;
    },
    composingInput(event) {
      composing = true;
      trustedComposition = true;
      trustedPreedit = event.data;
    },
    end(event) {
      let text = event.data;
      if (!event.isTrusted) {
        // Usable only as confirmation of preedit already observed through trusted native events.
        if (!composing || !trustedComposition) return null;
        if (text !== "") {
          if (trustedPreedit === null || text !== trustedPreedit) return null;
          text = trustedPreedit;
        }
      }
      reset();
      return text;
    },
    reset,
  };
}
