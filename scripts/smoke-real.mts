/* eslint-disable no-console, node/prefer-global/buffer */
// Real-image smoke: run the PRODUCTION detection code (detectQuadFromTiles
// from useOcr.ts) against the 8 real board photos in test/fixtures/board/,
// warp to the production WARP_SIZE, and assert the quad looks square and the
// warped board contains letter-like ink. No synthetic canvases, no
// reimplemented algorithms.
import cvImport from "@techstark/opencv-js";
import sharp from "sharp";
import { readdir } from "node:fs/promises";

import { detectQuadFromTiles, WORK_WIDTH, WARP_SIZE } from "../app/composables/useOcr";

const cv = await (cvImport.default ?? cvImport);

const EXPECTED = ["W", "O", "R", "U", "R", "U", "N", "T", "O", "O", "R", "V", "T", "P", "E", "G"];

async function loadWorkMat(path: string) {
  // Downscale exactly like the app does (fixed WORK_WIDTH) and honor EXIF.
  const { data, info } = await sharp(path)
    .rotate()
    .resize(WORK_WIDTH, null, { kernel: sharp.kernel.lanczos3 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return cv.matFromArray(info.height, info.width, cv.CV_8UC3, new Uint8Array(data.buffer, data.byteOffset, data.length));
}

function warpToBoard(src: any, quad: Array<{ x: number; y: number }>) {
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap(p => [p.x, p.y]));
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, WARP_SIZE, 0, WARP_SIZE, WARP_SIZE, 0, WARP_SIZE]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGB2GRAY);
  const dst = new cv.Mat();
  const srcSide = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
  cv.warpPerspective(gray, dst, M, new cv.Size(WARP_SIZE, WARP_SIZE), srcSide < WARP_SIZE ? cv.INTER_CUBIC : cv.INTER_AREA);
  srcTri.delete();
  dstTri.delete();
  M.delete();
  gray.delete();
  return dst;
}

// Per-cell ink geometry (mirrors extractCellLetter pre-OCR): how many cells
// have a plausible dark glyph blob. Real boards show 16/16 with the ink
// letter plus, for most cells, scoring dots the cell crop keeps but the
// center-gate rejects.
function cellBlobReport(warped: any) {
  const cellSize = WARP_SIZE / 4;
  const inset = Math.floor(cellSize * 0.18);
  const inner = cellSize - inset * 2;
  let withBlob = 0;
  const blobs: any[] = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const rect = new cv.Rect(c * cellSize + inset, r * cellSize + inset, inner, inner);
      const cell = warped.roi(rect);
      const bin = new cv.Mat();
      cv.threshold(cell, bin, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
      cell.delete();
      const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2, 2));
      const opened = new cv.Mat();
      cv.morphologyEx(bin, opened, cv.MORPH_OPEN, k);
      bin.delete();
      k.delete();
      const labels = new cv.Mat();
      const stats = new cv.Mat();
      const cents = new cv.Mat();
      const n = cv.connectedComponentsWithStats(opened, labels, stats, cents, 8, cv.CV_32S);
      opened.delete();
      const minArea = inner * inner * 0.03;
      const maxArea = inner * inner * 0.7;
      const minDim = inner * 0.15;
      const maxDim = inner * 0.9;
      const centerTol = inner * 0.35;
      let found = null as null | { w: number; h: number; area: number };
      for (let i = 1; i < n; i++) {
        const w = stats.intPtr(i, 2)[0];
        const h = stats.intPtr(i, 3)[0];
        const area = stats.intPtr(i, 4)[0];
        const cx = cents.doublePtr(i, 0)[0];
        const cy = cents.doublePtr(i, 1)[0];
        if (area < minArea || area > maxArea) continue;
        if (w < minDim || h < minDim || w > maxDim || h > maxDim) continue;
        if (Math.hypot(cx - inner / 2, cy - inner / 2) > centerTol) continue;
        found = { w, h, area };
        break;
      }
      labels.delete();
      stats.delete();
      cents.delete();
      rect.delete?.();
      if (found) withBlob++;
      blobs.push(found);
    }
  }
  return { withBlob, blobs };
}

const dir = new URL("../test/fixtures/board/", import.meta.url).pathname;
const files = (await readdir(dir)).filter(f => f.endsWith(".jpeg")).sort();
if (files.length !== 8)
  throw new Error(`expected 8 fixtures, found ${files.length}`);

let pass = 0;
for (const f of files) {
  const src = await loadWorkMat(dir + f);
  const quad = detectQuadFromTiles(cv, src);
  if (!quad) {
    console.log(`${f}: NO QUAD`);
    continue;
  }
  const side = (a: any, b: any) => Math.hypot(b.x - a.x, b.y - a.y);
  const s = [side(quad[0], quad[1]), side(quad[1], quad[2]), side(quad[2], quad[3]), side(quad[3], quad[0])];
  const ratio = Math.max(...s) / Math.min(...s);
  const warped = warpToBoard(src, quad);
  const rep = cellBlobReport(warped);
  warped.delete();
  src.delete();
  const ok = ratio < 1.6 && rep.withBlob >= 12;
  if (ok) pass++;
  console.log(`${f}: quad side ${Math.min(...s).toFixed(0)}-${Math.max(...s).toFixed(0)} ratio ${ratio.toFixed(2)}, cells-with-glyph ${rep.withBlob}/16 -> ${ok ? "OK" : "FAIL"}`);
}
console.log(`\n${pass}/8 images pass quad+ink gates (OCR assertion comes next)`);
process.exit(pass === 8 ? 0 : 1);
