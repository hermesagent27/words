import type { Point } from "./boardGeometry";

export function pathAnimationDuration(word: string): number {
  return word.length <= 4 ? 450 : word.length <= 7 ? 550 : 750;
}

/**
 * Split a word into one chunk per path step (tile). The Qu tile is a single
 * path step but spells as two letters, so a naive per-character split loses
 * sync with the drawn segments.
 */
export function wordStepChunks(word: string): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < word.length) {
    if (word[i] === "q" && word[i + 1] === "u") {
      chunks.push("qu");
      i += 2;
    }
    else {
      chunks.push(word[i]!);
      i += 1;
    }
  }
  return chunks;
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
