import type { Down } from "@mirror/protocol";

/** A pixel startup failure must not show an empty semantic fallback in native mode. */
export function createNativePixelRetry(options: {
  current(tab: string): boolean;
  start(tab: string): Promise<void>;
  publish(message: Down): void;
}) {
  const wanted = new Set<string>();
  const attempts = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;
  const cancel = (tab: string) => {
    clearTimeout(timers.get(tab));
    timers.delete(tab);
  };
  return {
    wants: (tab: string) => wanted.has(tab),
    request(tab: string) {
      if (disposed) return;
      wanted.add(tab);
      attempts.delete(tab);
      cancel(tab);
    },
    stop(tab: string) {
      wanted.delete(tab);
      attempts.delete(tab);
      cancel(tab);
    },
    observe(message: Down) {
      if (disposed) return;
      if (message.t === "mode" && message.mode === "dom" && wanted.has(message.tab)) {
        const tab = message.tab;
        options.publish({ ...message, mode: "px" });
        if (timers.has(tab)) return;
        const count = attempts.get(tab) ?? 0;
        if (count >= 3) {
          options.publish({ t: "tab-state", tab, state: "failed" });
          return;
        }
        attempts.set(tab, count + 1);
        const timer = setTimeout(() => {
          timers.delete(tab);
          if (!disposed && wanted.has(tab) && options.current(tab))
            void options.start(tab).catch(() => {
              if (!disposed) options.publish({ t: "tab-state", tab, state: "failed" });
            });
        }, 1000);
        timer.unref?.();
        timers.set(tab, timer);
        return;
      }
      if ((message.t === "px" || message.t === "vid") && wanted.has(message.tab)) {
        if (attempts.has(message.tab))
          options.publish({ t: "tab-state", tab: message.tab, state: "ready" });
        attempts.delete(message.tab);
        cancel(message.tab);
      }
      options.publish(message);
    },
    dispose() {
      disposed = true;
      for (const tab of timers.keys()) cancel(tab);
      wanted.clear();
      attempts.clear();
    },
  };
}
