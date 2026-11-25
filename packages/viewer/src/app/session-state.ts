/**
 * The page's independent client session: choosing a profile, starting, running, ending, and the
 * two ways it stops without this page asking (closed elsewhere, or taken over by another page).
 *
 *   picking ──picked──▶ starting ──started──▶ ready ──ending──▶ ending ──closed──▶ closed
 *                          │  ▲                 │                 │
 *                start-failed  retry            │ closed/replaced  └─end-failed─▶ error
 *                          ▼  │                 ▼
 *                         error            closed / replaced
 */
import type { ClientSession, ClientSessionError, clientPageMode } from "../client-session";
import type { ClientPhase } from "../connection-status";
import { patch } from "./patch";

export type { ClientPhase };

export interface SessionState {
  phase: ClientPhase;
  session: ClientSession | null;
  error: ClientSessionError | null;
  /** The error is about ending the session, not starting it: retrying ends it again. */
  endFailure: boolean;
  /** The profile this tab's picker chose; a reload resumes without one. */
  picked: string | null;
  /** Bumped to start again after a failure. */
  attempt: number;
}

export type SessionAction =
  /** The address says the session was closed: nothing starts. */
  | { type: "closed-page" }
  | { type: "pick-needed" }
  | { type: "picked"; account: string }
  | { type: "starting" }
  | { type: "started"; session: ClientSession }
  | { type: "start-failed"; error: ClientSessionError }
  | { type: "retry" }
  | { type: "ending" }
  | { type: "end-failed"; error: ClientSessionError }
  /** Ended, by this page or elsewhere: the page stays, without a session. */
  | { type: "closed" }
  /** Another page took the session over. */
  | { type: "replaced" };

/**
 * The phase a page starts in, from its address (see `clientPageMode`) and whether it comes back to
 * a session it had (`resumesClientSession`). A fresh tab starts in the picker: starting in the
 * session's view and switching a moment later showed the session bar first, whose menu then
 * vanished under whoever reached for it.
 */
export function initialSession(
  pageMode: ReturnType<typeof clientPageMode>,
  resuming = true,
): SessionState {
  return {
    phase:
      pageMode === "closed"
        ? "closed"
        : pageMode === "fixture"
          ? "ready"
          : resuming
            ? "starting"
            : "picking",
    session: null,
    error: null,
    endFailure: false,
    picked: null,
    attempt: 0,
  };
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "closed-page":
      return patch(state, { phase: "closed" });
    case "pick-needed":
      return patch(state, { phase: "picking" });
    case "picked":
      return patch(state, { picked: action.account });
    case "starting":
      return patch(state, { phase: "starting", error: null, endFailure: false });
    case "started":
      return patch(state, { session: action.session, phase: "ready" });
    case "start-failed":
      return patch(state, { error: action.error, phase: "error" });
    case "retry":
      return { ...state, attempt: state.attempt + 1 };
    case "ending":
      return patch(state, { error: null, endFailure: false, phase: "ending" });
    case "end-failed":
      return patch(state, { error: action.error, endFailure: true, phase: "error" });
    case "closed":
      return patch(state, { error: null, session: null, phase: "closed" });
    case "replaced":
      return patch(state, { phase: "replaced" });
  }
}
