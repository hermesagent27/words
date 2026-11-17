// app/composables/useOcr.ts
// Loads OpenCV.js + Tesseract.js lazily and reads the 4x4 letter board from
// whatever distance the phone happens to be at.
//
// Detection strategy (tile-first, distance- and backdrop-invariant):
//   The board is the LIGHTEST surface on the screen, and it's a 4x4 grid of
//   bright tiles carrying near-black letter ink. Threshold for the light
//   pixels, close letter-pinholes into one blob per board, and take the
//   largest quad-shaped contour at a plausible board size. A dark-ink
//   density check inside the winning quad rejects bright walls and UI
//   chips. Board size never enters the decision beyond sanity floors, so
//   the phone can sit at any distance.
import type { Tile } from "~/utils/solver";

// ---------------------------------------------------------------
// Pure detection core. Exported so the headless smoke test exercises the
// exact code the app runs (scripts/smoke-detect.mts).
// ---------------------------------------------------------------

export const WORK_WIDTH = 640;
export const WARP_SIZE = 700;

// Grayscale gates. Tiles are the LIGHTEST surface on screen; letters are
// near-black. These are generous on purpose, the geometry checks do the
// real disambiguation.
export const INK_MAX = 100;
export const TILE_MIN = 150;

type Pt = { x: number; y: number };

// Morphological close kernel side, as a fraction of the short frame edge.
// Sized to merge the pinholes dark letters punch into the bright-tile mask
// without bridging across to background elements.
const CLOSE_FRAC = 0.03;

/**
 * Detect the board quad from a working-frame RGB Mat, or null.
 *
 * The board is the LIGHTEST region of the screen and carries near-black
 * letter ink. Threshold for light pixels, close letter holes so each tile
 * block merges into one bright blob, then find the largest quad-shaped
 * contour at a plausible board size. Distractors (the phone's light UI
 * buttons, a wall, a window) fail either the quad check or the ink-density
 * verification inside the winning region.
 */
export function detectQuadFromTiles(
  cv: Record<string, any>,
  src: any,
): Array<Pt> | null {
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGB2GRAY);
  const W = src.cols;
  const H = src.rows;
  const total = W * H;

  // --- Bright-tile mask ---------------------------------------------------
  // Small CLOSE to fill dark-letter pinholes in each bright tile so a tile
  // stays one blob. No open: erodes far boards away.
  const bright = new cv.Mat();
  cv.threshold(gray, bright, TILE_MIN, 255, cv.THRESH_BINARY);
  const closeK = Math.max(3, Math.round(Math.min(W, H) * CLOSE_FRAC) | 1);
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(closeK, closeK));
  const closed = new cv.Mat();
  cv.morphologyEx(bright, closed, cv.MORPH_CLOSE, kernel);
  bright.delete();
  kernel.delete();

  // --- Gather every bright blob of plausible tile/board size --------------
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const minBlobArea = Math.max(100, total * 0.001);
  type Blob = { area: number; cx: number; cy: number; side: number; bx: number; by: number; bw: number; bh: number };
  const blobs: Blob[] = [];
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    if (area >= minBlobArea) {
      const r = cv.boundingRect(cnt);
      blobs.push({
        area,
        cx: r.x + r.width / 2,
        cy: r.y + r.height / 2,
        side: Math.sqrt(area),
        bx: r.x,
        by: r.y,
        bw: r.width,
        bh: r.height,
      });
      r.delete?.();
    }
    cnt.delete();
  }
  contours.delete();
  hierarchy.delete();
  closed.delete();

  if (!blobs.length) {
    gray.delete();
    return null;
  }

  // --- Union blobs that cluster in a board-sized neighborhood ------------
  // Tiles are separated by gap rows/columns the CLOSE kernel could not
  // bridge (extreme close range, thin gaps). Single-shot reach from the
  // seed fails when the seed ends up central and only some tiles fit its
  // radius. Flood-fill instead: start from the seed, absorb every blob
  // inside reach of ANY current member, and let the cluster's pitch
  // estimate tighten as tiles accumulate. The cluster settles when no
  // new blob joins. Tiles occupy ~86% of cell pitch, so center-to-center
  // distance between adjacent tiles is side/0.86; reach of 1.3 pitches
  // from any member catches an adjacent tile while staying well under
  // 2 pitches (a non-board bright object more than a full tile-gap away
  // can never join).
  blobs.sort((a, b) => b.area - a.area);
  const seed = blobs[0]!;
  const members: Blob[] = [seed];
  const used = new Set<Blob>([seed]);
  // Iteratively expand; the cluster's pitch estimate shrinks toward the
  // real one as tile geometry accumulates, which only tightens the gate.
  while (true) {
    const pitchEst = Math.max(...members.map(m => m.side)) / 0.86;
    const reach = pitchEst * 1.3;
    let grew = false;
    for (const b of blobs) {
      if (used.has(b))
        continue;
      if (members.some(m => Math.abs(b.cx - m.cx) <= reach && Math.abs(b.cy - m.cy) <= reach)) {
        members.push(b);
        used.add(b);
        grew = true;
      }
    }
    if (!grew)
      break;
  }
  if (typeof process !== "undefined" && (process as { env?: Record<string, string> }).env?.DEBUG_DQFT)
    console.error(`[dqft] blobs=${blobs.length} seed=(${seed.cx.toFixed(0)},${seed.cy.toFixed(0)}) side=${seed.side.toFixed(1)} members=${members.length} boxes=[${members.slice(0, 4).map(b => `${b.bx},${b.by},${b.bw}x${b.bh}`).join(" | ")}]`);

  // Board bbox from member blob bounding rects.
  const bx0 = Math.min(...members.map(b => b.bx));
  const by0 = Math.min(...members.map(b => b.by));
  const bx1 = Math.max(...members.map(b => b.bx + b.bw));
  const by1 = Math.max(...members.map(b => b.by + b.bh));
  const boardW = bx1 - bx0;
  const boardH = by1 - by0;

  // Squareness + size sanity.
  const minS = Math.min(boardW, boardH);
  const maxS = Math.max(boardW, boardH);
  if (maxS < 50 || maxS > minS * 2 || boardW * boardH < total * 0.005) {
    gray.delete();
    return null;
  }

  // --- Ink verification ---------------------------------------------------
  // Letters cover 1-5% of the board, gaps another 2-4%. Bright walls /
  // UI chips / windows carry ~0% ink inside the union bbox.
  const ix0 = Math.max(0, bx0);
  const iy0 = Math.max(0, by0);
  const ix1 = Math.min(W, bx1);
  const iy1 = Math.min(H, by1);
  const roiRect = new cv.Rect(ix0, iy0, ix1 - ix0, iy1 - iy0);
  const roi = gray.roi(roiRect);
  const ink = new cv.Mat();
  cv.threshold(roi, ink, INK_MAX, 255, cv.THRESH_BINARY_INV);
  roi.delete();
  roiRect.delete?.();
  const inkCount = cv.countNonZero(ink);
  ink.delete();
  const quadArea = (ix1 - ix0) * (iy1 - iy0);
  const inkFrac = inkCount / Math.max(1, quadArea);
  if (inkFrac < 0.004 || inkFrac > 0.3) {
    gray.delete();
    return null;
  }

  // --- Quad corners --------------------------------------------------------
  // Union bbox corners, no padding: the bbox of merged member tiles already
  // spans tile outer edges, and at extreme close range the board can extend
  // past the frame edge so clamping is the only safe pad.
  const tl = { x: Math.max(0, bx0), y: Math.max(0, by0) };
  const tr = { x: Math.min(W - 1, bx1), y: Math.max(0, by0) };
  const br = { x: Math.min(W - 1, bx1), y: Math.min(H - 1, by1) };
  const bl = { x: Math.max(0, bx0), y: Math.min(H - 1, by1) };
  void gray;
  return [tl, tr, br, bl];
}

// ---------------------------------------------------------------
// Lazy library loaders (browser only; Tesseract needs a DOM worker).
// ---------------------------------------------------------------

let cvInstance: unknown = null;
let cvLoading: Promise<unknown> | null = null;

export async function getCv() {
  if (cvInstance)
    return cvInstance;
  if (!cvLoading) {
    cvLoading = import("@techstark/opencv-js").then(async (mod) => {
      const m = (mod as { default?: unknown }).default ?? mod;
      return (m && typeof (m as Promise<unknown>).then === "function") ? await m : m;
    });
  }
  cvInstance = await cvLoading;
  return cvInstance;
}

let tesseractWorker: unknown = null;

async function getTesseract() {
  if (tesseractWorker)
    return tesseractWorker;
  const { createWorker } = await import("tesseract.js");
  tesseractWorker = await createWorker("eng", 1, {
    tessedit_pageseg_mode: "10",
  } as Parameters<typeof createWorker>[2]);
  await (tesseractWorker as { setVariable?: (k: string, v: string) => Promise<void> })
    .setVariable?.("tessedit_char_whitelist", "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  return tesseractWorker;
}

// Minimum OCR confidence (0-100) to accept a letter on a single frame.
const MIN_CONFIDENCE = 55;

export type GridDetectionResult = {
  tiles: Tile[][];
  corners: Array<{ x: number; y: number }>;
  readRatio: number;
  /** fraction of the warped board interior that binarizes dark */
  inkCoverage: number;
};

export function useOcr() {
  const processing = ref(false);
  const error = ref<string | null>(null);

  async function detectGrid(source: HTMLCanvasElement): Promise<GridDetectionResult | null> {
    processing.value = true;
    error.value = null;
    try {
      const cv = (await getCv()) as Record<string, any>;

      // Downscale to WORK_WIDTH; keeps contour cost flat per frame.
      const scale = WORK_WIDTH / source.width;
      const workH = Math.round(source.height * scale) & ~1;
      const work = document.createElement("canvas");
      work.width = WORK_WIDTH;
      work.height = workH;
      work.getContext("2d")!.drawImage(source, 0, 0, WORK_WIDTH, workH);

      const src = cv.imread(work); // RGBA
      // detectQuadFromTiles expects 3-channel RGB; convert once here.
      const rgb = new cv.Mat();
      cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
      src.delete();

      const quad = detectQuadFromTiles(cv, rgb);
      if (!quad) {
        rgb.delete();
        return null;
      }

      // Warp from the WORKING-frame quads; interpolation chosen by whether
      // the board is being upscaled (far) or downscaled (close).
      const srcSide = Math.hypot(quad[1]!.x - quad[0]!.x, quad[1]!.y - quad[0]!.y);
      const dst = new cv.Mat();
      const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap(p => [p.x, p.y]));
      const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0,
        0,
        WARP_SIZE,
        0,
        WARP_SIZE,
        WARP_SIZE,
        0,
        WARP_SIZE,
      ]);
      const M = cv.getPerspectiveTransform(srcTri, dstTri);
      const interp = srcSide < WARP_SIZE ? cv.INTER_CUBIC : cv.INTER_AREA;
      // Grayscale warp for the OCR stage
      const gray = new cv.Mat();
      cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
      rgb.delete();
      cv.warpPerspective(gray, dst, M, new cv.Size(WARP_SIZE, WARP_SIZE), interp);
      gray.delete();
      srcTri.delete();
      dstTri.delete();
      M.delete();

      const cellSize = WARP_SIZE / 4;
      const tiles: Tile[][] = [];
      let lettersRead = 0;
      let darkCells = 0;
      for (let r = 0; r < 4; r++) {
        const rowTiles: Tile[] = [];
        for (let c = 0; c < 4; c++) {
          const cell = await extractCellLetter(cv, dst, r, c, cellSize);
          if (cell.letter)
            lettersRead++;
          if (cell.dark)
            darkCells++;
          rowTiles.push({ letter: cell.letter, row: r, col: c });
        }
        tiles.push(rowTiles);
      }
      dst.delete();
      const inkCoverage = darkCells / 16;

      // Accept only if enough cells actually OCR; a grid-shaped cluster of
      // punctuation/UI marks would fail here.
      if (lettersRead < 6)
        return null;

      const corners = quad.map(p => ({ x: p.x / scale, y: p.y / scale }));
      return { tiles, corners, readRatio: lettersRead / 16, inkCoverage };
    }
    catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    }
    finally {
      processing.value = false;
    }
  }

  /**
   * Extract the single letter from one warped cell, or '' if there is no
   * confident black-on-white letter at the cell center.
   *
   * 18% inset keeps tile borders and rounded-corner shading out of the
   * glyph blob (verified pitfall in the browser-camera-cv skill). At
   * 175px cells the inset still leaves a ~114px interior.
   */
  async function extractCellLetter(
    cv: Record<string, any>,
    warped: any,
    row: number,
    col: number,
    cellSize: number,
  ): Promise<{ letter: string; dark: boolean }> {
    const inset = Math.floor(cellSize * 0.18);
    const inner = cellSize - inset * 2;
    const rect = new cv.Rect(col * cellSize + inset, row * cellSize + inset, inner, inner);
    const cell = warped.roi(rect);

    const bin = new cv.Mat();
    cv.threshold(cell, bin, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
    cell.delete();
    rect.delete?.();

    const inkFrac = cv.countNonZero(bin) / (inner * inner);
    const dark = inkFrac > 0.5;

    const openKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2, 2));
    const opened = new cv.Mat();
    cv.morphologyEx(bin, opened, cv.MORPH_OPEN, openKernel);
    bin.delete();
    openKernel.delete();

    const labels = new cv.Mat();
    const stats = new cv.Mat();
    const centroids = new cv.Mat();
    const count = cv.connectedComponentsWithStats(opened, labels, stats, centroids, 8, cv.CV_32S);
    opened.delete();

    const cx = inner / 2;
    const cy = inner / 2;
    const minArea = inner * inner * 0.03;
    const maxArea = inner * inner * 0.7;
    const minDim = inner * 0.15;
    const maxDim = inner * 0.9;
    const centerTol = inner * 0.35;

    let best: { x: number; y: number; w: number; h: number; area: number; dist: number } | null = null;

    for (let i = 1; i < count; i++) {
      const x = stats.intPtr(i, 0)[0];
      const y = stats.intPtr(i, 1)[0];
      const w = stats.intPtr(i, 2)[0];
      const h = stats.intPtr(i, 3)[0];
      const area = stats.intPtr(i, 4)[0];
      const centX = centroids.doublePtr(i, 0)[0];
      const centY = centroids.doublePtr(i, 1)[0];
      const dist = Math.hypot(centX - cx, centY - cy);

      if (area < minArea || area > maxArea)
        continue;
      if (w < minDim || h < minDim || w > maxDim || h > maxDim)
        continue;
      if (dist > centerTol)
        continue;

      if (!best || dist < best.dist || (Math.abs(dist - best.dist) < 4 && area > best.area))
        best = { x, y, w, h, area, dist };
    }

    if (!best) {
      labels.delete();
      stats.delete();
      centroids.delete();
      return { letter: "", dark };
    }

    const pad = Math.floor(inner * 0.08);
    const bx = Math.max(0, col * cellSize + inset + best.x - pad);
    const by = Math.max(0, row * cellSize + inset + best.y - pad);
    const bw = Math.min(warped.cols - bx, best.w + pad * 2);
    const bh = Math.min(warped.rows - by, best.h + pad * 2);
    const blobRect = new cv.Rect(bx, by, bw, bh);
    const blob = warped.roi(blobRect);

    // 2x upscale: at WARP_SIZE=700 cells are already big, so 2x lands the
    // glyph in the 60-100px sweet spot without ballooning recognize() time.
    const scaled = new cv.Mat();
    cv.resize(blob, scaled, new cv.Size(bw * 2, bh * 2), 0, 0, cv.INTER_CUBIC);

    const canvas = document.createElement("canvas");
    canvas.width = bw * 2;
    canvas.height = bh * 2;
    cv.imshow(canvas, scaled);

    blob.delete();
    blobRect.delete?.();
    scaled.delete();
    labels.delete();
    stats.delete();
    centroids.delete();

    return { letter: await ocrLetter(canvas), dark };
  }

  async function ocrLetter(canvas: HTMLCanvasElement): Promise<string> {
    try {
      const worker = (await getTesseract()) as {
        recognize: (image: HTMLCanvasElement) => Promise<{ data: { text: string; confidence: number } }>;
      };
      const { data } = await worker.recognize(canvas);
      const text = (data.text || "").trim().toUpperCase();
      const match = text.match(/[A-Z]/);
      if (!match)
        return "";
      if ((data.confidence ?? 0) < MIN_CONFIDENCE)
        return "";
      return match[0];
    }
    catch {
      return "";
    }
  }

  return { processing: readonly(processing), error: readonly(error), detectGrid };
}
