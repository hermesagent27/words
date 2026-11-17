/* eslint-disable no-console, node/prefer-global/buffer, style/max-statements-per-line */
// Headless smoke: exercise the REAL exported helpers from useOcr.ts
// (buildBlueMask + findBoardQuads) on synthetic frames at five distances.
// Tesseract isn't exercised here (needs a DOM worker); detection + corner
// accuracy is the part that changed, so that's what we verify.
//
//   npx tsx scripts/smoke-detect.mts
//
// Note on the opencv-js import: the module export is promise-like, so it
// must be awaited before use in Node.
import cvImport from "@techstark/opencv-js";
import sharp from "sharp";

// Import the app's actual detection helpers via the relative path. The
// `~/utils/solver` type import inside useOcr.ts is type-only, so tsx strips
// it at transform time and no alias resolution is needed at runtime.
import { buildBlueMask, findBoardQuads, WORK_WIDTH } from "../app/composables/useOcr";

const cv = await (cvImport.default ?? cvImport);
const W = 1280; const H = 960;

async function makeFrame(boardSide: number): Promise<Buffer> {
  // Dark phone-screen background, centered blue square, 4x4 white tiles
  // with a dark letter blob in each tile.
  const frame = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    frame[i * 3] = 18; frame[i * 3 + 1] = 18; frame[i * 3 + 2] = 26;
  }
  const bx = (W - boardSide) / 2 | 0;
  const by = (H - boardSide) / 2 | 0;
  for (let y = by; y < by + boardSide; y++) {
    for (let x = bx; x < bx + boardSide; x++) {
      const o = (y * W + x) * 3;
      frame[o] = 30; frame[o + 1] = 110; frame[o + 2] = 240; // saturated blue
    }
  }
  const cell = boardSide / 4;
  const tileInner = cell * 0.86 | 0;
  const pad = (cell - tileInner) / 2 | 0;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const tx = bx + c * cell + pad;
      const ty = by + r * cell + pad;
      for (let y = ty; y < ty + tileInner; y++) {
        for (let x = tx; x < tx + tileInner; x++) {
          const o = (y * W + x) * 3;
          frame[o] = 245; frame[o + 1] = 245; frame[o + 2] = 245;
        }
      }
      const lx = tx + tileInner * 0.4 | 0; const ly = ty + tileInner * 0.35 | 0;
      const lw = tileInner * 0.2 | 0; const lh = tileInner * 0.3 | 0;
      for (let y = ly; y < ly + lh; y++) {
        for (let x = lx; x < lx + lw; x++) {
          const o = (y * W + x) * 3;
          frame[o] = 10; frame[o + 1] = 10; frame[o + 2] = 10;
        }
      }
    }
  }
  return sharp(frame, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

async function testDistance(boardSide: number, label: string): Promise<boolean> {
  const png = await makeFrame(boardSide);
  const scale = WORK_WIDTH / W;
  const workH = Math.round(H * scale) & ~1;
  const { data } = await sharp(png)
    .resize(WORK_WIDTH, workH)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 3-channel Mat (what cvtColor-free imread-equivalent looks like headless)
  const src = cv.matFromArray(workH, WORK_WIDTH, cv.CV_8UC3, new Uint8Array(data.buffer, data.byteOffset, data.length));
  const mask = buildBlueMask(cv, src);
  const quads = findBoardQuads(cv, mask);
  mask.delete();
  src.delete();

  const expSide = boardSide * scale;
  const expCx = WORK_WIDTH / 2;
  const expCy = workH / 2;
  process.stdout.write(`[${label.padEnd(12)}] raw ${boardSide}px -> expect ${expSide.toFixed(0)}px: `);
  if (!quads.length) {
    console.log("NO QUAD");
    return false;
  }
  const q = quads[0]!;
  const cx = q.reduce((s, p) => s + p.x, 0) / 4;
  const cy = q.reduce((s, p) => s + p.y, 0) / 4;
  const side = Math.hypot(q[1]!.x - q[0]!.x, q[1]!.y - q[0]!.y);
  const sideErr = Math.abs(side - expSide);
  const centerErr = Math.hypot(cx - expCx, cy - expCy);
  const ok = sideErr < 8 && centerErr < 8;
  console.log(`side=${side.toFixed(1)} (err ${sideErr.toFixed(1)}), center err ${centerErr.toFixed(1)}px -> ${ok ? "OK" : "FAIL"}`);
  return ok;
}

let pass = 0;
const cases: Array<[number, string]> = [
  [940, "touching"],
  [900, "very close"],
  [600, "medium"],
  [340, "far"],
  [240, "very far"],
  [160, "across room"],
];
for (const [side, label] of cases) {
  if (await testDistance(side, label))
    pass++;
}
console.log(`\n${pass}/${cases.length} distances lock the board`);
process.exit(pass === cases.length ? 0 : 1);
