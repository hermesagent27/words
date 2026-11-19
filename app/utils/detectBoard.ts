import type { Point } from "./boardGeometry";

type Candidate = { x: number; y: number; size: number; area: number };

/**
 * Find the tile grid rather than assuming a fixed board position or size.
 * The detected tile centers are fitted to a perspective transform; projecting
 * half a cell beyond the outer centers gives the board's four edges.
 */
export function detectBoardCorners(cv: Record<string, any>, source: HTMLCanvasElement): Point[] | null {
  const scale = Math.min(1, 1200 / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("Unable to create board detection canvas");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);

  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  const threshold = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.adaptiveThreshold(blur, threshold, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 11, 2);
    cv.findContours(threshold, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const candidates: Candidate[] = [];
    const imageArea = canvas.width * canvas.height;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const approx = new cv.Mat();
      try {
        const area = cv.contourArea(contour);
        if (area < imageArea * 0.001 || area > imageArea * 0.04)
          continue;
        const box = cv.boundingRect(contour);
        const aspect = box.width / box.height;
        if (aspect < 0.55 || aspect > 1.8 || area / (box.width * box.height) < 0.6)
          continue;
        cv.approxPolyDP(contour, approx, 0.025 * cv.arcLength(contour, true), true);
        if (approx.rows !== 4 || !cv.isContourConvex(approx))
          continue;
        candidates.push({ x: box.x + box.width / 2, y: box.y + box.height / 2, size: Math.sqrt(box.width * box.height), area });
      }
      finally {
        contour.delete();
        approx.delete();
      }
    }

    candidates.sort((a, b) => b.area - a.area);
    const unique: Candidate[] = [];
    for (const candidate of candidates) {
      if (!unique.some(other => Math.hypot(candidate.x - other.x, candidate.y - other.y) < Math.min(candidate.size, other.size) * 0.4))
        unique.push(candidate);
    }

    let best: Point[] | null = null;
    let bestInliers = 0;
    for (const anchor of unique) {
      const group = unique.filter(candidate =>
        candidate.size > anchor.size * 0.55 && candidate.size < anchor.size * 1.8
        && Math.hypot(candidate.x - anchor.x, candidate.y - anchor.y) < anchor.size * 5.5);
      if (group.length < 8)
        continue;
      const xs = group.map(p => p.x);
      const ys = group.map(p => p.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      if (maxX - minX < anchor.size * 2 || maxY - minY < anchor.size * 2
        || maxX - minX > anchor.size * 5 || maxY - minY > anchor.size * 5) {
        continue;
      }
      const grid = new Map<number, Candidate>();
      for (const point of group) {
        const col = Math.round(3 * (point.x - minX) / (maxX - minX));
        const row = Math.round(3 * (point.y - minY) / (maxY - minY));
        const key = row * 4 + col;
        const previous = grid.get(key);
        if (!previous || point.area > previous.area)
          grid.set(key, point);
      }
      if (grid.size < 8 || grid.size <= bestInliers)
        continue;
      const from: number[] = [];
      const to: number[] = [];
      for (const [key, point] of grid) {
        from.push(key % 4, Math.floor(key / 4));
        to.push(point.x, point.y);
      }
      const srcPoints = cv.matFromArray(grid.size, 1, cv.CV_32FC2, from);
      const dstPoints = cv.matFromArray(grid.size, 1, cv.CV_32FC2, to);
      const inliers = new cv.Mat();
      const transform = cv.findHomography(srcPoints, dstPoints, cv.RANSAC, anchor.size * 0.3, inliers);
      try {
        if (transform.empty())
          continue;
        const count = cv.countNonZero(inliers);
        if (count < 8 || count <= bestInliers)
          continue;
        const m = transform.data64F as Float64Array;
        const points = [[-0.5, -0.5], [3.5, -0.5], [3.5, 3.5], [-0.5, 3.5]].map(([x, y]) => {
          const denominator = m[6]! * x! + m[7]! * y! + m[8]!;
          return {
            x: (m[0]! * x! + m[1]! * y! + m[2]!) / denominator / scale,
            y: (m[3]! * x! + m[4]! * y! + m[5]!) / denominator / scale,
          };
        });
        if (points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)
          || p.x < 0 || p.y < 0 || p.x >= source.width || p.y >= source.height)) {
          continue;
        }
        best = points;
        bestInliers = count;
      }
      finally {
        srcPoints.delete();
        dstPoints.delete();
        inliers.delete();
        transform.delete();
      }
      if (bestInliers === 16)
        break;
    }
    return best;
  }
  finally {
    src.delete();
    gray.delete();
    blur.delete();
    threshold.delete();
    contours.delete();
    hierarchy.delete();
  }
}
