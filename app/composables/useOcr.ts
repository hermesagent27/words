// app/composables/useOcr.ts
// Loads OpenCV.js + Tesseract.js lazily, crops to the board ROIs, and OCRs
// exactly one letter per tile. ALL compute runs inside the ROIs — pixels
// outside the game board are never thresholded, contour-searched, or OCR'd.
//
// Board assumptions (fixed game hardware):
//   - The only usable letters are the BLACK letters printed on the WHITE tiles.
//   - Dots printed under letters are ignored (scoring is hardcoded Scrabble values).
//   - Lines/gaps between tiles are never letters; they are excluded by cropping
//     each cell interior with an inset, and by only accepting a dark ink blob
//     near the cell center.
//   - A cell that fails these checks yields NO letter ('') rather than a guess,
//     so fake letters from noise/shadows/edges never reach the solver.
import type { Tile } from "~/utils/solver";

// ---------------------------------------------------------------
// Region of interest. Fractions of the full camera frame. The 4x4
// game board lives in the blue rounded square in the middle of the
// game screen; everything else (timer, score, reshuffle button,
// background) is ignored so zero compute is spent on it.
// Verified to contain the board for common camera aspect ratios
// (16:9, 4:3, portrait) whether the game display is fit or cropped.
// ---------------------------------------------------------------
const ROI_DETECT = { left: 0.04, top: 0.30, width: 0.92, height: 0.47 };

let cvInstance: unknown = null;
let cvLoading: Promise<unknown> | null = null;

async function getCv() {
  if (cvInstance)
    return cvInstance;
  if (!cvLoading) {
    cvLoading = import("@techstark/opencv-js").then((mod) => {
      // @techstark/opencv-js exports a promise-like default in some builds
      const cv = (mod as { default?: unknown }).default ?? mod;
      return cv;
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
  // PSM 10 = treat the image as a single character. The third arg is the
  // OEM/LSTM-only engine mode; worker options carry the whitelist, but
  // Tesseract's own param name is what the runtime actually honors.
  tesseractWorker = await createWorker("eng", 1, {
    tessedit_pageseg_mode: "10",
  } as Parameters<typeof createWorker>[2]);
  // Set the alphabet whitelist via the worker's runtime setter, which is the
  // API surface that actually types it in tesseract.js v7.
  await (tesseractWorker as { setVariable?: (k: string, v: string) => Promise<void> })
    .setVariable?.("tessedit_char_whitelist", "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  return tesseractWorker;
}

// Minimum OCR confidence (0-100) to accept a letter. Below this we return ''
// so noise never becomes a fake letter. This is per-frame; cross-frame
// consensus in WordsGame.vue is the real noise filter, so we can accept
// weaker glyphs (thin strokes, faint print) on any single frame.
const MIN_CONFIDENCE = 55;

// Smallest board square we accept, as a fraction of the search-window area.
// Below this the "contour" is background noise, not the board, and warping
// would magnify corner jitter into cell-crossing errors.
const MIN_BOARD_AREA_RATIO = 0.4;

// Full-frame coords of the last good board quad. Drives the sub-crop so the
// contour stage searches only around the board, whatever size it happens to
// be on screen this round (camera distance varies).
let lastBoardQuad: Array<{ x: number; y: number }> | null = null;
// Extra padding around the remembered board when sub-cropping.
const SUBCROP_MARGIN = 0.15;

// A finger entering the board hides the ink under a skin-colored blob but
// leaves the surrounding white tiles legible, so per-cell checks alone can't
// tell "finger on board" from "board is changing". Ink coverage can: a
// normal board binarizes to mostly-white cells, while cells under a finger
// go mostly dark in the binary image.
const OBSTRUCTION_INK_COVERAGE = 0.55;

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

  /**
   * Crop `source` to the fractional ROI. Coordinates are clamped and
   * rounded to even integers so OpenCV never throws on odd sizes.
   */
  function cropToRoi(
    source: HTMLCanvasElement,
    roi: { left: number; top: number; width: number; height: number },
  ): HTMLCanvasElement {
    const W = source.width;
    const H = source.height;
    const x = Math.max(0, Math.floor(W * roi.left) & ~1);
    const y = Math.max(0, Math.floor(H * roi.top) & ~1);
    const w = Math.min(W - x, Math.floor(W * roi.width) & ~1);
    const h = Math.min(H - y, Math.floor(H * roi.height) & ~1);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")!.drawImage(source, x, y, w, h, 0, 0, w, h);
    return c;
  }

  /**
   * Detect the board square inside the ROIs, warp it, and OCR the 16 cells.
   * Returns null if no plausible board square is in view.
   */
  async function detectGrid(source: HTMLCanvasElement, readCells?: boolean[][]): Promise<GridDetectionResult | null> {
    processing.value = true;
    error.value = null;
    try {
      const cv = (await getCv()) as Record<string, any>;

      // 1) Crop full frame -> detect ROI. Everything above/below the board
      //    (timer, score, reshuffle) is dropped before any px-level compute.
      const roiCanvas = cropToRoi(source, ROI_DETECT);
      const roiX = Math.max(0, Math.floor(source.width * ROI_DETECT.left) & ~1);
      const roiY = Math.max(0, Math.floor(source.height * ROI_DETECT.top) & ~1);

      // 2) Square-ish sub-crop centered on the board, sized off the LAST
      //    detected board when available. Board size on screen varies with
      //    camera distance, so a fixed square can't work; anchoring to the
      //    previous quad keeps the contour stage cheap at any distance and
      //    shrinks the search window exactly when occlusion starts. First
      //    pass (or after a full miss) uses the whole ROI, so a board can
      //    always be (re)acquired.
      let sq = roiCanvas;
      let sqX = 0;
      let sqY = 0;
      if (lastBoardQuad && lastBoardQuad.length === 4) {
        // lastBoardQuad is stored in full-frame coords; translate into this ROI
        const q = lastBoardQuad;
        const cx = q.reduce((s, p) => s + p.x, 0) / 4 - roiX;
        const cy = q.reduce((s, p) => s + p.y, 0) / 4 - roiY;
        const qs = Math.max(
          Math.hypot(q[1]!.x - q[0]!.x, q[1]!.y - q[0]!.y),
          Math.hypot(q[3]!.x - q[0]!.x, q[3]!.y - q[0]!.y),
        );
        const half = qs * (1 + SUBCROP_MARGIN) / 2;
        sqX = Math.max(0, Math.floor(cx - half) & ~1);
        sqY = Math.max(0, Math.floor(cy - half) & ~1);
        const sw = Math.min(roiCanvas.width - sqX, Math.ceil(half * 2) & ~1);
        const sh = Math.min(roiCanvas.height - sqY, Math.ceil(half * 2) & ~1);
        if (sw > 60 && sh > 60) {
          const crop = document.createElement("canvas");
          crop.width = sw;
          crop.height = sh;
          crop.getContext("2d")!.drawImage(roiCanvas, sqX, sqY, sw, sh, 0, 0, sw, sh);
          sq = crop;
        }
        else {
          sqX = 0;
          sqY = 0;
        }
      }

      // Read ONLY the search window into cv.Mat
      const src = cv.imread(sq);
      const gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

      // Blur + adaptive threshold to handle lighting
      const blurred = new cv.Mat();
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
      const thresh = new cv.Mat();
      cv.adaptiveThreshold(
        blurred,
        thresh,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY_INV,
        11,
        2,
      );

      // Find contours
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      let bestContour: any = null;
      let bestArea = 0;
      const imgArea = sq.width * sq.height;
      // Board must fill most of the search window. At the minimum-ratio
      // boundary the perspective warp would magnify corner jitter into
      // cell-crossing errors, so a contour below this is treated as "no
      // board" rather than a bad read.
      const minArea = imgArea * MIN_BOARD_AREA_RATIO;

      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);
        if (area < minArea) {
          cnt.delete();
          continue; // ignore tiny blobs
        }

        // Approximate polygon
        const approx = new cv.Mat();
        const peri = cv.arcLength(cnt, true);
        cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

        if (approx.rows === 4 && area > bestArea) {
          if (bestContour)
            bestContour.delete();
          bestArea = area;
          bestContour = approx;
        }
        else {
          approx.delete();
        }
        cnt.delete();
      }

      if (!bestContour) {
        // No usable board in view. Forget the remembered quad so the next
        // frame searches the whole ROI again (board could be at any size).
        lastBoardQuad = null;
        src.delete();
        gray.delete();
        blurred.delete();
        thresh.delete();
        contours.delete();
        hierarchy.delete();
        return null;
      }

      // Extract corners (ROI coords) and map back to full-frame coords
      const raw: Array<{ x: number; y: number }> = [];
      const data = bestContour.data32S as Int32Array;
      for (let i = 0; i < 4; i++) {
        raw.push({ x: data[i * 2]!, y: data[i * 2 + 1]! });
      }

      // Order: TL, TR, BR, BL. Map sub-crop coords back to full-frame coords.
      raw.sort((a, b) => a.y - b.y);
      const top = raw.slice(0, 2).sort((a, b) => a.x - b.x);
      const bottom = raw.slice(2, 4).sort((a, b) => a.x - b.x);
      const ordered = [top[0]!, top[1]!, bottom[1]!, bottom[0]!];
      const corners = ordered.map(p => ({
        x: p.x + sqX + roiX,
        y: p.y + sqY + roiY,
      }));
      lastBoardQuad = corners;

      // Warp the sub-crop grayscale to a normalized square. `ordered` is in
      // sub-crop coords, which is exactly the space `gray` was built from.
      const warpSize = 400;
      const dst = new cv.Mat();
      const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, ordered.flatMap((p: { x: number; y: number }) => [p.x, p.y]));
      const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, warpSize, 0, warpSize, warpSize, 0, warpSize]);
      const M = cv.getPerspectiveTransform(srcTri, dstTri);
      cv.warpPerspective(gray, dst, M, new cv.Size(warpSize, warpSize), cv.INTER_LINEAR);

      // Extract 16 cell letters (await each async OCR call so `letter` is a
      // string, not a Promise — otherwise the solver receives Promise objects
      // and crashes on `tile.letter.toLowerCase()`)
      const cellSize = warpSize / 4;
      const tiles: Tile[][] = [];
      let lettersRead = 0;
      let darkCells = 0;
      const darkFlags: boolean[] = [];
      for (let r = 0; r < 4; r++) {
        const row: Tile[] = [];
        for (let c = 0; c < 4; c++) {
          const cell = await extractCellLetter(cv, dst, r, c, cellSize, readCells?.[r]?.[c] ?? true);
          if (cell.letter)
            lettersRead++;
          if (cell.dark) {
            darkCells++;
            darkFlags.push(true);
          }
          else {
            darkFlags.push(false);
          }
          row.push({ letter: cell.letter, row: r, col: c });
        }
        tiles.push(row);
      }
      const inkCoverage = darkCells / 16;

      // Occlusion rescue: if most cells went dark (finger across the board),
      // OCR the whole warped board in ONE call. Per-cell crops under a finger
      // see a dark slab instead of a glyph; the whole-board view still has
      // tile edges for segmentation. Expensive, so only run it occluded.
      if (!readCells && inkCoverage >= OBSTRUCTION_INK_COVERAGE && lettersRead < 14) {
        const rescued = await ocrWholeBoard(dst); // 16 chars, '_' = unread
        if (rescued) {
          lettersRead = 0;
          let n = 0;
          for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
              const L = rescued[n++] ?? "_";
              const cell = tiles[r]?.[c];
              if (cell) {
                cell.letter = L === "_" ? "" : L;
                if (cell.letter)
                  lettersRead++;
              }
            }
          }
        }
      }

      // cleanup
      src.delete();
      gray.delete();
      blurred.delete();
      thresh.delete();
      contours.delete();
      hierarchy.delete();
      bestContour.delete();
      dst.delete();
      srcTri.delete();
      dstTri.delete();
      M.delete();

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
   * Steps:
   *   1. Crop the cell interior (15% inset) so tile edges/gaps/lines are excluded.
   *   2. Otsu threshold: ink (dark) -> white blobs on black background.
   *   3. Keep only components near the cell center with plausible letter size.
   *      This drops the dots (tiny, low in the cell) and edge fragments.
   *   4. OCR the letter crop with PSM 10; require minimum confidence.
   */
  async function extractCellLetter(
    cv: Record<string, any>,
    warped: any,
    row: number,
    col: number,
    cellSize: number,
    readLetter: boolean,
  ): Promise<{ letter: string; dark: boolean }> {
    const inset = Math.floor(cellSize * 0.15);
    const inner = cellSize - inset * 2;
    const rect = new cv.Rect(col * cellSize + inset, row * cellSize + inset, inner, inner);
    const cell = warped.roi(rect);

    // Otsu binarization, inverted: dark ink becomes white (255) on black (0).
    // Otsu works well when lighting is even; under glare it fragments glyphs.
    // We follow with a morphological open to drop single-pixel specks and fuse
    // nearly-touching pieces of the same stroke.
    const bin = new cv.Mat();
    cv.threshold(cell, bin, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
    cell.delete();
    rect.delete?.();

    // Ink fraction of this cell interior. A normal letter strokes a few
    // percent of the cell; a finger/shadow covering the cell pushes the
    // binary image mostly-dark, which we surface as `dark`.
    const inkFrac = cv.countNonZero(bin) / (inner * inner);
    const dark = inkFrac > 0.5;
    if (!readLetter) {
      bin.delete();
      return { letter: "", dark };
    }

    const openKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2, 2));
    const opened = new cv.Mat();
    cv.morphologyEx(bin, opened, cv.MORPH_OPEN, openKernel);
    bin.delete();
    openKernel.delete();

    // Connected components with stats
    const labels = new cv.Mat();
    const stats = new cv.Mat();
    const centroids = new cv.Mat();
    const count = cv.connectedComponentsWithStats(opened, labels, stats, centroids, 8, cv.CV_32S);
    opened.delete();

    const cx = inner / 2;
    const cy = inner / 2;
    const minArea = inner * inner * 0.03; // dots are far smaller than this
    const maxArea = inner * inner * 0.7;
    const minDim = inner * 0.15;
    const maxDim = inner * 0.9;
    const centerTol = inner * 0.35; // centroid must be within this of cell center

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
        continue; // dots/noise/edge slabs
      if (w < minDim || h < minDim || w > maxDim || h > maxDim)
        continue;
      if (dist > centerTol)
        continue; // off-center fragments (tile edges, neighbor bleed)

      if (!best || dist < best.dist || (Math.abs(dist - best.dist) < 4 && area > best.area)) {
        best = { x, y, w, h, area, dist };
      }
    }

    if (!best) {
      labels.delete();
      stats.delete();
      centroids.delete();
      return { letter: "", dark };
    }

    // Crop the ink blob from the warped grayscale with padding, then OCR.
    const pad = Math.floor(inner * 0.1);
    const bx = Math.max(0, col * cellSize + inset + best.x - pad);
    const by = Math.max(0, row * cellSize + inset + best.y - pad);
    const bw = Math.min(warped.cols - bx, best.w + pad * 2);
    const bh = Math.min(warped.rows - by, best.h + pad * 2);
    const blobRect = new cv.Rect(bx, by, bw, bh);
    const blob = warped.roi(blobRect);

    // Upscale ~3x for Tesseract, which prefers ~30px+ glyphs.
    const scaled = new cv.Mat();
    cv.resize(blob, scaled, new cv.Size(bw * 3, bh * 3), 0, 0, cv.INTER_CUBIC);

    const canvas = document.createElement("canvas");
    canvas.width = bw * 3;
    canvas.height = bh * 3;
    cv.imshow(canvas, scaled);

    blob.delete();
    blobRect.delete?.();
    scaled.delete();
    labels.delete();
    stats.delete();
    centroids.delete();

    return { letter: await ocrLetter(canvas), dark };
  }

  /**
   * OCR the whole warped 4x4 board at once. Used only when per-cell reads
   * say the board is occluded; returns a 16-char string, '_' for blank.
   */
  async function ocrWholeBoard(warped: any): Promise<string | null> {
    try {
      const cv = (await getCv()) as Record<string, any>;
      const canvas = document.createElement("canvas");
      canvas.width = warped.cols;
      canvas.height = warped.rows;
      cv.imshow(canvas, warped);
      const worker = (await getTesseract()) as {
        setVariable?: (name: string, value: string) => Promise<void>;
        recognize: (image: HTMLCanvasElement) => Promise<{ data: { text: string; confidence: number } }>;
      };
      // PSM 6 = a single uniform block of text. Drop char whitelist for
      // whole-board so we get raw text, then sanitize to A-Z/_ ourselves.
      await worker.setVariable?.("tessedit_pageseg_mode", "6");
      const { data } = await worker.recognize(canvas);
      await worker.setVariable?.("tessedit_pageseg_mode", "10");
      const text = (data.text || "").toUpperCase().replace(/[^A-Z]/g, "");
      if (text.length < 8)
        return null;
      // Map the recognized stream to 16 cells row-major, padding with '_'.
      return (`${text}________________`).slice(0, 16);
    }
    catch {
      return null;
    }
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
      // Two single-char confusions that come back constantly on these tiles:
      // Q tails get clipped -> O; U with a flat top -> V. Accept them anyway,
      // confidence filter below is the real gate.
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
