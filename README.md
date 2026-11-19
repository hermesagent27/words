# Nuxt Minimal Starter

Look at the [Nuxt documentation](https://nuxt.com/docs/getting-started/introduction) to learn more.

## Words scanner

The scanner captures camera snapshots every 500 ms, detects the tile grid,
corrects perspective, and reads all 16 cells. When processing takes longer
than 500 ms, older pending snapshots are discarded; consensus uses consecutive
**processed** snapshots.

A letter is confirmed after two matching, sufficiently confident reads.
Previously confirmed letters survive a different single read or two unreadable
reads; three consecutive unreadable reads clear the cell. Partial boards can
show preliminary words. Once all 16 letters are confirmed and there are
suggestions, the app freezes that snapshot and its word paths while continuing
to monitor the camera. It refreshes after at least one confirmed tile changes
on each suggested path, even if a previously suggested word can be made again.
If the board is temporarily hidden, the frozen snapshot stays visible. Use
**Reset board memory** to release it or clear a persistent wrong read.

The scanner cannot tell that a replacement tile has the same letter as the
previous tile. If that prevents a suggested path from registering a change,
use **Reset board memory**.

The suggested set maximizes the combined score of non-overlapping words. Each
path has a larger solid-color start marker: the first four fade from red to
orange, yellow to lime, green to teal, and light blue to purple; later paths
are black. Words are listed roughly top to bottom. Gravity may still move
remaining paths, so the frozen paths are only a guide. The full word list
remains available separately; the best individual word need not be part of
the best combined set. A Q tile spells QU and scores 10 points.

Use the speaker button to enable or mute speech. When enabled, the app reads
each locked board's suggested words once in their displayed order; enabling it
on an already locked board reads that board immediately. Resetting, muting, or
refreshing a locked board stops the previous speech. Speech is off initially
because browsers may require a user gesture, and availability depends on the
browser and installed voices.

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
