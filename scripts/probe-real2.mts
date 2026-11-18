/* eslint-disable no-console, node/prefer-global/buffer */
// New detector tuned to the REAL game board:
//  - TILE_MIN=205: tiles are the only surface above 205 across all 8 photos
//    (blue app background tops out ~200; jeans/fingers/UI lower).
//  - No CLOSE: tiles merge into ONE blob because gaps (blue) are under the
//    threshold; letter holes punch through but stay small.
//  - Blob filter: accept blobs whose area is 1-45% of frame and whose side
//    ratio is <= 2:1 (the board is roughly square in working frame).
//  - Quad fit: convexHull -> approxPolyDP escalating epsilon -> minAreaRect.
//  - Ink verification: warp quad to 200x200, fixed INK_MAX=100 INV, accept
//    0.4%-30%. Letters+dots punch 1-4%.
import cvImport from "@techstark/opencv-js";
import sharp from "sharp";
import { readdir } from "node:fs/promises";

const cv = await (cvImport.default ?? cvImport);
const WORK_WIDTH = 640;
const TILE_MIN = 210;
const INK_MAX = 100;

type Pt = { x: number; y: number };

function orderQuad(q: Pt[]): Pt[] {
  const pts = [...q].sort((a, b) => a.y - b.y);
  const top = pts.slice(0, 2).sort((a, b) => a.x - b.x);
  const bottom = pts.slice(2, 4).sort((a, b) => a.x - b.x);
  return [top[0]!, top[1]!, bottom[1]!, bottom[0]!];
}

function fitQuadFromHull(gray: any, contour: any): Pt[] | null {
  const hull = new cv.Mat();
  cv.convexHull(contour, hull, false, true);
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
  return quadPts;
}

export function detectQuad(src: any, debug = false): Pt[] | null {
  const W = src.cols, H = src.rows, total = W * H;
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGB2GRAY);
  const bright = new cv.Mat();
  cv.threshold(gray, bright, TILE_MIN, 255, cv.THRESH_BINARY);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(bright, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  type Cand = { cnt: any; area: number };
  const cands: Cand[] = [];
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    if (area < total * 0.0002) { // one far tile ~ 20x20 = 400px
      cnt.delete();
      continue;
    }
    cands.push({ cnt, area });
  }
  contours.delete();
  hierarchy.delete();
  bright.delete();
  cands.sort((a, b) => b.area - a.area);
  if (debug) console.error(`  cands: ${cands.slice(0, 20).map(c => c.area.toFixed(0)).join(",")}`);

  // First try single-blob boards (tiles merged at extreme close range or
  // after specular merge). Then try cluster flood-fill on the tile list.
  type Blob = { cnt: any; area: number; cx: number; cy: number; side: number; r: { x: number; y: number; width: number; height: number } };
  const blobs: Blob[] = cands.map(c => {
    const r = cv.boundingRect(c.cnt);
    return { cnt: c.cnt, area: c.area, cx: r.x + r.width / 2, cy: r.y + r.height / 2, side: Math.sqrt(c.area), r };
  });

  // Cluster flood-fill: seed = largest blob, then absorb every blob whose
  // center lies within reach from ANY member's CENTER-BOX (bbox inflated by
  // one tile pitch). This is the committed algorithm from the skill.
  // Cluster flood-fill with SIZE-GATED absorption: only absorb blobs whose
  // area is within 4x of the current member median. Tiles at the same
  // distance have near-identical area; background chunks and UI buttons do
  // not, so they can't chain the cluster outward.
  const seed = blobs[0]!;
  const members: Blob[] = [seed];
  const used = new Set<Blob>([seed]);
  while (true) {
    const areas = members.map(m => m.area).sort((a, b) => a - b);
    const medArea = areas[Math.floor(areas.length / 2)]!;
    const pitchEst = Math.max(...members.map(m => m.side)) / 0.86;
    const reach = pitchEst * 1.05; // adjacent tile center ≈ 1.0 pitch; reject anything farther
    let grew = false;
    for (const b of blobs) {
      if (used.has(b)) continue;
      if (b.area > medArea * 6 || b.area < medArea / 6) continue; // loose size sanity (reject phone-screen slab)
      if (members.some(m => Math.abs(b.cx - m.cx) <= reach && Math.abs(b.cy - m.cy) <= reach)) {
        members.push(b);
        used.add(b);
        grew = true;
      }
    }
    if (!grew) break;
  }
  if (debug) console.error(`  members: ${members.length} areas=${members.map(m => m.area.toFixed(0)).join(",")}`);

  // Combine hull of all member contour points
  const allPts = new cv.Mat();
  let totalPts = 0;
  for (const m of members) totalPts += m.cnt.rows;
  allPts.create(totalPts, 1, cv.CV_32SC2);
  let off = 0;
  for (const m of members) {
    const d = m.cnt.data32S;
    for (let i = 0; i < d.length; i++) allPts.data32S[off + i] = d[i]!;
    off += d.length;
  }
  const hull = new cv.Mat();
  cv.convexHull(allPts, hull, false, true);
  allPts.delete();

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

  // Cluster area check: 16 tiles ≈ 16 x member-side²
  const memberArea = members.reduce((s, m) => s + m.area, 0);
  const ordered = orderQuad(quadPts);
  const sides = [
    Math.hypot(ordered[1].x - ordered[0].x, ordered[1].y - ordered[0].y),
    Math.hypot(ordered[2].x - ordered[1].x, ordered[2].y - ordered[1].y),
    Math.hypot(ordered[3].x - ordered[2].x, ordered[3].y - ordered[2].y),
    Math.hypot(ordered[0].x - ordered[3].x, ordered[0].y - ordered[3].y),
  ];
  const minS = Math.min(...sides), maxS = Math.max(...sides);
  if (debug) console.error(`  cluster sides=${sides.map(s => s.toFixed(0)).join("/")} memberArea=${memberArea.toFixed(0)} members=${members.length}`);
  if (members.length < 12 || maxS > minS * 2 || maxS < 50 || maxS * maxS < total * 0.005) {
    for (const b of blobs) b.cnt.delete();
    gray.delete();
    return null;
  }

  // Ink verify inside quad
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
  for (const b of blobs) b.cnt.delete();
  if (inkFrac < 0.004 || inkFrac > 0.30) { gray.delete(); return null; }
  gray.delete();
  return ordered;
}

const dir = "/tmp/board/";
for (const f of (await readdir(dir)).filter(f => f.endsWith(".jpeg")).sort()) {
  const { data, info } = await sharp(dir + f).rotate().resize(WORK_WIDTH, null).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const src = cv.matFromArray(info.height, info.width, cv.CV_8UC3, new Uint8Array(data.buffer, data.byteOffset, data.length));
  const quad = detectQuad(src, true);
  src.delete();
  console.log(`${f}: ${quad ? `quad sides=${[0, 1, 2, 3].map(i => Math.hypot(quad[(i + 1) % 4]!.x - quad[i]!.x, quad[(i + 1) % 4]!.y - quad[i]!.y).toFixed(0)).join("/")}` : "NO QUAD"}`);
}
