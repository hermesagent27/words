// app/composables/useOcr.ts
// Loads OpenCV.js + Tesseract.js lazily, finds the 4x4 grid in a canvas frame,
// crops each cell, and OCRs letter + dot count.
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
  // PSM 10 = single char, but we use 7 (single line) with whitelist for flexibility
  tesseractWorker = await createWorker('eng', 1, {
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  })
  return tesseractWorker
}

export function useOcr() {
  const processing = ref(false)
  const error = ref<string | null>(null)

  /**
   * Detect the largest 4-point contour, warp it to a square, and return
   * the 16 cell images plus the original corner coordinates.
   */
  async function detectGrid(source: HTMLCanvasElement): Promise<GridDetectionResult | null> {
    processing.value = true
    error.value = null
    try {
      const cv = (await getCv()) as Record<string, unknown>
      // Read source into cv.Mat
      const src = (cv.imread as (el: HTMLCanvasElement) => unknown)(source)
      const gray = new (cv.Mat as new () => unknown)()
      ;(cv.cvtColor as (a: unknown, b: unknown, c: number) => void)(src, gray, (cv.COLOR_RGBA2GRAY as number))

      // Blur + adaptive threshold to handle lighting
      const blurred = new (cv.Mat as new () => unknown)()
      ;(cv.GaussianBlur as (a: unknown, b: unknown, s: unknown, k: number) => void)(
        gray,
        blurred,
        new (cv.Size as new (w: number, h: number) => unknown)(5, 5),
        0,
      )
      const thresh = new (cv.Mat as new () => unknown)()
      ;(cv.adaptiveThreshold as (a: unknown, b: unknown, m: number, a2: number, t: number, b2: number, c: number) => void)(
        blurred,
        thresh,
        255,
        (cv.ADAPTIVE_THRESH_GAUSSIAN_C as number),
        (cv.THRESH_BINARY_INV as number),
        11,
        2,
      )

      // Find contours
      const contours = new (cv.MatVector as new () => unknown)()
      const hierarchy = new (cv.Mat as new () => unknown)()
      ;(cv.findContours as (a: unknown, b: unknown, c: unknown, r: number, m: number) => void)(
        thresh,
        contours,
        hierarchy,
        (cv.RETR_EXTERNAL as number),
        (cv.CHAIN_APPROX_SIMPLE as number),
      )

      let bestContour: unknown = null
      let bestArea = 0
      const imgArea = (source.width * source.height) as number

      for (let i = 0; i < (contours as { size(): number }).size(); i++) {
        const cnt = (contours as { get(i: number): unknown }).get(i)
        const area = (cv.contourArea as (a: unknown) => number)(cnt)
        if (area < imgArea * 0.05) continue // ignore tiny blobs

        // Approximate polygon
        const approx = new (cv.Mat as new () => unknown)()
        const peri = (cv.arcLength as (a: unknown, closed: boolean) => number)(cnt, true)
        ;(cv.approxPolyDP as (a: unknown, b: unknown, e: number, closed: boolean) => void)(
          cnt,
          approx,
          0.02 * peri,
          true,
        )

        if ((approx as { rows: number }).rows === 4 && area > bestArea) {
          bestArea = area
          bestContour = approx
        } else {
          ;(approx as { delete(): void }).delete()
        }
        ;(cnt as { delete(): void }).delete()
      }

      if (!bestContour) {
        // cleanup
        ;(src as { delete(): void }).delete()
        ;(gray as { delete(): void }).delete()
        ;(blurred as { delete(): void }).delete()
        ;(thresh as { delete(): void }).delete()
        ;(contours as { delete(): void }).delete()
        ;(hierarchy as { delete(): void }).delete()
        return null
      }

      // Extract corners
      const pts: Array<{ x: number, y: number }> = []
      const data = (bestContour as { data32S: Int32Array }).data32S
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
      const dst = new (cv.Mat as new () => unknown)()
      const srcTri = (cv.matFromArray as (r: number, c: number, t: number, a: number[]) => unknown)(
        4, 1, (cv.CV_32FC2 as number),
        corners.flatMap(p => [p.x, p.y]),
      )
      const dstTri = (cv.matFromArray as (r: number, c: number, t: number, a: number[]) => unknown)(
        4, 1, (cv.CV_32FC2 as number),
        [0, 0, warpSize, 0, warpSize, warpSize, 0, warpSize],
      )
      const M = (cv.getPerspectiveTransform as (a: unknown, b: unknown) => unknown)(srcTri, dstTri)
      ;(cv.warpPerspective as (a: unknown, b: unknown, m: unknown, s: unknown, f: number) => void)(
        gray,
        dst,
        M,
        new (cv.Size as new (w: number, h: number) => unknown)(warpSize, warpSize),
        (cv.INTER_LINEAR as number),
      )

      // Extract 16 cell images
      const cellSize = warpSize / 4
      const tiles: Tile[][] = []
      for (let r = 0; r < 4; r++) {
        const row: Tile[] = []
        for (let c = 0; c < 4; c++) {
          const x = c * cellSize
          const y = r * cellSize
          const rect = new (cv.Rect as new (x: number, y: number, w: number, h: number) => unknown)(
            Math.floor(x + 2), Math.floor(y + 2), Math.floor(cellSize - 4), Math.floor(cellSize - 4),
          )
          const cellMat = (dst as { roi(r: unknown): unknown }).roi(rect)
          const cellCanvas = document.createElement('canvas')
          cellCanvas.width = cellSize - 4
          cellCanvas.height = cellSize - 4
          ;(cv.imshow as (el: HTMLCanvasElement, mat: unknown) => void)(cellCanvas, cellMat)
          ;(cellMat as { delete(): void }).delete()
          ;(rect as { delete?(): void }).delete?.()

          const letter = await ocrLetter(cellCanvas)
          const dots = countDots(cellCanvas)
          row.push({ letter: letter || '?', dots, row: r, col: c })
        }
        tiles.push(row)
      }

      // cleanup
      ;(src as { delete(): void }).delete()
      ;(gray as { delete(): void }).delete()
      ;(blurred as { delete(): void }).delete()
      ;(thresh as { delete(): void }).delete()
      ;(contours as { delete(): void }).delete()
      ;(hierarchy as { delete(): void }).delete()
      ;(bestContour as { delete(): void }).delete()
      ;(dst as { delete(): void }).delete()
      ;(srcTri as { delete(): void }).delete()
      ;(dstTri as { delete(): void }).delete()
      ;(M as { delete(): void }).delete()

      return { tiles, corners }
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e)
      return null
    } finally {
      processing.value = false
    }
  }

  async function ocrLetter(canvas: HTMLCanvasElement): Promise<string> {
    try {
      const worker = (await getTesseract()) as {
        recognize(image: HTMLCanvasElement): Promise<{ data: { text: string } }>
      }
      const { data } = await worker.recognize(canvas)
      const text = (data.text || '').trim().toUpperCase()
      // Take the first A-Z char we see
      const match = text.match(/[A-Z]/)
      return match ? match[0] : ''
    } catch {
      return ''
    }
  }

  /**
   * Count dots in the bottom-right quadrant of a cell image.
   * We threshold for dark blobs and count connected components.
   */
  function countDots(canvas: HTMLCanvasElement): number {
    const ctx = canvas.getContext('2d')
    if (!ctx) return 1
    const w = canvas.width
    const h = canvas.height
    const img = ctx.getImageData(Math.floor(w * 0.55), Math.floor(h * 0.55), Math.floor(w * 0.45), Math.floor(h * 0.45))
    const data = img.data
    const bw = img.width
    const bh = img.height

    // Convert to binary
    const binary: boolean[] = new Array(bw * bh).fill(false)
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = (y * bw + x) * 4
        const r = data[i], g = data[i + 1], b = data[i + 2]
        const lum = 0.299 * r + 0.587 * g + 0.114 * b
        binary[y * bw + x] = lum < 100
      }
    }

    // Connected components (simple flood fill)
    const seen = new Array(bw * bh).fill(false)
    let components = 0
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const idx = y * bw + x
        if (!binary[idx] || seen[idx]) continue
        // flood fill
        const stack = [idx]
        seen[idx] = true
        let size = 0
        while (stack.length) {
          const cur = stack.pop()!
          size++
          const cy = Math.floor(cur / bw)
          const cx = cur % bw
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const ny = cy + dy, nx = cx + dx
              if (ny < 0 || ny >= bh || nx < 0 || nx >= bw) continue
              const nidx = ny * bw + nx
              if (binary[nidx] && !seen[nidx]) {
                seen[nidx] = true
                stack.push(nidx)
              }
            }
          }
        }
        // Dot-sized blobs only (filter out letter fragments)
        if (size >= 4 && size <= 200) components++
      }
    }

    return Math.min(4, Math.max(1, components))
  }

  return { processing: readonly(processing), error: readonly(error), detectGrid }
}
