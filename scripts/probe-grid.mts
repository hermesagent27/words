/* eslint-disable no-console, node/prefer-global/buffer */
// Cell-grid detector: at TILE_MIN=205 the 16 tiles stay separate as
// rounded-rects, while their ink dots/letters punch holes in the bright
// mask. Detect tile blobs, fit the 4x4 grid directly via a Hough-like
// combinatorial approach:
//   1. Take every blob with plausible tile size for its frame position.
//   2. For each pair whose centers look adjacent (dx<1.4*side, dy<0.3*side
//      or vice versa), record an "edge" with dx,dy.
//   3. The dominant edge vector is the tile pitch. Use it to cluster tiles
//      into rows and columns. A board has exactly 4 rows x 4 cols.
//   4. From the tile grid, the quad corners are the outer corners of the
//      outer tiles' bboxes, fitted via convex hull.
import cvImport from "@techstark/opencv-js";
import sharp from "sharp";
import { readdir } from "node:fs/promises";

const cv = await (cvImport.default ?? cvImport);
const WORK_WIDTH = 640;
const TILE_MIN = 205;
const INK_MAX = 100;

type Pt = { x: number; y: number };

function orderQuad(q: Pt[]): Pt[] {
  const pts = [...q].sort((a, b) => a.y - b.y);
  const top = pts.slice(0, 2).sort((a, b) => a.x - b.x);
  const bottom = pts.slice(2, 4).sort((a, b) => a.x - b.x);
  return [top[0]!, top[1]!, bottom[1]!, bottom[0]!];
}

function detectBoardDetect(src: any, debug = false): Pt[] | null {
  const W = src.cols, H = src.rows, total = W * H;
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGB2GRAY);
  const bright = new cv.Mat();
  cv.threshold(gray, bright, TILE_MIN, 255, cv.THRESH_BINARY);

  // CLOSE merges the 16 tiles into ONE board blob. Sized to the tile pitch
  // (~30-110px at these distances in the 640-wide working frame), so the
  // close kernel bridges inter-tile gaps (~14% of pitch) without merging
  // the whole phone screen. Try a spread of kernels and keep the one that
  // yields the biggest sane board blob.
  let bestCnt: any = null;
  let bestArea = 0;
  let bestCloseK = 0;
  for (const closeK of [3, 7, 13, 21, 31]) {
    const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(closeK, closeK));
    const cl = new cv.Mat();
    cv.morphologyEx(bright, cl, cv.MORPH_CLOSE, kernel);
    kernel.delete();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(cl, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < total * 0.01 || area > total * 0.5) { cnt.delete(); continue; }
      const r = cv.boundingRect(cnt);
      const side = Math.max(r.width, r.height) / Math.min(r.width, r.height);
      if (side > 2.2) { cnt.delete(); continue; }
      if (area > bestArea) { bestArea = area; bestCnt = cnt; bestCloseK = closeK; }
      else cnt.delete();
    }
    contours.delete();
    hierarchy.delete();
    cl.delete();
  }
  bright.delete();
  if (!bestCnt) { gray.delete(); return null; }
  if (debug) console.error(`  board blob area=${bestArea.toFixed(0)} (${(bestArea / total * 100).toFixed(1)}%) closeK=${bestCloseK}`);

  // Fit quad around the merged board blob
  const peri = cv.arcLength(bestCnt, true);
  let quadPts: Pt[] = [];
  for (const eps of [0.005, 0.01, 0.015, 0.02, 0.03, 0.04]) {
    const approx = new cv.Mat();
    cv.approxPolyDP(bestCnt, approx, eps * peri, true);
    if (approx.rows === 4) {
      const d = approx.data32S;
      quadPts = [
        { x: d[0]!, y: d[1]! },
        { x: d[2]!, y: d[3]! },
        { x: d[4]!, y: d[5]! },
        { x: d[6]!, y: d[7]! },
      ];
      approx.delete();
      break;
    }
    approx.delete();
  }
  if (quadPts.length !== 4) {
    const rr = cv.minAreaRect(bestCnt);
    quadPts = cv.RotatedRect.points(rr).map((p: Pt) => ({ x: p.x, y: p.y }));
  }
  bestCnt.delete();
  const ordered = orderQuad(quadPts);

  const s = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
  const sides = [s(ordered[0], ordered[1]), s(ordered[1], ordered[2]), s(ordered[2], ordered[3]), s(ordered[3], ordered[0])];
  const minS = Math.min(...sides), maxS = Math.max(...sides);
  if (debug) console.error(`  quad sides=${sides.map(s => s.toFixed(0)).join("/")}`);

  // Ink verify
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, ordered.flatMap(p => [p.x, p.y]));
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, 200, 0, 200, 200, 0, 200]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const w = new cv.Mat();
  cv.warpPerspective(gray, w, M, new cv.Size(200, 200), cv.INTER_AREA);
  srcTri.delete(); dstTri.delete(); M.delete();
  const ink = new cv.Mat();
  cv.threshold(w, ink, INK_MAX, 255, cv.THRESH_BINARY_INV);
  w.delete();
  const inkFrac = cv.countNonZero(ink) / (200 * 200);
  ink.delete();
  if (debug) console.error(`  ink=${(inkFrac * 100).toFixed(2)}%`);

  gray.delete();
  if (maxS < 50 || maxS > minS * 3.0 || maxS * maxS < total * 0.005) return null;
  if (inkFrac < 0.003 || inkFrac > 0.35) return null;
  return ordered;
}

const dir = "/tmp/board/";
for (const f of (await readdir(dir)).filter(f => f.endsWith(".jpeg")).sort()) {
  const { data, info } = await sharp(dir + f).rotate().resize(WORK_WIDTH, null).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const src = cv.matFromArray(info.height, info.width, cv.CV_8UC3, new Uint8Array(data.buffer, data.byteOffset, data.length));
  const quad = detectBoardDetect(src, true);
  src.delete();
  console.log(`${f}: ${quad ? `sides=${[0, 1, 2, 3].map(i => Math.hypot(quad[(i + 1) % 4]!.x - quad[i]!.x, quad[(i + 1) % 4]!.y - quad[i]!.y).toFixed(0)).join("/")}` : "NO QUAD"}`);
}
