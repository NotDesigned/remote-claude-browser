/**
 * A page that follows a live transcript to its end puts back any scroll it did not see a person
 * start, and only wheel input tells it one did. The agent used to dispatch a synthetic WheelEvent
 * for that, which a page can tell from a real one (`isTrusted` is false). With hardening the relay
 * sends the browser a real wheel instead: when a viewer scrolls a scroller up, one trusted
 * `mouseWheel` at the centre of the scroller, before the agent's exact `scrollTo` lands the final
 * position.
 */

/** A real wheel notch; the exact position comes from the scroll command that follows. */
const MAX_WHEEL_DELTA_PX = 120;
/** Scrollers remembered at once, across tabs; the oldest go first. */
const MAX_TRACKED = 256;

export interface ScrollAnnouncerDeps {
  send(sessionId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
  /**
   * Where the scroller is in the tab's viewport (nodeId 0: the page itself), or undefined when that
   * cannot be known or the point would not be in the viewport.
   */
  resolvePoint(tabId: string, nodeId: number): Promise<{ x: number; y: number } | undefined>;
}

export interface ScrollAnnouncer {
  /** Called with every scroll the relay sends, in order, before the agent's scroll command. */
  announce(tabId: string, sessionId: string, nodeId: number, y: number): Promise<void>;
}

export function createScrollAnnouncer(deps: ScrollAnnouncerDeps): ScrollAnnouncer {
  /** `tab:nodeId` -> the last position the relay sent for it. */
  const lastY = new Map<string, number>();
  return {
    async announce(tabId, sessionId, nodeId, y) {
      const key = `${tabId}:${nodeId}`;
      const previous = lastY.get(key);
      lastY.delete(key);
      lastY.set(key, y);
      if (lastY.size > MAX_TRACKED) lastY.delete(lastY.keys().next().value!);
      if (previous === undefined || !Number.isFinite(y) || previous - y < 1) return;
      const point = await deps.resolvePoint(tabId, nodeId).catch(() => undefined);
      if (point === undefined) return;
      await deps.send(sessionId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: point.x,
        y: point.y,
        deltaX: 0,
        deltaY: -Math.min(MAX_WHEEL_DELTA_PX, previous - y),
        modifiers: 0,
        pointerType: "mouse",
      });
    },
  };
}

/** The centre of `rect`, or undefined when it is not visible or not inside the viewport. */
export function centreInViewport(
  rect: { x: number; y: number; w: number; h: number; visible?: boolean },
  viewport: { w: number; h: number } | undefined,
  clip?: { left: number; top: number; right: number; bottom: number },
): { x: number; y: number } | undefined {
  if (rect.visible === false || rect.w <= 0 || rect.h <= 0) return undefined;
  const x = rect.x + rect.w / 2;
  const y = rect.y + rect.h / 2;
  if (clip !== undefined && (x < clip.left || x >= clip.right || y < clip.top || y >= clip.bottom))
    return undefined;
  if (viewport !== undefined && (x < 0 || y < 0 || x >= viewport.w || y >= viewport.h))
    return undefined;
  if (viewport === undefined && (x < 0 || y < 0)) return undefined;
  return { x, y };
}
