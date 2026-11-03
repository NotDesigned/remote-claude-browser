import type { Down } from "@mirror/protocol";
import type { BrowserHandle } from "./launch";
import type { TabHub } from "../hub/tabhub";

interface RecoveryOptions {
  browser: Pick<BrowserHandle, "send" | "onBrowserEvent" | "onDetached">;
  sessionFor(tab: string): string | undefined;
  hubFor(tab: string): TabHub | undefined;
  publish(message: Down): void;
  onCrash(tab: string): void;
  onError?(error: unknown): void;
  recoveryMs?: number;
}

/** Reload only a crashed page, without restarting Chrome or touching its persistent profile. */
export function createRendererRecovery(options: RecoveryOptions) {
  const states = new Map<
    string,
    { state: "recovering" | "failed"; timer?: ReturnType<typeof setTimeout> }
  >();
  const attempts = new Map<string, number[]>();
  let disposed = false;
  const emit = (tab: string, state: "recovering" | "ready" | "failed") =>
    options.publish({ t: "tab-state", tab, state });
  const fail = (
    tab: string,
    state: { state: "recovering" | "failed"; timer?: ReturnType<typeof setTimeout> },
    error: unknown,
  ) => {
    if (disposed || states.get(tab) !== state || state.state === "failed") return;
    clearTimeout(state.timer);
    state.state = "failed";
    emit(tab, "failed");
    options.onError?.(error);
  };
  const unsubscribe = options.browser.onBrowserEvent?.("Target.targetCrashed", (event) => {
    if (disposed) return;
    const tab = event.targetId,
      session = options.sessionFor(tab),
      hub = options.hubFor(tab);
    if (!session || !hub) return; // OOPIFs do not own a canonical tab.
    const previous = states.get(tab);
    clearTimeout(previous?.timer);
    hub.invalidateDocument();
    options.onCrash(tab);
    const recent = (attempts.get(tab) || []).filter((at) => Date.now() - at < 60000);
    recent.push(Date.now());
    attempts.set(tab, recent);
    const state: { state: "recovering" | "failed"; timer?: ReturnType<typeof setTimeout> } = {
      state: "recovering",
    };
    states.set(tab, state);
    emit(tab, "recovering");
    options.onError?.(
      new Error(`Renderer crashed: tab=${tab}, status=${event.status}, code=${event.errorCode}`),
    );
    if (recent.length > 2) {
      fail(tab, state, new Error("Renderer recovery stopped after repeated crashes"));
      return;
    }
    state.timer = setTimeout(
      () => fail(tab, state, new Error("Renderer did not produce a fresh document after reload")),
      options.recoveryMs ?? 20000,
    );
    state.timer.unref?.();
    // Do not wait on a dead page's Runtime queue or replay an input/send action.
    void options.browser
      .send(session, "Page.reload", { ignoreCache: false })
      .catch((error) => fail(tab, state, error));
  });
  options.browser.onDetached((target) => {
    if (target.type !== "page") return;
    clearTimeout(states.get(target.targetId)?.timer);
    states.delete(target.targetId);
    attempts.delete(target.targetId);
  });
  return {
    isBlocked(tab: string) {
      return states.has(tab);
    },
    noteSnapshot(tab: string) {
      if (disposed || !states.has(tab)) return;
      clearTimeout(states.get(tab)?.timer);
      states.delete(tab);
      emit(tab, "ready");
    },
    status() {
      return [...states].map(([tab, state]) => ({
        t: "tab-state" as const,
        tab,
        state: state.state,
      }));
    },
    dispose() {
      disposed = true;
      unsubscribe?.();
      for (const state of states.values()) clearTimeout(state.timer);
      states.clear();
      attempts.clear();
    },
  };
}
