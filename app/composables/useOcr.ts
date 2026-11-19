import type { Worker } from "tesseract.js";

import type { Point } from "~/utils/boardGeometry";
import type { Tile } from "~/utils/solver";

import { isBoardObstructed } from "~/utils/boardObstruction";
import { detectBoardCorners } from "~/utils/detectBoard";

let cvLoading: Promise<unknown> | null = null;
let workerLoading: Promise<Worker> | null = null;

async function getCv() {
  if (!cvLoading) {
    cvLoading = import("@techstark/opencv-js").then(mod => mod.default ?? mod).catch((error: unknown) => {
      cvLoading = null;
      throw error;
    });
  }
  return await cvLoading;
}

async function getWorker(): Promise<Worker> {
  if (!workerLoading) {
    workerLoading = import("tesseract.js").then(async ({ createWorker, PSM }) => {
      const worker = await createWorker("eng");
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      });
      return worker;
    }).catch((error: unknown) => {
      workerLoading = null;
      throw error;
    });
  }
  return await workerLoading;
}

const MIN_CONFIDENCE = 55;
const WARP_SIZE = 400;

export type GridDetectionResult
  = | { corners: Point[]; obstructed: true }
    | { corners: Point[]; obstructed: false; tiles: Tile[][] };

export function useOcr() {
  const processing = ref(false);
  const error = ref<string | null>(null);

  async function detectGrid(source: HTMLCanvasElement): Promise<GridDetectionResult | null> {
    processing.value = true;
    error.value = null;
    try {
      const cv = await getCv() as Record<string, any>;
      const scale = Math.min(1, 1600 / Math.max(source.width, source.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(source.width * scale);
      canvas.height = Math.round(source.height * scale);
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error("Unable to create OCR canvas");
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const corners = detectBoardCorners(cv, canvas);
      if (!corners)
        return null;

      const src = cv.imread(canvas);
      const color = new cv.Mat();
      const warped = new cv.Mat();
      const from = cv.matFromArray(4, 1, cv.CV_32FC2, corners.flatMap(p => [p.x, p.y]));
      const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, WARP_SIZE, 0, WARP_SIZE, WARP_SIZE, 0, WARP_SIZE]);
      const transform = cv.getPerspectiveTransform(from, to);
      try {
        cv.warpPerspective(src, color, transform, new cv.Size(WARP_SIZE, WARP_SIZE), cv.INTER_LINEAR);
        const fullCorners = corners.map(p => ({ x: p.x / scale, y: p.y / scale }));
        if (isBoardObstructed(color.data, WARP_SIZE))
          return { corners: fullCorners, obstructed: true };
        cv.cvtColor(color, warped, cv.COLOR_RGBA2GRAY);
        const tiles: Tile[][] = [];
        for (let row = 0; row < 4; row++) {
          const cells: Tile[] = [];
          for (let col = 0; col < 4; col++)
            cells.push({ row, col, letter: await extractCellLetter(cv, warped, row, col) });
          tiles.push(cells);
        }
        return {
          tiles,
          corners: fullCorners,
          obstructed: false,
        };
      }
      finally {
        src.delete();
        color.delete();
        warped.delete();
        from.delete();
        to.delete();
        transform.delete();
      }
    }
    catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    }
    finally {
      processing.value = false;
    }
  }

  async function extractCellLetter(cv: Record<string, any>, warped: any, row: number, col: number): Promise<string> {
    const cellSize = WARP_SIZE / 4;
    const inset = Math.floor(cellSize * 0.15);
    const inner = cellSize - inset * 2;
    const cell = warped.roi(new cv.Rect(col * cellSize + inset, row * cellSize + inset, inner, inner));
    const binary = new cv.Mat();
    const labels = new cv.Mat();
    const stats = new cv.Mat();
    const centroids = new cv.Mat();
    try {
      cv.threshold(cell, binary, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
      const count = cv.connectedComponentsWithStats(binary, labels, stats, centroids, 8, cv.CV_32S);
      let best: { x: number; y: number; width: number; height: number; distance: number } | null = null;
      for (let i = 1; i < count; i++) {
        const x = stats.intPtr(i, 0)[0] as number;
        const y = stats.intPtr(i, 1)[0] as number;
        const width = stats.intPtr(i, 2)[0] as number;
        const height = stats.intPtr(i, 3)[0] as number;
        const area = stats.intPtr(i, 4)[0] as number;
        const cx = centroids.doublePtr(i, 0)[0] as number;
        const cy = centroids.doublePtr(i, 1)[0] as number;
        const distance = Math.hypot(cx - inner / 2, cy - inner / 2);
        if (area < inner * inner * 0.025 || area > inner * inner * 0.7
          || width < inner * 0.12 || height < inner * 0.15
          || width > inner * 0.9 || height > inner * 0.9 || distance > inner * 0.35) {
          continue;
        }
        if (!best || distance < best.distance)
          best = { x, y, width, height, distance };
      }
      if (!best)
        return "";

      const blob = cell.roi(new cv.Rect(best.x, best.y, best.width, best.height));
      try {
        for (const [padding, factor] of [[2, 2], [10, 3], [2, 1], [8, 2], [15, 2], [8, 3]] as const) {
          const padded = new cv.Mat();
          const scaled = new cv.Mat();
          try {
            cv.copyMakeBorder(blob, padded, padding, padding, padding, padding, cv.BORDER_CONSTANT, new cv.Scalar(255));
            cv.resize(padded, scaled, new cv.Size(padded.cols * factor, padded.rows * factor), 0, 0, cv.INTER_CUBIC);
            cv.threshold(scaled, scaled, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
            const canvas = document.createElement("canvas");
            canvas.width = scaled.cols;
            canvas.height = scaled.rows;
            cv.imshow(canvas, scaled);
            const { data } = await (await getWorker()).recognize(canvas);
            const text = data.text.trim().toUpperCase();
            if (data.confidence >= MIN_CONFIDENCE && /^[A-Z]$/.test(text))
              return text;
          }
          finally {
            padded.delete();
            scaled.delete();
          }
        }
        return "";
      }
      finally {
        blob.delete();
      }
    }
    finally {
      cell.delete();
      binary.delete();
      labels.delete();
      stats.delete();
      centroids.delete();
    }
  }

  return { processing: readonly(processing), error: readonly(error), detectGrid };
}
