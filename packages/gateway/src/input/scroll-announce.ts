/**
 * A page that follows a live transcript to its end puts back any scroll it did not see a person
 * start, and only wheel input tells it one did. The agent used to dispatch a synthetic WheelEvent
 * for that, which a page can tell from a real one (`isTrusted` is false). With hardening the relay
 * sends the browser real input instead, before the agent's exact `scrollTo` lands the final
 * position.
 *
 * Whether there is a scroll up at all is the page's call, not the viewer's: the agent compares the
 * requested position with where the scroller is now (the page may have followed its end since the
 * viewer last reported, or be another document), and picks a point that hit-tests to the scroller
 * itself, so Chromium does not hand the wheel to a nested scroller, an overlay or a frame there.
 * The gateway keeps no positions of its own.
 */
import type { WheelPointResult } from "@mirror/protocol";

/** A touch scroll is sent this fast, so it is over well before the exact position follows. */
const TOUCH_SCROLL_SPEED_PX_S = 2_400;

export interface ScrollAnnouncerDeps {
  send(sessionId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
  /**
   * Where a wheel would scroll this scroller (nodeId 0: the page itself) up towards `y`, in the
   * tab's viewport, as the agent judges it from the page's live position; undefined for no wheel.
   */
  locate(tabId: string, nodeId: number, y: number): Promise<WheelPointResult | undefined>;
}

export interface ScrollAnnouncer {
  /** Called with every scroll the relay sends, before the agent's scroll command. */
  announce(tabId: string, sessionId: string, nodeId: number, y: number): Promise<void>;
}

export function createScrollAnnouncer(deps: ScrollAnnouncerDeps): ScrollAnnouncer {
  const wheel = (sessionId: string, point: WheelPointResult) =>
    deps.send(sessionId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: -point.dy,
      modifiers: 0,
      pointerType: "mouse",
    });
  return {
    async announce(tabId, sessionId, nodeId, y) {
      if (!Number.isFinite(y)) return;
      const point = await deps.locate(tabId, nodeId, y);
      if (point === undefined) return;
      if (point.touch !== true) {
        await wheel(sessionId, point);
        return;
      }
      // A phone does not wheel: a short touch drag is what its person would send. Chromium refuses
      // a touch gesture when the page is not emulating touch, and then the wheel still goes.
      try {
        await deps.send(sessionId, "Input.synthesizeScrollGesture", {
          x: point.x,
          y: point.y,
          xDistance: 0,
          yDistance: point.dy,
          gestureSourceType: "touch",
          preventFling: true,
          speed: TOUCH_SCROLL_SPEED_PX_S,
        });
      } catch {
        await wheel(sessionId, point);
      }
    },
  };
}

export function isWheelPoint(value: unknown): value is WheelPointResult {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Partial<WheelPointResult>;
  return (
    [point.x, point.y, point.dy].every(
      (part) => typeof part === "number" && Number.isFinite(part),
    ) && point.dy! > 0
  );
}

/** Whether a point is inside the viewport and, for a frame's content, inside its frames. */
export function insideViewport(
  point: { x: number; y: number },
  viewport: { w: number; h: number } | undefined,
  clip?: { left: number; top: number; right: number; bottom: number },
): boolean {
  const { x, y } = point;
  if (x < 0 || y < 0) return false;
  if (clip !== undefined && (x < clip.left || x >= clip.right || y < clip.top || y >= clip.bottom))
    return false;
  return viewport === undefined || (x < viewport.w && y < viewport.h);
}
