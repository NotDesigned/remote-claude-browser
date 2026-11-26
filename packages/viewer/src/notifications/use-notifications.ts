/** The running session's website notifications (controller.ts), as the shell shows them. */
import { useEffect, useRef, useState } from "preact/hooks";
import { viewStorage } from "../app/view-storage";
import {
  browserNotifyEnv,
  createNotifyController,
  type NotifyController,
  type NotifyState,
} from "./controller";
import { loadNotifySettings, notifyStorageKey, saveNotifySettings } from "./policy";

export interface NotificationsControl {
  state: NotifyState | null;
  setEnabled(enabled: boolean): void;
  answer(id: string, allow: boolean): void;
  dismiss(id: string): void;
  resetSites(): void;
}

/** `sid` while a session runs (null otherwise); `profile` names whose settings apply. */
export function useNotifications(sid: string | null, profile: string | null): NotificationsControl {
  const [state, setState] = useState<NotifyState | null>(null);
  const controller = useRef<NotifyController | null>(null);
  const key = profile === null ? null : notifyStorageKey(profile);

  useEffect(() => {
    if (sid === null || key === null) {
      setState(null);
      return;
    }
    const storage = viewStorage();
    const live = createNotifyController({
      sid,
      env: browserNotifyEnv(),
      settings: loadNotifySettings(storage, key),
      save: (settings) => saveNotifySettings(storage, key, settings),
      onChange: setState,
    });
    controller.current = live;
    setState(live.state());
    const recheck = () => {
      if (!document.hidden) live.recheck();
    };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("focus", recheck);
      live.dispose();
      if (controller.current === live) controller.current = null;
    };
  }, [sid, key]);

  return {
    state,
    setEnabled: (enabled) => void controller.current?.setEnabled(enabled),
    answer: (id, allow) => void controller.current?.answer(id, allow),
    dismiss: (id) => controller.current?.dismiss(id),
    resetSites: () => controller.current?.resetSites(),
  };
}
