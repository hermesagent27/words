// app/composables/useOcr.ts
// Loads OpenCV.js + Tesseract.js lazily and reads the 4x4 letter board from
// whatever distance the phone happens to be at.
//
// Detection strategy (distance-invariant):
//   1. Downscale the frame to a fixed working width so every scale costs the
//      same regardless of camera resolution.
//   2. Search the ENTIRE frame (no fixed ROI band) for the board's blue
//      rounded-square backing. Ruzzle's board sits on a distinctive blue
//      field; thresholding hue in that range leaves a mask of exactly one
//      big object, which makes the contour hunt trivial at any distance.
//   3. Take all >= 4-point contours whose side length clears a one-tile
//      floor (a 4-point contour can only be as small as one letter tile and
//      still produce a warped cell big enough to OCR). Rank by area, warp
//      each candidate to a normalized square, and accept the first one that
//      actually OCRs into letters.
//   4. Warp size scales up (700px -> 175px cells) so tiny distant boards get
//      magnified to Tesseract-friendly glyph size; close boards get
//      downscaled, which is equally free.
import type { Tile } from "~/utils/solver";

// ---------------------------------------------------------------
// Pure detection core. Exported so the headless smoke test exercises the
// exact code the app runs (scripts/smoke-detect.mts).
// ---------------------------------------------------------------

export const WORK_WIDTH = 640;
export const WARP_SIZE = 700;

// A 4-point contour must be at least this side length (working-frame px) to
// warp into OCR-able cells. ~one tile side at 640px width is the floor.
export const MIN_SIDE_PX = 70;

// Blue mask thresholds (RGB). The board backing is a saturated blue well
// above the red channel; white tiles, skin, and the phone's background UI
// all fail B > R + 40 or the saturation floor.
export function isBoardBlue(r: number, g: number, b: number): boolean {
  return b > 110 && b > r + 40 && b > g + 15;
}

/** Build an 8-bit mask of blue pixels from a 3- or 4-channel cv.Mat. */
export function buildBlueMask(cv: Record<string, any>, src: any): any {
  const channels = src.channels();
  const w = src.cols;
  const h = src.rows;
  const data = src.data as Uint8Array;
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < out.length; i += channels, j++) {
    out[j] = isBoardBlue(data[i]!, data[i + 1]!, data[i + 2]!) ? 255 : 0;
  }
  const mask = cv.matFromArray(h, w, cv.CV_8UC1, out);
  // Close gaps (white tiles punching holes in the blue sheet). No open:
  // erosion shrinks small boards below the side floor, and speck rejection
  // is already handled by the area floor + largest-first ranking.
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  const closed = new cv.Mat();
  cv.morphologyEx(mask, closed, cv.MORPH_CLOSE, k);
  mask.delete();
  k.delete();
  return closed;
}

/**
 * Ranked candidate board quads from a blue mask, biggest first, in the
 * mask's coordinate space. Caller owns the returned Mat-free plain data;
 * the mask Mat is deleted by the caller.
 */
export function findBoardQuads(
  cv: Record<string, any>,
  mask: any,
): Array<Array<{ x: number; y: number }>> {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  const frameArea = mask.cols * mask.rows;
  const quads: Array<{ area: number; pts: Array<{ x: number; y: number }> }> = [];

  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    const peri = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    // 0.04 epsilon: the board is a rounded rectangle, so raw approx may
    // return 5-8 points. Hull then re-approximate forces a clean 4 points.
    cv.approxPolyDP(cnt, approx, 0.04 * peri, true);

    if (approx.rows >= 4 && approx.rows <= 8 && area > frameArea * 0.005) {
      const hull = new cv.Mat();
      cv.convexHull(approx, hull, false, true);
      const quad = new cv.Mat();
      // Scale the epsilon with contour size: 0.02*peri is 13px of tolerance
      // on a 170px-side board, which rounds the quad inward ~20%. 0.005 keeps
      // corner error under a pixel at every distance we accept.
      cv.approxPolyDP(hull, quad, 0.005 * cv.arcLength(hull, true), true);
      if (quad.rows === 4) {
        const d = quad.data32S as Int32Array;
        const pts = [
          { x: d[0]!, y: d[1]! },
          { x: d[2]!, y: d[3]! },
          { x: d[4]!, y: d[5]! },
          { x: d[6]!, y: d[7]! },
        ];
        pts.sort((a, b) => a.y - b.y);
        const top = pts.slice(0, 2).sort((a, b) => a.x - b.x);
        const bottom = pts.slice(2, 4).sort((a, b) => a.x - b.x);
        const ordered = [top[0]!, top[1]!, bottom[1]!, bottom[0]!];
        const side = Math.max(
          Math.hypot(ordered[1]!.x - ordered[0]!.x, ordered[1]!.y - ordered[0]!.y),
          Math.hypot(ordered[3]!.x - ordered[0]!.x, ordered[3]!.y - ordered[0]!.y),
        );
        if (side >= MIN_SIDE_PX)
          quads.push({ area, pts: ordered });
      }
      quad.delete();
      hull.delete();
    }
    approx.delete();
    cnt.delete();
  }
  contours.delete();
  hierarchy.delete();
  quads.sort((a, b) => b.area - a.area);
  return quads.slice(0, 4).map(q => q.pts);
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
      // opencv-js exports a promise-like; await to reach the real namespace.
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

      const src = cv.imread(work);
      const mask = buildBlueMask(cv, src);
      const quads = findBoardQuads(cv, mask);
      mask.delete();

      if (!quads.length) {
        src.delete();
        return null;
      }

      // Grayscale once; every candidate warps from the same source.
      const gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      src.delete();

      for (const pts of quads) {
        const dst = new cv.Mat();
        const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, pts.flatMap(p => [p.x, p.y]));
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
        const srcSide = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
        const interp = srcSide < WARP_SIZE ? cv.INTER_CUBIC : cv.INTER_AREA;
        cv.warpPerspective(gray, dst, M, new cv.Size(WARP_SIZE, WARP_SIZE), interp);
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

        // Accept this candidate when enough cells read as letters. A wrong
        // quad (blue UI panel, sign) reads ~0 and we fall through to the
        // next candidate instead of poisoning board state.
        if (lettersRead >= 6) {
          const corners = pts.map(p => ({ x: p.x / scale, y: p.y / scale }));
          gray.delete();
          return { tiles, corners, readRatio: lettersRead / 16, inkCoverage };
        }
      }

      gray.delete();
      return null;
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
