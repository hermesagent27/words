export type Point = { x: number; y: number };

/** Project a point in the rectified unit square back onto the detected quad. */
export function projectBoardPoint(corners: Point[], u: number, v: number): Point {
  const [a, b, c, d] = corners as [Point, Point, Point, Point];
  const dx1 = b.x - c.x;
  const dx2 = d.x - c.x;
  const dx3 = a.x - b.x + c.x - d.x;
  const dy1 = b.y - c.y;
  const dy2 = d.y - c.y;
  const dy3 = a.y - b.y + c.y - d.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  const g = denominator ? (dx3 * dy2 - dx2 * dy3) / denominator : 0;
  const h = denominator ? (dx1 * dy3 - dx3 * dy1) / denominator : 0;
  const scale = g * u + h * v + 1;
  return {
    x: ((b.x - a.x + g * b.x) * u + (d.x - a.x + h * d.x) * v + a.x) / scale,
    y: ((b.y - a.y + g * b.y) * u + (d.y - a.y + h * d.y) * v + a.y) / scale,
  };
}
