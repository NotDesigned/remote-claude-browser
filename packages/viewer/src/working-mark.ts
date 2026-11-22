import {
  EventType,
  WORKING_MARK_ANIMATION,
  type eventWithTime,
  type WorkingMarkUpdate,
} from "@mirror/protocol";
import type { Replayer } from "@rrweb/replay";

export function workingMarkReplay() {
  const playing = new Map<number, Animation[]>();
  return {
    handler(event: eventWithTime, _isSync: boolean, { replayer }: { replayer: Replayer }) {
      if (event.type === EventType.FullSnapshot) {
        for (const animations of playing.values())
          animations.forEach((animation) => animation.cancel());
        playing.clear();
      }
      if (event.type !== EventType.Custom || event.data.tag !== WORKING_MARK_ANIMATION) return;
      const { id, tracks } = event.data.payload as WorkingMarkUpdate;
      for (const animation of playing.get(id) ?? []) animation.cancel();
      playing.delete(id);
      const target = replayer.getMirror().getNode(id) as HTMLElement | null;
      if (!target?.closest?.('[data-testid="TurnStatusClayMark"]')) return;
      const animations = tracks.map(({ frames, duration, easing, iterations, time, paused }) => {
        const keyframes = frames.map(({ offset, easing, transform, opacity }) => ({
          offset,
          easing,
          transform,
          opacity,
        }));
        const animation = target.animate(keyframes, {
          duration,
          easing,
          iterations: iterations === null ? Infinity : iterations,
          fill: "forwards",
        });
        if (paused) animation.pause();
        animation.currentTime = time;
        return animation;
      });
      if (animations.length > 0) playing.set(id, animations);
    },
  };
}
