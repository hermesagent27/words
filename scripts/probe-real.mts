/* eslint-disable no-console, node/prefer-global/buffer */
// Real-image OCR verification: threshold bright tiles (TILE_MIN=205), close
// with a kernel sized to tile-gaps, find the board's bright blob, fit the
// quad by hull-of-points + approxPolyDP escalating epsilon / minAreaRect
// fallback, warp to 700, OCR each cell with Tesseract PSM 10, assert the
// expected WORU/RUNT/OORV/TPEG board.
import cvImport from "@techstark/opencv-js";
import sharp from "sharp";
import { readdir } from "node:fs/promises";
import { createWorker } from "tesseract.js";

const cv = await (cvImport.default ?? cvImport);
const WORK_WIDTH = 640;
const WARP_SIZE = 700;
const TILE_MIN = 205;
const INK_MAX = 100;

// Tile gaps are ~14% of pitch; at 3-inch distance a tile is ~90px in the
// working frame. CLOSE with a diameter just under the gap so tiles don't
// merge but letter pinholes in each tile heal.
const CLOSE_FRAC_OF_TILE = 0.15;

const worker = await createWorker("eng", 1, { tessedit_pageseg_mode: "10" });
await worker.setVariable?.("tessedit_char_whitelist", "ABCDEFGHIJKLMNOPQRSTUVWXYZ");

async function detect(src: any) {
  const W = src.cols, H = src.rows;
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGB2GRAY);
  const bright = new cv.Mat();
  cv.threshold(gray, bright, TILE_MIN, 255, cv.THRESH_BINARY);

  // Estimate tile pitch: try close kernels 5..25 until the largest contour
  // has area in a plausible board window (2-40% of frame).
  let chosen: any = null, chosenQuad: Array<{ x: number; y: number }> | null = null;
  for (const closeK of [5, 9, 13, 17, 21, 25]) {
    const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(closeK, closeK));
    const cl = new cv.Mat();
    cv.morphologyEx(bright, cl, cv.MORPH_CLOSE, kernel);
    kernel.delete();

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(cl, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    // Keep contours with area >= 0.5% of frame, ranked by area
    const cand = [];
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area >= W * H * 0.005) cand.push({ cnt, area });
      else cnt.delete();
    }
    contours.delete();
    hierarchy.delete();
    cand.sort((a, b) => b.area - a.area);
    // For each candidate, try fitting quad
    for (const { cnt, area } of cand) {
      const quad = fitQuad(cnt, area);
      if (quad) {
        chosenQuad = quad;
        for (const o of cand) o.cnt.delete();
        break;
      }
      cnt.delete();
    }
    if (chosenQuad) { cl.delete(); break; }
    cl.delete();
  }
  bright.delete();
  if (!chosenQuad) { gray.delete(); return null; }

  return { quad: chosenQuad, gray };
}

function fitQuad(cnt: any, area: number) {
  const peri = cv.arcLength(cnt, true);
  for (const eps of [0.01, 0.02, 0.03, 0.04]) {
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, eps * peri, true);
    if (approx.rows === 4) {
      const d = approx.data32S;
      const pts = [
        { x: d[0]!, y: d[1]! },
        { x: d[2]!, y: d[3]! },
        { x: d[4]!, y: d[5]! },
        { x: d[6]!, y: d[7]! },
      ];
      approx.delete();
      return pts;
    }
    approx.delete();
  }
  const rr = cv.minAreaRect(cnt);
  const vtx = cv.RotatedRect.points(rr);
  return vtx.map((p: { x: number; y: number }) => ({ x: p.x, y: p.y }));
}

function orderQuad(q: Array<{ x: number; y: number }>) {
  const pts = [...q].sort((a, b) => a.y - b.y);
  const top = pts.slice(0, 2).sort((a, b) => a.x - b.x);
  const bottom = pts.slice(2, 4).sort((a, b) => a.x - b.x);
  return [top[0]!, top[1]!, bottom[1]!, bottom[0]!];
}

async function ocrCell(canvasEl: any): Promise<string> {
  const { data } = await worker.recognize(canvasEl);
  const text = (data.text || "").trim().toUpperCase();
  const m = text.match(/[A-Z]/);
  return m && (data.confidence ?? 0) >= 55 ? m[0] : "";
}

function warpAndOcr(gray: any, quad: Array<{ x: number; y: number }>): Promise<string[]> {
  return (async () => {
    const ordered = orderQuad(quad);
  if (process.env.DEBUG_PROBE) {
    const s = (a: any, b: any) => Math.hypot(b.x - a.x, b.y - a.y);
    console.error(`  quad: tl(${ordered[0].x.toFixed(0)},${ordered[0].y.toFixed(0)}) tr(${ordered[1].x.toFixed(0)},${ordered[1].y.toFixed(0)}) br(${ordered[2].x.toFixed(0)},${ordered[2].y.toFixed(0)}) bl(${ordered[3].x.toFixed(0)},${ordered[3].y.toFixed(0)}) sides=${s(ordered[0], ordered[1]).toFixed(0)},${s(ordered[1], ordered[2]).toFixed(0)},${s(ordered[2], ordered[3]).toFixed(0)},${s(ordered[3], ordered[0]).toFixed(0)}`);
  }
    const srcSide = Math.hypot(ordered[1].x - ordered[0].x, ordered[1].y - ordered[0].y);
    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, ordered.flatMap(p => [p.x, p.y]));
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, WARP_SIZE, 0, WARP_SIZE, WARP_SIZE, 0, WARP_SIZE]);
    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    const dst = new cv.Mat();
    cv.warpPerspective(gray, dst, M, new cv.Size(WARP_SIZE, WARP_SIZE), srcSide < WARP_SIZE ? cv.INTER_CUBIC : cv.INTER_AREA);
    srcTri.delete(); dstTri.delete(); M.delete();

    const letters: string[] = [];
    const cellSize = WARP_SIZE / 4;
    const inset = Math.floor(cellSize * 0.18);
    const inner = cellSize - inset * 2;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const rect = new cv.Rect(c * cellSize + inset, r * cellSize + inset, inner, inner);
        const cell = dst.roi(rect);
        const bin = new cv.Mat();
        cv.threshold(cell, bin, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
        cell.delete();
        const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2, 2));
        const opened = new cv.Mat();
        cv.morphologyEx(bin, opened, cv.MORPH_OPEN, k);
        bin.delete(); k.delete();
        const labels = new cv.Mat();
        const stats = new cv.Mat();
        const cents = new cv.Mat();
        const n = cv.connectedComponentsWithStats(opened, labels, stats, cents, 8, cv.CV_32S);
        opened.delete();
        const minArea = inner * inner * 0.03, maxArea = inner * inner * 0.7;
        const minDim = inner * 0.15, maxDim = inner * 0.9;
        const centerTol = inner * 0.35;
        let best: any = null;
        for (let i = 1; i < n; i++) {
          const w = stats.intPtr(i, 2)[0], h = stats.intPtr(i, 3)[0], area = stats.intPtr(i, 4)[0];
          const cx = cents.doublePtr(i, 0)[0], cy = cents.doublePtr(i, 1)[0];
          if (area < minArea || area > maxArea) continue;
          if (w < minDim || h < minDim || w > maxDim || h > maxDim) continue;
          if (Math.hypot(cx - inner / 2, cy - inner / 2) > centerTol) continue;
          if (!best || Math.hypot(cx - inner / 2, cy - inner / 2) < Math.hypot(best.cx - inner / 2, best.cy - inner / 2))
            best = { x: stats.intPtr(i, 0)[0], y: stats.intPtr(i, 1)[0], w, h, cx, cy };
        }
        labels.delete(); stats.delete(); cents.delete();
        rect.delete?.();
        if (!best) { letters.push(""); if (process.env.DEBUG_PROBE) console.error(`  cell r${r}c${c}: no blob`); continue; }
        if (process.env.DEBUG_PROBE) console.error(`  cell r${r}c${c}: blob ${best.w}x${best.h} area=${(best.w * best.h)} center=(${best.cx.toFixed(1)},${best.cy.toFixed(1)})`);
        const pad = Math.floor(inner * 0.08);
        const bx = Math.max(0, c * cellSize + inset + best.x - pad);
        const by = Math.max(0, r * cellSize + inset + best.y - pad);
        const bw = Math.min(dst.cols - bx, best.w + pad * 2);
        const bh = Math.min(dst.rows - by, best.h + pad * 2);
        const blobRect = new cv.Rect(bx, by, bw, bh);
        const blob = dst.roi(blobRect);
        // to canvas via sharp PNG -> tesseract accepts canvas; easier: write raw PNG buffer then recognize buffer
        const pngBuf = await sharp(Buffer.from(blob.data as Uint8Array), { raw: { width: bw, height: bh, channels: 1 } })
          .resize(bw * 3, bh * 3, { kernel: sharp.kernel.cubic })
          .png().toBuffer();
        blob.delete(); blobRect.delete?.();
        const { data } = await worker.recognize(pngBuf as any);
        const text = (data.text || "").trim().toUpperCase();
        const m = text.match(/[A-Z]/);
        letters.push(m && (data.confidence ?? 0) >= 55 ? m[0] : "");
      }
    }
    dst.delete();
    return letters;
  })();
}

const dir = "/tmp/board/";
const EXPECTED = "WORURUNTOORVTPEG";
let pass = 0;
for (const f of (await readdir(dir)).filter(f => f.endsWith(".jpeg")).sort()) {
  const { data, info } = await sharp(dir + f).rotate().resize(WORK_WIDTH, null).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const src = cv.matFromArray(info.height, info.width, cv.CV_8UC3, new Uint8Array(data.buffer, data.byteOffset, data.length));
  const det = await detect(src);
  if (!det) { console.log(`${f}: NO DETECT`); src.delete(); continue; }
  const letters = (await warpAndOcr(det.gray, det.quad)).join("");
  det.gray.delete();
  src.delete();
  const reads = letters.split("").filter(Boolean).length;
  const ok = letters === EXPECTED;
  if (ok) pass++;
  console.log(`${f}: reads=${reads}/16 ${ok ? "OK  " : "FAIL"} | ${letters || "(none)"}`);
}
console.log(`\n${pass}/8 exact-match the test board`);
process.exit(pass === 8 ? 0 : 1);
