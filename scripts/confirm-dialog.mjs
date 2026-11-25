// The workbench asks for confirmation in its own dialog (panel.tsx `useConfirm`), not with
// window.confirm. This answers it from a smoke the way page.on("dialog") answered the native one:
// each handler gets { message(), accept(), dismiss() }; with no handler the dialog is dismissed.
const installed = new WeakMap();

function install(binding) {
  const seen = new WeakSet();
  const answer = (dialog) => {
    if (seen.has(dialog)) return;
    seen.add(dialog);
    const text = [
      dialog.querySelector("h2")?.textContent ?? "",
      ...[...dialog.querySelectorAll("#confirm-dialog-message p")].map((p) => p.textContent),
    ].join("\n\n");
    void window[binding](text).then((accept) => {
      if (!dialog.isConnected) return;
      dialog.querySelector(accept ? ".confirm-accept" : ".confirm-cancel")?.click();
    });
  };
  const scan = () => document.querySelectorAll(".confirm-dialog").forEach(answer);
  const start = () => {
    new MutationObserver(scan).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    scan();
  };
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}

/** page.on / page.off / page.once for the workbench's confirmation dialog. */
export async function confirmDialogs(page) {
  const existing = installed.get(page);
  if (existing) return existing;
  const handlers = [];
  const messages = [];
  const binding = `__answerConfirm${Math.random().toString(36).slice(2)}`;
  await page.exposeBinding(binding, async (_source, text) => {
    messages.push(text);
    let accepted = false;
    const dialog = {
      message: () => text,
      accept: async () => {
        accepted = true;
      },
      dismiss: async () => {
        accepted = false;
      },
    };
    for (const entry of [...handlers]) {
      if (entry.once) handlers.splice(handlers.indexOf(entry), 1);
      await entry.handler(dialog);
    }
    return accepted;
  });
  await page.addInitScript(install, binding);
  await page.evaluate(install, binding).catch(() => undefined);
  const api = {
    /** Every confirmation text shown so far on this page. */
    messages,
    on(handler) {
      handlers.push({ handler, once: false });
    },
    once(handler) {
      handlers.push({ handler, once: true });
    },
    off(handler) {
      const index = handlers.findIndex((entry) => entry.handler === handler);
      if (index >= 0) handlers.splice(index, 1);
    },
    /** Waits until `count` confirmations have been shown (and answered). */
    async waitForCount(count, timeout = 10_000) {
      const deadline = Date.now() + timeout;
      while (messages.length < count) {
        if (Date.now() > deadline)
          throw new Error(`expected ${count} confirmations, saw ${messages.length}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await page
        .locator(".confirm-dialog")
        .waitFor({ state: "detached", timeout })
        .catch(() => undefined);
    },
  };
  installed.set(page, api);
  return api;
}
