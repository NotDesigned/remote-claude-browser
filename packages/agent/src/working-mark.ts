import {
  WORKING_MARK_ANIMATION,
  type WorkingMarkTrack,
  type WorkingMarkUpdate,
} from "@mirror/protocol";

export function startWorkingMarkCapture(
  getId: (node: Node) => number,
  emit: (tag: string, data: WorkingMarkUpdate) => void,
) {
  let previous = new Map<number, { animation: Animation; state: AnimationPlayState }[]>();
  function sample() {
    const current = new Map<number, { animation: Animation; state: AnimationPlayState }[]>();
    for (const mark of document.querySelectorAll('[data-testid="TurnStatusClayMark"]')) {
      for (const animation of mark.getAnimations({ subtree: true })) {
        if (animation instanceof CSSAnimation || animation instanceof CSSTransition) continue;
        const effect = animation.effect;
        if (!(effect instanceof KeyframeEffect) || !(effect.target instanceof HTMLElement))
          continue;
        const id = getId(effect.target);
        if (id < 0 || typeof animation.currentTime !== "number") continue;
        const entries = current.get(id) ?? [];
        entries.push({ animation, state: animation.playState });
        current.set(id, entries);
      }
    }
    for (const [id, entries] of current) {
      const before = previous.get(id);
      if (
        before?.length === entries.length &&
        entries.every(
          (entry, i) =>
            entry.animation === before[i]?.animation && entry.state === before[i]?.state,
        )
      )
        continue;
      const tracks: WorkingMarkTrack[] = [];
      for (const { animation, state } of entries) {
        const effect = animation.effect as KeyframeEffect;
        const { duration, easing } = effect.getTiming();
        if (typeof duration !== "number" || duration <= 0) continue;
        const frames = effect
          .getKeyframes()
          .map(({ computedOffset, easing, transform, opacity }) => ({
            offset: computedOffset,
            easing,
            ...(typeof transform === "string" && { transform }),
            ...(typeof opacity === "string" && { opacity }),
          }));
        if (
          !frames.some(({ transform, opacity }) => transform !== undefined || opacity !== undefined)
        )
          continue;
        tracks.push({
          frames,
          duration,
          easing: easing ?? "linear",
          time: Number(animation.currentTime),
          paused: state !== "running",
        });
      }
      emit(WORKING_MARK_ANIMATION, { id, tracks });
    }
    for (const id of previous.keys()) {
      if (!current.has(id)) emit(WORKING_MARK_ANIMATION, { id, tracks: [] });
    }
    previous = current;
  }
  window.setInterval(sample, 125);
  return () => {
    previous.clear();
    queueMicrotask(sample);
  };
}
