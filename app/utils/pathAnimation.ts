import type { Point } from "./boardGeometry";

export function pathLineStyle(word: string, segmentCount: number, wordIndex: number, segmentIndex: number, revealedWordIndex: number, from: Point, to: Point) {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const duration = (word.length <= 4 ? 200 : word.length <= 7 ? 300 : 500) / segmentCount;
  const visible = wordIndex <= revealedWordIndex;
  return {
    strokeDasharray: `${length} ${length}`,
    strokeDashoffset: visible ? 0 : length,
    transition: visible ? `stroke-dashoffset ${duration}ms linear ${segmentIndex * duration}ms` : "none",
  };
}
