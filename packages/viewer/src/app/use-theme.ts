/** The light/dark choice: this page's preference, the system's, and Claude's Appearance setting. */
import { useEffect, useRef, useState } from "preact/hooks";
import { apiRequest } from "../api";
import type { ThemePreference } from "../shell-bar";
import { viewStorage } from "./view-storage";

const THEME_CHECK_MS = 3_000;

export interface Theme {
  preference: ThemePreference;
  setPreference(preference: ThemePreference): void;
  /** What the page shows now. */
  theme: "light" | "dark";
}

/**
 * `sid` is the ready session the choice is kept in step with, or null while there is none. This
 * page's choice goes first, and is repeated until a Claude page has taken it. Only then can a
 * change made under Settings come back.
 */
export function useTheme(sid: string | null): Theme {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    const stored = viewStorage().getItem("mirror.theme");
    return stored === "light" || stored === "dark" ? stored : "auto";
  });
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  const theme: "light" | "dark" =
    preference === "auto" ? (systemDark ? "dark" : "light") : preference;

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const update = () => setSystemDark(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    viewStorage().setItem("mirror.theme", preference);
  }, [theme, preference]);

  const themeKey = `${preference}:${systemDark}`;
  const syncedThemeRef = useRef<string | null>(null);
  useEffect(() => {
    if (sid === null) return;
    let active = true;
    const url = `/s/${encodeURIComponent(sid)}/theme`;
    const send = async () => {
      const result = await apiRequest<{ applied?: boolean } | undefined>(url, "POST", {
        theme: preference,
        systemDark,
      });
      if (active && result?.applied) syncedThemeRef.current = themeKey;
    };
    const sync = async () => {
      if (document.hidden) return;
      if (syncedThemeRef.current !== themeKey) {
        await send();
        return;
      }
      const result = await apiRequest<{ theme?: ThemePreference | null } | undefined>(url);
      if (!active || result === undefined) return;
      const remote = result.theme ?? null;
      // The gateway has restarted and does not know this client's choice.
      if (remote === null) {
        syncedThemeRef.current = null;
        await send();
        return;
      }
      if (remote === preference) return;
      syncedThemeRef.current = `${remote}:${systemDark}`;
      setPreference(remote);
    };
    void sync().catch(() => {});
    const timer = setInterval(() => void sync().catch(() => {}), THEME_CHECK_MS);
    // A phone coming back should not show the old mode for up to a whole check.
    const onVisible = () => void sync().catch(() => {});
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sid, themeKey]);

  return { preference, setPreference, theme };
}
