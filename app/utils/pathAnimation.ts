import type { Point } from "./boardGeometry";

export function pathAnimationDuration(word: string): number {
  return word.length <= 4 ? 150 : word.length <= 7 ? 250 : 450;
}

export function pathLineStyle(word: string, segmentCount: number, segmentIndex: number, from: Point, to: Point) {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const duration = pathAnimationDuration(word) / segmentCount;
  return {
    strokeDasharray: `${length} ${length}`,
    strokeDashoffset: length,
    animation: `draw-path-line ${duration}ms linear ${segmentIndex * duration}ms forwards`,
  };
}

export function createSilentPathSequence(onWordStart: (index: number) => void, onComplete: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let revision = 0;

  function stop() {
    revision++;
    if (timer !== null)
      clearTimeout(timer);
    timer = null;
  }

  function start(words: string[]) {
    stop();
    const current = revision;
    function next(index: number) {
      if (current !== revision)
        return;
      if (index >= words.length) {
        timer = null;
        onComplete();
        return;
      }
      onWordStart(index);
      timer = setTimeout(() => next(index + 1), pathAnimationDuration(words[index]!) + (index + 1 < words.length ? 300 : 150));
    }
    next(0);
  }

  return { start, stop };
}
