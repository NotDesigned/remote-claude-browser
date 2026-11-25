// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ClientSessionError, type ClientSession } from "../client-session";
import {
  initialSession,
  sessionReducer,
  type SessionAction,
  type SessionState,
} from "./session-state";

const session = { sid: "client-1", sharedAccount: true, label: "client" } as ClientSession;
const failure = new ClientSessionError(503, "BUSY", "busy");
const run = (state: SessionState, ...actions: SessionAction[]) =>
  actions.reduce(sessionReducer, state);

describe("client session state", () => {
  it("starts from the page address", () => {
    expect(initialSession("closed").phase).toBe("closed");
    expect(initialSession("fixture").phase).toBe("ready");
    expect(initialSession("session")).toEqual({
      phase: "starting",
      session: null,
      error: null,
      endFailure: false,
      picked: null,
      attempt: 0,
    });
  });

  it("picks, starts and runs", () => {
    const picking = run(initialSession("session"), { type: "pick-needed" });
    expect(picking.phase).toBe("picking");
    const picked = run(picking, { type: "picked", account: "work" });
    expect(picked).toMatchObject({ phase: "picking", picked: "work" });
    const ready = run(picked, { type: "starting" }, { type: "started", session });
    expect(ready).toMatchObject({ phase: "ready", session, picked: "work", error: null });
  });

  it("shows a start failure until a retry starts again", () => {
    const failed = run(initialSession("session"), { type: "start-failed", error: failure });
    expect(failed).toMatchObject({ phase: "error", error: failure, endFailure: false });
    const retried = run(failed, { type: "retry" });
    expect(retried.attempt).toBe(1);
    expect(run(retried, { type: "starting" })).toMatchObject({ phase: "starting", error: null });
  });

  it("ends a session, and retries a failed end", () => {
    const ready = run(initialSession("session"), { type: "started", session });
    const ending = run(ready, { type: "ending" });
    expect(ending).toMatchObject({ phase: "ending", session, error: null, endFailure: false });
    const failed = run(ending, { type: "end-failed", error: failure });
    expect(failed).toMatchObject({ phase: "error", session, error: failure, endFailure: true });
    // Retrying the end clears the failure while it runs.
    const closed = run(failed, { type: "ending" }, { type: "closed" });
    expect(closed).toMatchObject({ phase: "closed", session: null, error: null });
  });

  it("closes or hands over a running session from elsewhere", () => {
    const ready = run(initialSession("session"), { type: "started", session });
    expect(run(ready, { type: "closed" })).toMatchObject({ phase: "closed", session: null });
    expect(run(ready, { type: "replaced" })).toMatchObject({ phase: "replaced", session });
  });

  it("a starting page clears an earlier end failure", () => {
    const failed = run(
      initialSession("session"),
      { type: "started", session },
      { type: "end-failed", error: failure },
    );
    expect(run(failed, { type: "starting" })).toMatchObject({ endFailure: false, error: null });
  });

  it("keeps the same state when nothing changes", () => {
    const starting = initialSession("session");
    expect(sessionReducer(starting, { type: "starting" })).toBe(starting);
    const closed = initialSession("closed");
    expect(sessionReducer(closed, { type: "closed-page" })).toBe(closed);
  });
});
