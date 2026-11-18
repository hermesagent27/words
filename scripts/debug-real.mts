/* eslint-disable no-console, node/prefer-global/buffer */
// Dump intermediate masks from detectQuadFromTiles on one real photo for diagnosis.
import cvImport from "@techstark/opencv-js";
import sharp from "sharp";

const cv = await (cvImport.default ?? cvImport);
const WORK_WIDTH = 640;
const TILE_MIN = 150;
const CLOSE_FRAC = 0.03;

const path = process.argv[2] ?? "/tmp/img_9d927ccc2ed1.jpeg";
const { data, info } = await sharp(path).rotate().resize(WORK_WIDTH, null).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const src = cv.matFromArray(info.height, info.width, cv.CV_8UC3, new Uint8Array(data.buffer, data.byteOffset, data.length));
const W = src.cols, H = src.rows;
console.log("work size", W, H, "total", W * H);

const gray = new cv.Mat();
cv.cvtColor(src, gray, cv.COLOR_RGB2GRAY);

const bright = new cv.Mat();
cv.threshold(gray, bright, TILE_MIN, 255, cv.THRESH_BINARY);
console.log("bright px frac:", cv.countNonZero(bright) / (W * H));

const closeK = Math.max(3, Math.round(Math.min(W, H) * CLOSE_FRAC) | 1);
const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(closeK, closeK));
const closed = new cv.Mat();
cv.morphologyEx(bright, closed, cv.MORPH_CLOSE, kernel);
console.log("closeK", closeK, "closed px frac:", cv.countNonZero(closed) / (W * H));

const contours = new cv.MatVector();
const hierarchy = new cv.Mat();
cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
const minBlobArea = Math.max(100, W * H * 0.001);
console.log("contours:", contours.size(), "minBlobArea:", minBlobArea.toFixed(0));
const rows: string[] = [];
for (let i = 0; i < contours.size(); i++) {
  const cnt = contours.get(i);
  const area = cv.contourArea(cnt);
  if (area < minBlobArea) { cnt.delete(); continue; }
  const r = cv.boundingRect(cnt);
  rows.push(`  area=${area.toFixed(0).padStart(7)} bbox=${r.x},${r.y} ${r.width}x${r.height} side=${Math.sqrt(area).toFixed(0)}`);
  if (rows.length > 25) { cnt.delete(); break; }
  cnt.delete();
}
console.log(rows.join("\n"));

// Also check: what gray value are the tiles? Sample histogram percentiles of gray.
const hist = new cv.Mat();
const imgVec = new cv.MatVector();
imgVec.push_back(gray);
cv.calcHist(imgVec, [0], new cv.Mat(), hist, [256], [0, 256]);
let cum = 0;
const totalPx = W * H;
const pcts = [50, 60, 70, 80, 85, 90, 95, 99];
const out: string[] = [];
for (let i = 0; i < 256; i++) {
  cum += hist.floatPtr(i, 0)[0];
  const p = (cum / totalPx) * 100;
  if (pcts.length && p >= pcts[0]!) out.push(`p${pcts.shift()}=${i}`);
}
console.log("gray percentiles:", out.join(" "));
