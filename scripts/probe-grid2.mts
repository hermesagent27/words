/* eslint-disable no-console, node/prefer-global/buffer */
// Cell-grid detector v2: identify tile centers, then find the 4x4 grid
// pattern by choosing 4 row-y and 4 col-x positions.
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

function detect(src: any, debug = false): Pt[] | null {
  const W = src.cols, H = src.rows, total = W * H;
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGB2GRAY);
  const bright = new cv.Mat();
  cv.threshold(gray, bright, TILE_MIN, 255, cv.THRESH_BINARY);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(bright, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  type Tile = { cx: number; cy: number; w: number; h: number; area: number };
  const tiles: Tile[] = [];
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    const r = cv.boundingRect(cnt);
    const minDim = Math.min(r.width, r.height);
    const maxDim = Math.max(r.width, r.height);
    cnt.delete();
    // Tile: roughly square, 12-250 px in working frame
    if (minDim < 12 || maxDim > 250) continue;
    if (maxDim / minDim > 1.6) continue;
    if (area < minDim * minDim * 0.5) continue; // not a filled rect
    tiles.push({ cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, h: r.height, area });
  }
  contours.delete();
  hierarchy.delete();
  bright.delete();
  if (debug) console.error(`  tiles kept: ${tiles.length}`);

  if (tiles.length < 12) { gray.delete(); return null; }

  // Estimate pitch from tile sizes. Tiles on the same board are uniform;
  // pick the median side of the top quartile (exclude small distractors).
  const sides = tiles.map(t => (t.w + t.h) / 2).sort((a, b) => b - a);
  const topQuartile = sides.slice(0, Math.max(4, sides.length / 4 | 0));
  const medSide = topQuartile[Math.floor(topQuartile.length / 2)]!;
  const pitch = medSide / 0.86;
  if (debug) console.error(`  med side=${medSide.toFixed(1)} pitch=${pitch.toFixed(1)}`);

  // Find 4 row-centers and 4 col-centers with spacing pitch +/- 25%.
  // Candidate x positions: every tile's cx. Bucket close ones.
  const bucketedX: Array<{ x: number; tiles: Tile[] }> = [];
  for (const t of tiles) {
    const b = bucketedX.find(b => Math.abs(b.x - t.cx) < pitch * 0.4);
    if (b) { b.tiles.push(t); b.x = b.tiles.reduce((s, x) => s + x.cx, 0) / b.tiles.length; }
    else bucketedX.push({ x: t.cx, tiles: [t] });
  }
  const bucketedY: Array<{ y: number; tiles: Tile[] }> = [];
  for (const t of tiles) {
    const b = bucketedY.find(b => Math.abs(b.y - t.cy) < pitch * 0.4);
    if (b) { b.tiles.push(t); b.y = b.tiles.reduce((s, x) => s + x.cy, 0) / b.tiles.length; }
    else bucketedY.push({ y: t.cy, tiles: [t] });
  }

  // Find 4 consecutive rows: for each row-bucket, check if +pitch and +2pitch
  // and +3pitch exist. Same for columns.
  function findRuns(buckets: Array<{ y?: number; x?: number; tiles: Tile[] }>, axis: "x" | "y") {
    const sorted = [...buckets].sort((a, b) => ((a as any)[axis] - (b as any)[axis]));
    const runs: Array<{ starts: number[]; score: number }> = [];
    for (let i = 0; i < sorted.length; i++) {
      const c0 = sorted[i]!;
      const p0 = (c0 as any)[axis];
      const positions: number[] = [p0];
      for (let step = 1; step < 4; step++) {
        const target = p0 + step * pitch;
        // Find the closest position to target within tolerance
        let best: number | null = null;
        let bestD = pitch * 0.5;
        for (const b of sorted) {
          const p = (b as any)[axis];
          const d = Math.abs(p - target);
          if (d < bestD) { bestD = d; best = p; }
        }
        if (best === null) break;
        positions.push(best);
      }
      if (positions.length === 4)
        runs.push({ starts: positions, score: pitch * 0.5 - Math.abs(positions[1]! - positions[0]! - pitch) });
    }
    return runs;
  }
  const rowRuns = findRuns(bucketedY, "y");
  const colRuns = findRuns(bucketedX, "x");
  if (debug) console.error(`  rowRuns=${rowRuns.length} colRuns=${colRuns.length}`);
  if (!rowRuns.length || !colRuns.length) { gray.delete(); return null; }

  // For each pair of row-run + col-run, check tile coverage: each of the 16
  // intersection cells should have a tile within half-pitch.
  for (const rr of rowRuns) {
    for (const cr of colRuns) {
      let hits = 0;
      const quadTiles: Tile[][] = [];
      for (const y of rr.starts) {
        const rowT: Tile[] = [];
        for (const x of cr.starts) {
          const t = tiles.find(t => Math.abs(t.cx - x) < pitch * 0.5 && Math.abs(t.cy - y) < pitch * 0.5);
          if (t) { hits++; rowT.push(t); }
          else rowT.push(null as any);
        }
        quadTiles.push(rowT);
      }
      if (debug && hits >= 14) console.error(`  candidate rows=[${rr.starts.map(y => y.toFixed(0)).join(",")}] cols=[${cr.starts.map(x => x.toFixed(0)).join(",")}] hits=${hits}/16`);
      if (hits < 14) continue;

      // Build quad from tile corners (outermost extents of the 16 tiles)
      const r0 = quadTiles[0].filter(Boolean) as Tile[];
      const r3 = quadTiles[3].filter(Boolean) as Tile[];
      const c0 = quadTiles.map(r => r[0]).filter(Boolean) as Tile[];
      const c3 = quadTiles.map(r => r[3]).filter(Boolean) as Tile[];
      const left = c0.map(t => t.cx - t.w / 2);
      const right = c3.map(t => t.cx + t.w / 2);
      const top = r0.map(t => t.cy - t.h / 2);
      const bot = r3.map(t => t.cy + t.h / 2);
      const minX = Math.min(...left), maxX = Math.max(...right);
      const minY = Math.min(...top), maxY = Math.max(...bot);
      // For tilt, build via convex hull of tile corners
      const corners: number[] = [];
      for (const row of quadTiles) for (const t of row) {
        if (!t) continue;
        corners.push(t.cx - t.w / 2, t.cy - t.h / 2, t.cx + t.w / 2, t.cy - t.h / 2, t.cx - t.w / 2, t.cy + t.h / 2, t.cx + t.w / 2, t.cy + t.h / 2);
      }
      const ptsMat = cv.matFromArray(corners.length / 2, 1, cv.CV_32SC2, corners);
      const hull = new cv.Mat();
      cv.convexHull(ptsMat, hull, false, true);
      ptsMat.delete();
      let quadPts: Pt[] = [];
      const peri = cv.arcLength(hull, true);
      for (const eps of [0.005, 0.01, 0.015, 0.02, 0.03, 0.04]) {
        const approx = new cv.Mat();
        cv.approxPolyDP(hull, approx, eps * peri, true);
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
        const rr = cv.minAreaRect(hull);
        quadPts = cv.RotatedRect.points(rr).map((p: Pt) => ({ x: p.x, y: p.y }));
      }
      hull.delete();
      const ordered = orderQuad(quadPts);
      const s = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
      const sideL = [s(ordered[0], ordered[1]), s(ordered[1], ordered[2]), s(ordered[2], ordered[3]), s(ordered[3], ordered[0])];
      const minS = Math.min(...sideL), maxS = Math.max(...sideL);
      if (debug) console.error(`  quad sides=${sideL.map(s => s.toFixed(0)).join("/")}`);
      if (maxS < 60 || maxS > minS * 2.5) continue;

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
      if (inkFrac < 0.003 || inkFrac > 0.35) continue;
      gray.delete();
      return ordered;
    }
  }
  gray.delete();
  return null;
}

const dir = "/tmp/board/";
for (const f of (await readdir(dir)).filter(f => f.endsWith(".jpeg")).sort()) {
  const { data, info } = await sharp(dir + f).rotate().resize(WORK_WIDTH, null).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const src = cv.matFromArray(info.height, info.width, cv.CV_8UC3, new Uint8Array(data.buffer, data.byteOffset, data.length));
  const quad = detect(src, true);
  src.delete();
  console.log(`${f}: ${quad ? `sides=${[0, 1, 2, 3].map(i => Math.hypot(quad[(i + 1) % 4]!.x - quad[i]!.x, quad[(i + 1) % 4]!.y - quad[i]!.y).toFixed(0)).join("/")}` : "NO QUAD"}`);
}
