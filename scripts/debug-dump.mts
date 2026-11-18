/* eslint-disable no-console, node/prefer-global/buffer */
// Dump debug PNG artifacts for one photo.
import cvImport from "@techstark/opencv-js";
import sharp from "sharp";
import { writeFile } from "node:fs/promises";

const cv = await (cvImport.default ?? cvImport);
const WORK_WIDTH = 640;

const path = process.argv[2] ?? "/tmp/img_9d927ccc2ed1.jpeg";
const { data, info } = await sharp(path).rotate().resize(WORK_WIDTH, null).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const src = cv.matFromArray(info.height, info.width, cv.CV_8UC3, new Uint8Array(data.buffer, data.byteOffset, data.length));
const W = src.cols, H = src.rows;

const gray = new cv.Mat();
cv.cvtColor(src, gray, cv.COLOR_RGB2GRAY);

async function dumpMat(mat: any, name: string) {
  // Mat (CV_8U) at WxH
  const buf = Buffer.from(mat.data as Uint8Array);
  await writeFile(`/tmp/dbg-${name}.png`, await sharp(buf, { raw: { width: mat.cols, height: mat.rows, channels: 1 } }).png().toBuffer());
  console.log(`/tmp/dbg-${name}.png`);
}

await dumpMat(gray, "gray");

for (const t of [130, 150, 170, 190, 210]) {
  const b = new cv.Mat();
  cv.threshold(gray, b, t, 255, cv.THRESH_BINARY);
  const closeK = Math.max(3, Math.round(Math.min(W, H) * 0.03) | 1);
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(closeK, closeK));
  const cl = new cv.Mat();
  cv.morphologyEx(b, cl, cv.MORPH_CLOSE, kernel);
  await dumpMat(cl, `closed${t}`);
  b.delete(); cl.delete(); kernel.delete();
}
