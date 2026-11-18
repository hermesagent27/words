# Words

A phone-camera assistant for the 4x4 word-grid game (Boggle-style with gravity). Hold the phone over the physical board; the app finds the grid, OCRs the letters, solves it, speaks the top word, and after you tap "Played it" simulates the fall and pre-locks the surviving letters so the next board locks in fast.

## Status (handoff to Copilot)

The scanner is functional end-to-end against 8 real test photos (`test/fixtures/board/photo-1..8.jpeg`), at distances from ~3 inches to arms-length, with tilt, fingers in frame, and the blue app backdrop. The detection pipeline is settled. The OCR accuracy and end-game UX are not done.

Last commit on `main`: `72d9c70` - "Board detect at any distance + tilt: combined-hull quad fit, version stamp in footer".

## Architecture

- **Nuxt 4 + Vue 3 + TS + Tailwind v4 + DaisyUI**, Vercel deploy target.
- **Single-user, no auth complexity.** Login page exists as a stub.
- **`GitHub JSON as DB`** convention does not apply here yet; nothing is persisted.

### Key files

- `app/components/words/WordsGame.vue` - the whole game. Camera start, scan tick (500ms), per-cell consensus state, solver call, word list, "Played it" button, gravity sim, guaranteed-next-word card, TTS.
- `app/composables/useOcr.ts` - OpenCV board detection + Tesseract OCR. **The pure detection core `detectQuadFromTiles` lives here and is exercised headlessly by `scripts/smoke-real.mts`.** Keep all algorithm edits inside this exported function so the smoke test keeps meaning what the app does.
- `app/composables/useCamera.ts` - `getUserMedia` wrapper, front/back toggle, frame capture to canvas.
- `app/composables/useWordList.ts` - loads `public/dict/words.txt` into a trie.
- `app/utils/solver.ts` - 4x4 Boggle solver with path tracking, scoring, and `applyGravity` (drop played cells, fall remaining, mark spawns).
- `public/dict/words.txt` - SCOWL common-English list (Tristan explicitly moved off NWL2020 Scrabble).

### Test fixtures

`test/fixtures/board/photo-1..8.jpeg` - 8 real phone photos of the same physical board (expected letters `WORU / RUNT / OORV / TPEG`), covering close / far / tilt / occluded. **Add new photos here when detection regresses.** Do not regenerate synthetics; the smoke test is the source of truth.

### Verification scripts (run from `scripts/`)

- `smoke-real.mts` - headless run of `detectQuadFromTiles` against all 8 fixture photos. Asserts quad sanity + ink verification. **Run this before every commit touching `useOcr.ts`.**
- `probe-real.mts`, `probe-real2.mts` - older iterative detector prototypes kept for reference. `probe-real2.mts` is the direct ancestor of the current algorithm (TILE_MIN=210, no CLOSE).
- `probe-grid.mts`, `probe-grid2.mts` - per-cell OCR probes used to tune the inset + confidence gates.
- `debug-brightness.mts`, `debug-dump.mts`, `debug-real.mts` - one-off dumps kept for forensics; safe to delete if they rot.

Run a script with `npx tsx scripts/smoke-real.mts` (or `node --experimental-strip-types`).

## Detection pipeline (current, working)

This replaced three earlier detector generations (blue-mask -> tile-first + CLOSE -> tile-first + flood-fill union). Read `app/composables/useOcr.ts` header comment for the full narrative.

1. Downscale frame to `WORK_WIDTH = 640`, grayscale.
2. Threshold at adaptive `TILE_MIN` (85th percentile of frame) - tiles are the brightest surface.
3. CLOSE morph with kernel `0.03 * min(W, H)` to heal letter pinholes in each tile without merging tiles.
4. Find external contours, drop blobs under 0.1% of frame.
5. Seed cluster at largest blob; **flood-fill absorb** any blob within 1.3 pitches of any member (pitch = side / 0.86). Iterate until no growth.
6. Convex hull of ALL member contour points -> escalating-`epsilon` `approxPolyDP` (0.01..0.04) -> fallback `minAreaRect` if hull won't simplify to 4 corners. Always yields a quad; handles tilt.
7. Order corners TL, TR, BR, BL. Sanity: 50 <= maxS <= 2 \* minS, maxS^2 >= 0.5% of frame.
8. **Ink verification (fixed INK_MAX=100, NOT Otsu)**: warp quad to 200x200, threshold dark INV, accept ink fraction 0.4%..30%. **Otsu inside the warped quad breaks at close range** because interpolation grays inflate the dark count.
9. Warp gray to `WARP_SIZE=700`, INTER_CUBIC if upscaling else INTER_AREA.
10. Per cell: 18% inset, Otsu BINV, OPEN 2x2, connected components, centroid-within-35% + area/dim gates, crop blob, 2x upscale, Tesseract PSM 10 with ABCDEFGHIJKLMNOPQRSTUVWXYZ whitelist, confidence >= 55.

**Hard-won pitfalls, do not regress:**

- 18% cell inset is not decorative. Rounded tile corners and scoring dots otherwise leak into the glyph blob.
- Use `INK_MAX=100` for the ink check inside the warped quad. Otsu is unstable here.
- The CLOSE kernel must scale with frame size, not tile size, otherwise far boards erode away.
- Single-shot `minAreaRect` on the largest blob fails at close range when tiles stay disjoint. The flood-fill union is what makes close-range work.

## What's next (the actual handoff)

In rough priority order. Each is a self-contained unit of work.

1. **OCR accuracy pass.** Misread rate on `test/fixtures/board/` is higher than the 55-confidence gate suggests; some cells bounce letters frame-to-frame. Consider: per-cell template matching against a small font set, or a Tesseract `classify_bln_numeric_mode`-style tweak, or voting across 3 frames before committing. `probe-grid*.mts` shows the per-cell evidence. The infra for re-voting already exists in `WordsGame.vue` (`voteCell`, `cellState[].missCount`).
2. **Lock/speak UX polish.** Currently a single confident frame commits a cell. That's fast but flickery. Wire `MISS_TOLERANCE` (currently 2) into a "settled" indicator so the user knows when the board is trustworthy. The status line already says "Board locked"; surface it visually.
3. **Persist game history.** The `Production-First Rule` (GitHub JSON as DB) has not been applied. Right now `played` state, `selectedWord`, and `guaranteedNext` are all in-memory. If the user reloads, history is gone.
4. **Move `eng.traineddata` out of the repo root.** It's a 5MB Tesseract language file committed here solely so `scripts/probe-real.mts` can OCR offline. Either move it under `scripts/fixtures/` or pull from `tessdata` at script-time.
5. **Real end-to-end test on a real play session.** All tuning so far is on the 8 fixture photos of one specific board. Take a photo of a different board (different letters / lighting) and add it to `test/fixtures/board/` to catch overfitting.
6. **Delete dead scripts.** `scripts/debug-*.mts` and `scripts/probe-grid*.mts` are scaffolding; once (1) lands, prune.

## Development

```bash
npm install
npm run dev          # http://localhost:3000
npm run lint
npm run typecheck
npx tsx scripts/smoke-real.mts   # headless detection verification
```

Husky pre-commit runs `lint-staged` (eslint --fix on `app/**`, `server/**`, and top-level files). Do not bypass with `--no-verify`; the globs are scoped to avoid `node_modules/`.

## Deploy

Tristan controls deploys. Never trigger a redeploy without his instruction.
