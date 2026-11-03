/** Copies private remote clipboard events directly to the local user's clipboard. */
export interface ClipboardWriterOptions {
  writeText?: (text: string) => Promise<void>;
  onError?: (error: unknown) => void;
  onCopied?: () => void;
}

export function createClipboardWriter(options: ClipboardWriterOptions = {}) {
  const writeText = options.writeText ?? writeLocalClipboard;
  let queue = Promise.resolve();
  let disposed = false;
  return {
    write(text: string): void {
      queue = queue.then(async () => {
        if (disposed) return;
        try {
          await writeText(text);
          if (!disposed) options.onCopied?.();
        } catch (error) {
          if (!disposed) options.onError?.(error);
        }
      });
    },
    dispose(): void {
      disposed = true;
    },
  };
}

async function writeLocalClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // The legacy path can still work during the original copy gesture in stricter browsers.
  }
  const previousFocus = document.activeElement;
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0";
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand("copy")) throw new Error("浏览器未允许写入本机剪贴板");
  } finally {
    input.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
  }
}
