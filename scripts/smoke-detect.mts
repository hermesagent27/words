/* eslint-disable no-console, node/prefer-global/buffer, style/max-statements-per-line */
// Prototype harness for tile-first board detection. Draws a synthetic 4x4
// board (white tiles, black letter blobs, dark gap grid, light background
// that is NOT pure white so the tiles remain the brightest object), then
// runs the exported detection helpers from useOcr.ts and asserts corner
// accuracy at several distances and with extra white-ish distractors.
import cvImport from "@techstark/opencv-js";
import sharp from "sharp";

import { detectQuadFromTiles, WORK_WIDTH } from "../app/composables/useOcr";

const cv = await (cvImport.default ?? cvImport);
const W = 1280;
const H = 960;

type FrameOpts = {
  boardSide: number;
  perspectiveSkew?: number; // px shift of top edge to fake perspective
  extraBlobs?: Array<{ x: number; y: number; s: number }>; // dark distractors off-board
  inkScale?: number; // multiplier on letter stroke width (thin ink at distance)
  tileBright?: number; // tile gray level (default 250)
};

async function makeFrame(o: FrameOpts): Promise<Buffer> {
  // Light-gray phone UI background (bright but dimmer than tiles).
  const frame = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    frame[i * 3] = 96;
    frame[i * 3 + 1] = 96;
    frame[i * 3 + 2] = 96;
  }
  const bx = (W - o.boardSide) / 2 | 0;
  const by = (H - o.boardSide) / 2 | 0;
  const skew = o.perspectiveSkew ?? 0;
  const cell = o.boardSide / 4;
  const tileInner = cell * 0.86 | 0;
  const pad = (cell - tileInner) / 2 | 0;
  const tileGray = o.tileBright ?? 250;
  const inkScale = o.inkScale ?? 1;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const cx = bx + c * cell + pad + (r === 0 ? skew : 0); // top row shifted
      const cy = by + r * cell + pad;
      for (let y = cy; y < cy + tileInner; y++) {
        for (let x = cx; x < cx + tileInner; x++) {
          if (x < 0 || x >= W || y < 0 || y >= H)
            continue;
          const off = (y * W + x) * 3;
          frame[off] = tileGray;
          frame[off + 1] = tileGray - 2;
          frame[off + 2] = tileGray - 6; // warm white tile, brighter than bg
        }
      }
      // dark letter-ish blob: two strokes so connected components see an L
      const lx = cx + tileInner * 0.42 | 0;
      const ly = cy + tileInner * 0.28 | 0;
      const lw = Math.max(1, (tileInner * 0.12 * inkScale) | 0);
      const lh = tileInner * 0.44 | 0;
      for (let y = ly; y < ly + lh; y++) {
        for (let x = lx; x < lx + lw; x++) {
          if (x < 0 || x >= W || y < 0 || y >= H)
            continue;
          const off = (y * W + x) * 3;
          frame[off] = 15; frame[off + 1] = 15; frame[off + 2] = 15;
        }
      }
      const fy = ly + lh - 1;
      for (let x = lx; x < lx + tileInner * 0.3; x++) {
        for (let y = fy; y < fy + lw; y++) {
          if (x < 0 || x >= W || y < 0 || y >= H)
            continue;
          const off = (y * W + x) * 3;
          frame[off] = 15; frame[off + 1] = 15; frame[off + 2] = 15;
        }
      }
    }
  }
  // Distractor dark blobs off the board (background UI text, buttons).
  for (const b of o.extraBlobs ?? []) {
    for (let y = b.y; y < b.y + b.s; y++) {
      for (let x = b.x; x < b.x + b.s; x++) {
        if (x < 0 || x >= W || y < 0 || y >= H)
          continue;
        const off = (y * W + x) * 3;
        frame[off] = 20; frame[off + 1] = 20; frame[off + 2] = 20;
      }
    }
  }
  return sharp(frame, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

async function runCase(label: string, o: FrameOpts): Promise<boolean> {
  const png = await makeFrame(o);
  const scale = WORK_WIDTH / W;
  const workH = Math.round(H * scale) & ~1;
  const { data } = await sharp(png).resize(WORK_WIDTH, workH).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const src = cv.matFromArray(workH, WORK_WIDTH, cv.CV_8UC3, new Uint8Array(data.buffer, data.byteOffset, data.length));

  const quad = detectQuadFromTiles(cv, src);
  src.delete();

  const expSide = o.boardSide * scale;
  const expCx = WORK_WIDTH / 2;
  const skewShift = (o.perspectiveSkew ?? 0) * scale / 2;
  const expCy = workH / 2;
  process.stdout.write(`[${label.padEnd(30)}] raw ${o.boardSide}px expect ~${expSide.toFixed(0)}px: `);
  if (!quad) {
    console.log("NO QUAD");
    return false;
  }
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  const side = Math.max(
    Math.hypot(quad[1]!.x - quad[0]!.x, quad[1]!.y - quad[0]!.y),
    Math.hypot(quad[3]!.x - quad[0]!.x, quad[3]!.y - quad[0]!.y),
  );
  const sideErr = Math.abs(side - expSide);
  // Quad corners sit at tile outer edges; center shifts by half the skew.
  const centerErr = Math.hypot(cx - (expCx + skewShift), cy - expCy);
  // Tolerance: 10% of side or 12px, whichever is larger.
  const tol = Math.max(12, expSide * 0.1);
  const ok = sideErr < tol && centerErr < tol;
  console.log(`side=${side.toFixed(1)}(err ${sideErr.toFixed(1)}), centerErr=${centerErr.toFixed(1)} -> ${ok ? "OK" : "FAIL"}`);
  return ok;
}

let pass = 0;
const cases: Array<[string, FrameOpts]> = [
  ["touching 940px", { boardSide: 940 }],
  ["close 700px", { boardSide: 700 }],
  ["medium 500px", { boardSide: 500 }],
  ["far 300px", { boardSide: 300 }],
  ["very far 200px", { boardSide: 200 }],
  ["across room 140px", { boardSide: 140 }],
  ["medium + distractors", { boardSide: 500, extraBlobs: [
    { x: 100, y: 100, s: 30 },
    { x: 1100, y: 200, s: 25 },
    { x: 200, y: 800, s: 40 },
  ] }],
  ["far + distractors", { boardSide: 300, extraBlobs: [
    { x: 60, y: 60, s: 20 },
    { x: 1200, y: 850, s: 30 },
  ] }],
  // Real-world stresses: thin ink (far away), dim tiles, tilt
  ["far 300px thin ink", { boardSide: 300, inkScale: 0.5 }],
  ["far 300px dim tiles", { boardSide: 300, tileBright: 200 }],
  ["medium 500px tilt", { boardSide: 500, perspectiveSkew: 60 }],
  ["far 300px tilt", { boardSide: 300, perspectiveSkew: 30 }],
  ["close 940px tilt", { boardSide: 940, perspectiveSkew: 120 }],
];
for (const [label, o] of cases) {
  if (await runCase(label, o))
    pass++;
}
console.log(`\n${pass}/${cases.length} cases lock`);
process.exit(pass === cases.length ? 0 : 1);
