/* eslint-disable no-console, node/prefer-global/buffer */
// Sample tile brightness at expected tile pixels for each real photo, choosing
// a threshold that separates tiles from the blue app background.
import cvImport from "@techstark/opencv-js";
import sharp from "sharp";
import { readdir } from "node:fs/promises";

const cv = await (cvImport.default ?? cvImport);
const WORK_WIDTH = 640;
const dir = "/tmp/board/";
const files = (await readdir(dir)).filter(f => f.endsWith(".jpeg")).sort();

for (const f of files) {
  const { data, info } = await sharp(dir + f).rotate().resize(WORK_WIDTH, null).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const src = cv.matFromArray(info.height, info.width, cv.CV_8UC3, new Uint8Array(data.buffer, data.byteOffset, data.length));
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGB2GRAY);
  const W = src.cols, H = src.rows, total = W * H;
  // Compute percentiles manually from a sorted copy
  const copy = new Uint8Array(gray.data as Uint8Array).sort();
  const p = (q: number) => copy[Math.min(total - 1, Math.floor(q * total))];
  // Find the largest "valley": threshold such that pixels above it collapse
  // to a single major cluster the size of the board (5-30% of frame)
  let bestT = 0;
  let bestScore = -1;
  for (let t = 140; t <= 240; t += 5) {
    const above = total - (copy.findIndex?.(v => v >= t) ?? 0);
    const idx = copy.findIndex((v: number) => v >= t);
    const aboveCount = idx === -1 ? 0 : total - idx;
    const frac = aboveCount / total;
    // Board should be somewhere between 2% (far) and 40% (close) of frame
    if (frac < 0.02 || frac > 0.5) continue;
    // Score: prefer thresholds where the count drops sharply (plateau = inside tile brightness)
    const prevIdx = copy.findIndex((v: number) => v >= t - 5);
    const prev = prevIdx === -1 ? 0 : total - prevIdx;
    const drop = prev - aboveCount;
    const score = drop / total;
    if (score > bestScore) { bestScore = score; bestT = t; }
  }
  console.log(`${f}: gray percentiles p50=${p(0.5)} p70=${p(0.7)} p85=${p(0.85)} p92=${p(0.92)} p97=${p(0.97)} max=${copy[total - 1]} | sharp-drop t=${bestT} fracAbove est.`);
  gray.delete();
  src.delete();
}
