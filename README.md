# Nuxt Minimal Starter

Look at the [Nuxt documentation](https://nuxt.com/docs/getting-started/introduction) to learn more.

## Words scanner

The camera preview stays live while the scanner captures a snapshot every
500 ms. It detects the tile grid, corrects perspective, and reads all 16
cells. When processing takes longer than 500 ms, older pending snapshots are
discarded; consensus uses consecutive **processed** snapshots.

A letter is confirmed after two matching, sufficiently confident reads.
Previously confirmed letters survive a different single read or two unreadable
reads; three consecutive unreadable reads clear the cell. Losing the board
clears its memory. Words are recalculated from confirmed cells, including on
partial boards, without waiting for a played word's tiles to change. Use
**Reset board memory** to clear a persistent wrong read.

The suggested set maximizes the combined score of non-overlapping words. Each
path has its own gradient, starting at its marked solid-color circle. Words
are listed roughly top to bottom. Gravity may still move remaining paths, so
rescan after every play. The full word list remains available separately; the
best individual word need not be part of the best combined set. A Q tile
spells QU and scores 10 points; enter Q in manual mode.

Run scanner and gravity checks with:

```bash
node --experimental-strip-types --test scripts/test-scanner.mts scripts/test-gravity.mts
```

To test the eight photos, start the development server and sign in, then run
the following in that page's browser developer console. Replace the path with
the absolute project path, using `/` in the URL:

```js
await (await import("/_nuxt/@fs/C:/absolute/path/to/words/scripts/test-photos.ts")).testPhotos();
```

The photo test checks two repeated still-image reads, the expected 16 letters,
and TORPOR as the best individual word. It also checks a blank image and a
synthetic QU tile, and reports processing time. It does not replace testing
with a moving camera or real falling tiles.

## Repository Structure

- `data/`: Aggregate data that is the main data source for the app.
- `docs/`: Documentation for what things are and what they should do.
- `frontend/`: The Nuxt application.
- `scripts/`: Agent Python scripts, including skills and general scripts.
- `.hermes/plans/`: Planning files for the agent to logically plan out features.

## Setup

Make sure to install dependencies:

```bash
# npm
npm install
```

## Development Server

Start the development server on `http://localhost:3000`:

```bash
# npm
npm run dev
```

## Production

Build the application for production:

```bash
# npm
npm run build
```

Locally preview production build:

```bash
# npm
npm run preview
```

Check out the [deployment documentation](https://nuxt.com/docs/getting-started/deployment) for more information.
