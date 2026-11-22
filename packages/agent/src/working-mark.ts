import {
  WORKING_MARK_ANIMATION,
  type WorkingMarkTrack,
  type WorkingMarkUpdate,
} from "@mirror/protocol";

interface SampledAnimation {
  animation: Animation;
  effect: KeyframeEffect;
  state: AnimationPlayState;
  iterations: number;
}

export function startWorkingMarkCapture(
  getId: (node: Node) => number,
  emit: (tag: string, data: WorkingMarkUpdate) => void,
) {
  let previous = new Map<number, SampledAnimation[]>();
  function sample() {
    const current = new Map<number, SampledAnimation[]>();
    for (const mark of document.querySelectorAll('[data-testid="TurnStatusClayMark"]')) {
      for (const animation of mark.getAnimations({ subtree: true })) {
        if (animation instanceof CSSAnimation || animation instanceof CSSTransition) continue;
        const effect = animation.effect;
        if (!(effect instanceof KeyframeEffect) || !(effect.target instanceof HTMLElement))
          continue;
        const id = getId(effect.target);
        if (id < 0 || typeof animation.currentTime !== "number") continue;
        const entries = current.get(id) ?? [];
        entries.push({
          animation,
          effect,
          state: animation.playState,
          iterations: effect.getTiming().iterations ?? 1,
        });
        current.set(id, entries);
      }
    }
    for (const [id, entries] of current) {
      const before = previous.get(id);
      if (
        before?.length === entries.length &&
        entries.every(
          (entry, i) =>
            entry.animation === before[i]?.animation &&
            entry.state === before[i]?.state &&
            entry.iterations === before[i]?.iterations,
        )
      )
        continue;
      const tracks: WorkingMarkTrack[] = [];
      for (const { animation, effect, state, iterations } of entries) {
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
          iterations: iterations === Infinity ? null : iterations,
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
