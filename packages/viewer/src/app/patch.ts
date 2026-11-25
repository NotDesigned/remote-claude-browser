/**
 * `state` with `changes` applied, or `state` itself when nothing changes, so a reducer that
 * repeats a value does not redraw the page (as a repeated useState value would not).
 */
export function patch<T extends object>(state: T, changes: Partial<T>): T {
  for (const key in changes) {
    if (!Object.is(state[key], changes[key])) return { ...state, ...changes };
  }
  return state;
}
