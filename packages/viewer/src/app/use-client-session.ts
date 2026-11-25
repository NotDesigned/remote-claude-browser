/** Starting and ending this page's client session (see session-state.ts for the phases). */
import { useEffect, useReducer, useRef } from "preact/hooks";
import {
  ClientSessionError,
  clientPageMode,
  endClientSession,
  prepareClientSession,
  requestClientSession,
  resumesClientSession,
} from "../client-session";
import { myBrowserSessions } from "../users";
import { initialSession, sessionReducer, type SessionState } from "./session-state";

/** How often a session this page lost its connection to is looked for. */
const SESSION_CHECK_INTERVAL_MS = 5_000;

const replaceAddress = (url: string) => window.history.replaceState(window.history.state, "", url);

export interface ClientSessionControl {
  state: SessionState;
  /** The picker chose a profile: start a session with it. */
  pick(account: string): void;
  retry(): void;
  /** The session is over without this page ending it. */
  finish(): void;
  /** Another page took the session over. */
  replaced(): void;
  /** End the session; `stop` first stops everything this page does with it. */
  end(stop: () => void): Promise<void>;
}

export function useClientSession(): ClientSessionControl {
  const [state, dispatch] = useReducer(sessionReducer, undefined, () =>
    initialSession(clientPageMode(new URL(window.location.href))),
  );
  const mountedRef = useRef(false);
  const endControllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      endControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    const pageMode = clientPageMode(url);
    if (pageMode === "closed") {
      dispatch({ type: "closed-page" });
      return;
    }
    if (pageMode === "fixture") return;
    let resuming = false;
    try {
      resuming = resumesClientSession(url, window.sessionStorage);
    } catch {
      // The picker is still usable when accessing sessionStorage itself is blocked.
    }
    const picked = state.picked;
    if (picked === null && !resuming) {
      dispatch({ type: "pick-needed" });
      return;
    }
    let active = true;
    const controller = new AbortController();
    dispatch({ type: "starting" });
    void (async () => {
      try {
        const request = prepareClientSession(url, window.sessionStorage, replaceAddress);
        const session = await requestClientSession(
          picked === null ? request : { ...request, account: picked },
          { signal: controller.signal },
        );
        if (!active || !mountedRef.current || controller.signal.aborted) return;
        const currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set("sid", session.sid);
        replaceAddress(`${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
        dispatch({ type: "started", session });
      } catch (error) {
        if (!active || !mountedRef.current || controller.signal.aborted) return;
        dispatch({
          type: "start-failed",
          error:
            error instanceof ClientSessionError
              ? error
              : new ClientSessionError(0, "CLIENT_START", "无法打开独立会话，请稍后重试。"),
        });
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [state.attempt, state.picked]);

  const finish = () => {
    dispatch({ type: "closed" });
    replaceAddress("/?closed=1");
  };

  const end = async (stop: () => void) => {
    const session = state.session;
    if (session === null || endControllerRef.current !== null) return;
    const controller = new AbortController();
    endControllerRef.current = controller;
    stop();
    dispatch({ type: "ending" });
    try {
      await endClientSession(session.sid, { signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      finish();
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted) return;
      dispatch({
        type: "end-failed",
        error:
          error instanceof ClientSessionError
            ? error
            : new ClientSessionError(0, "CLIENT_END", "未能结束会话，请重试。当前页面已停止操作。"),
      });
    } finally {
      if (endControllerRef.current === controller) endControllerRef.current = null;
    }
  };

  return {
    state,
    pick: (account) => dispatch({ type: "picked", account }),
    retry: () => dispatch({ type: "retry" }),
    finish,
    replaced: () => dispatch({ type: "replaced" }),
    end,
  };
}

/**
 * While `sid` is set (the session is ready but not connected), check that it still exists for
 * this device; `onGone` once it does not. A viewer that never gets input (for example a follower)
 * must still see the page.
 */
export function useSessionWatch(sid: string | null, onGone: () => void): void {
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;
  useEffect(() => {
    if (sid === null) return;
    let active = true;
    const timer = setInterval(() => {
      void myBrowserSessions()
        .then((sessions) => {
          if (active && !sessions.some((session) => session.sid === sid && session.currentDevice))
            onGoneRef.current();
        })
        .catch(() => {});
    }, SESSION_CHECK_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [sid]);
}
