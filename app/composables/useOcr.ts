// app/composables/useOcr.ts
// Loads OpenCV.js + Tesseract.js lazily, finds the 4x4 grid in a canvas frame,
// and OCRs exactly one letter per tile.
//
// Board assumptions (fixed game hardware):
//   - The only usable letters are the BLACK letters printed on the WHITE tiles.
//   - Dots printed under letters are ignored (scoring is hardcoded Scrabble values).
//   - Lines/gaps between tiles are never letters; they are excluded by cropping
//     each cell interior with an inset, and by only accepting a dark ink blob
//     near the cell center.
//   - A cell that fails these checks yields NO letter ('') rather than a guess,
//     so fake letters from noise/shadows/edges never reach the solver.
import type { Tile } from '~/utils/solver'

export interface GridDetectionResult {
  tiles: Tile[][]
  /** corner points in canvas coords, ordered TL, TR, BR, BL */
  corners: Array<{ x: number, y: number }>
}

let cvInstance: unknown = null
let cvLoading: Promise<unknown> | null = null

async function getCv() {
  if (cvInstance) return cvInstance
  if (!cvLoading) {
    cvLoading = import('@techstark/opencv-js').then((mod) => {
      // @techstark/opencv-js exports a promise-like default in some builds
      const cv = (mod as { default?: unknown }).default ?? mod
      return cv
    })
  }
  cvInstance = await cvLoading
  return cvInstance
}

let tesseractWorker: unknown = null

async function getTesseract() {
  if (tesseractWorker) return tesseractWorker
  const { createWorker } = await import('tesseract.js')
  // PSM 10 = treat the image as a single character.
  tesseractWorker = await createWorker('eng', 1, {
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    tessedit_pageseg_mode: '10',
  })
  return tesseractWorker
}

// Minimum OCR confidence (0-100) to accept a letter. Below this we return ''
// so noise never becomes a fake letter.
const MIN_CONFIDENCE = 60

export function useOcr() {
  const processing = ref(false)
  const error = ref<string | null>(null)

  /**
   * Detect the largest 4-point contour, warp it to a square, and return
   * the 16 cell letters plus the original corner coordinates.
   */
  async function detectGrid(source: HTMLCanvasElement): Promise<GridDetectionResult | null> {
    processing.value = true
    error.value = null
    try {
      const cv = (await getCv()) as Record<string, any>
      // Read source into cv.Mat
      const src = cv.imread(source)
      const gray = new cv.Mat()
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)

      // Blur + adaptive threshold to handle lighting
      const blurred = new cv.Mat()
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0)
      const thresh = new cv.Mat()
      cv.adaptiveThreshold(
        blurred,
        thresh,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY_INV,
        11,
        2,
      )

      // Find contours
      const contours = new cv.MatVector()
      const hierarchy = new cv.Mat()
      cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

      let bestContour: any = null
      let bestArea = 0
      const imgArea = source.width * source.height

      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i)
        const area = cv.contourArea(cnt)
        if (area < imgArea * 0.05) {
          cnt.delete()
          continue // ignore tiny blobs
        }

        // Approximate polygon
        const approx = new cv.Mat()
        const peri = cv.arcLength(cnt, true)
        cv.approxPolyDP(cnt, approx, 0.02 * peri, true)

        if (approx.rows === 4 && area > bestArea) {
          if (bestContour) bestContour.delete()
          bestArea = area
          bestContour = approx
        } else {
          approx.delete()
        }
        cnt.delete()
      }

      if (!bestContour) {
        // cleanup
        src.delete()
        gray.delete()
        blurred.delete()
        thresh.delete()
        contours.delete()
        hierarchy.delete()
        return null
      }

      // Extract corners
      const pts: Array<{ x: number, y: number }> = []
      const data = bestContour.data32S as Int32Array
      for (let i = 0; i < 4; i++) {
        pts.push({ x: data[i * 2], y: data[i * 2 + 1] })
      }

      // Order: TL, TR, BR, BL
      pts.sort((a, b) => a.y - b.y)
      const top = pts.slice(0, 2).sort((a, b) => a.x - b.x)
      const bottom = pts.slice(2, 4).sort((a, b) => a.x - b.x)
      const corners = [top[0], top[1], bottom[1], bottom[0]]

      // Warp to square
      const warpSize = 400
      const dst = new cv.Mat()
      const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, corners.flatMap(p => [p.x, p.y]))
      const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, warpSize, 0, warpSize, warpSize, 0, warpSize])
      const M = cv.getPerspectiveTransform(srcTri, dstTri)
      cv.warpPerspective(gray, dst, M, new cv.Size(warpSize, warpSize), cv.INTER_LINEAR)

      // Extract 16 cell letters
      const cellSize = warpSize / 4
      const tiles: Tile[][] = []
      for (let r = 0; r < 4; r++) {
        const row: Tile[] = []
        for (let c = 0; c < 4; c++) {
          const letter = extractCellLetter(cv, dst, r, c, cellSize)
          row.push({ letter, row: r, col: c })
        }
        tiles.push(row)
      }

      // cleanup
      src.delete()
      gray.delete()
      blurred.delete()
      thresh.delete()
      contours.delete()
      hierarchy.delete()
      bestContour.delete()
      dst.delete()
      srcTri.delete()
      dstTri.delete()
      M.delete()

      return { tiles, corners }
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e)
      return null
    } finally {
      processing.value = false
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
  ): Promise<string> {
    const inset = Math.floor(cellSize * 0.15)
    const inner = cellSize - inset * 2
    const rect = new cv.Rect(col * cellSize + inset, row * cellSize + inset, inner, inner)
    const cell = warped.roi(rect)

    // Otsu binarization, inverted: dark ink becomes white (255) on black (0)
    const bin = new cv.Mat()
    cv.threshold(cell, bin, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU)
    cell.delete()
    rect.delete?.()

    // Connected components with stats
    const labels = new cv.Mat()
    const stats = new cv.Mat()
    const centroids = new cv.Mat()
    const count = cv.connectedComponentsWithStats(bin, labels, stats, centroids, 8, cv.CV_32S)
    bin.delete()

    const cx = inner / 2
    const cy = inner / 2
    const minArea = inner * inner * 0.03 // dots are far smaller than this
    const maxArea = inner * inner * 0.7
    const minDim = inner * 0.15
    const maxDim = inner * 0.9
    const centerTol = inner * 0.35 // centroid must be within this of cell center

    let best: { x: number, y: number, w: number, h: number, area: number, dist: number } | null = null

    for (let i = 1; i < count; i++) {
      const x = stats.intPtr(i, 0)[0]
      const y = stats.intPtr(i, 1)[0]
      const w = stats.intPtr(i, 2)[0]
      const h = stats.intPtr(i, 3)[0]
      const area = stats.intPtr(i, 4)[0]
      const centX = centroids.doublePtr(i, 0)[0]
      const centY = centroids.doublePtr(i, 1)[0]
      const dist = Math.hypot(centX - cx, centY - cy)

      if (area < minArea || area > maxArea) continue // dots/noise/edge slabs
      if (w < minDim || h < minDim || w > maxDim || h > maxDim) continue
      if (dist > centerTol) continue // off-center fragments (tile edges, neighbor bleed)

      if (!best || dist < best.dist || (Math.abs(dist - best.dist) < 4 && area > best.area)) {
        best = { x, y, w, h, area, dist }
      }
    }

    if (!best) {
      labels.delete()
      stats.delete()
      centroids.delete()
      return ''
    }

    // Crop the ink blob from the warped grayscale with padding, then OCR.
    const pad = Math.floor(inner * 0.1)
    const bx = Math.max(0, col * cellSize + inset + best.x - pad)
    const by = Math.max(0, row * cellSize + inset + best.y - pad)
    const bw = Math.min(warped.cols - bx, best.w + pad * 2)
    const bh = Math.min(warped.rows - by, best.h + pad * 2)
    const blobRect = new cv.Rect(bx, by, bw, bh)
    const blob = warped.roi(blobRect)

    // Upscale ~3x for Tesseract, which prefers ~30px+ glyphs.
    const scaled = new cv.Mat()
    cv.resize(blob, scaled, new cv.Size(bw * 3, bh * 3), 0, 0, cv.INTER_CUBIC)

    const canvas = document.createElement('canvas')
    canvas.width = bw * 3
    canvas.height = bh * 3
    cv.imshow(canvas, scaled)

    blob.delete()
    blobRect.delete?.()
    scaled.delete()
    labels.delete()
    stats.delete()
    centroids.delete()

    return ocrLetter(canvas)
  }

  async function ocrLetter(canvas: HTMLCanvasElement): Promise<string> {
    try {
      const worker = (await getTesseract()) as {
        recognize(image: HTMLCanvasElement): Promise<{ data: { text: string, confidence: number } }>
      }
      const { data } = await worker.recognize(canvas)
      const text = (data.text || '').trim().toUpperCase()
      const match = text.match(/[A-Z]/)
      if (!match) return ''
      // Two single-char confusions that come back constantly on these tiles:
      // Q tails get clipped -> O; U with a flat top -> V. Accept them anyway,
      // confidence filter below is the real gate.
      if ((data.confidence ?? 0) < MIN_CONFIDENCE) return ''
      return match[0]
    } catch {
      return ''
    }
  }

  return { processing: readonly(processing), error: readonly(error), detectGrid }
}
