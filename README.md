# Nuxt Minimal Starter

Look at the [Nuxt documentation](https://nuxt.com/docs/getting-started/introduction) to learn more.

## Words scanner

The scanner captures camera snapshots every 500 ms, detects the tile grid,
corrects perspective, and reads all 16 cells. When processing takes longer
than 500 ms, older pending snapshots are discarded; consensus uses consecutive
**processed** snapshots.

A letter is confirmed after two matching reads. Reads require sufficient OCR
confidence, except for a narrow capital I recognized by its shape.
Previously confirmed letters survive a different single read or two unreadable
reads; three consecutive unreadable reads clear the cell. Partial boards can
show preliminary words. Once at least 13 letters are confirmed and there are
suggestions, the app freezes that snapshot and its word paths while continuing
to monitor the camera. After 2 seconds, or once the current word animations and
speech finish if they take longer, it clears the board memory and starts reading
a fresh board; confirming and locking that board can take longer than 2 seconds.
With one or two suggested words, it can also refresh sooner
after at least one confirmed tile changes on each suggested path. With more
than two, it can refresh sooner when one suggested path changes. This happens
even if a previously suggested word can be made again.
If the board is temporarily hidden, the frozen snapshot stays visible until the
timed refresh.
The processed-snapshot counter shows that monitoring is continuing. The app
pauses change tracking when a board appears obstructed or fewer than 13 tiles
are readable. A suggested path only registers a change when all its tiles are
readable and the changed letter is confirmed in consecutive scans.
Obstruction detection checks for large dark patches, not skin color, and may
not recognize every hand or lighting condition.

The scanner cannot tell that a replacement tile has the same letter as the
previous tile. The timed refresh still clears the board memory in that case.

The app prioritizes long, non-overlapping words, trying the largest first when
that leaves a playable sequence; top-to-bottom position breaks ties. It
simulates gravity after each word and only includes follow-up paths whose
original letters remain adjacent.
Replacement tiles are unknown and are not used in the plan. The numbered
paths mark the original snapshot, so later paths can move as tiles fall; the
two-second refresh can produce a new plan. Each word scores one point per
spelled letter; a Q tile spells QU and therefore counts as two letters.
Suggested paths have larger solid-color start markers.
The camera or locked snapshot and suggested words fit within the available
screen.

The dictionary combines the existing SCOWL common-English list (sizes 10–50)
with lowercase alphabetic words of at least three letters from the
[SCOWL/ESDB American English large list, release 2026.02.25](https://github.com/en-wl/wordlist-diff/blob/rel-2026.02.25/en_US-large.txt).
It includes uncommon words, which may change the suggestions. Copyright and
permission notices are in [SCOWL-Copyright.txt](public/dict/SCOWL-Copyright.txt)
and [ESDB-Copyright.txt](public/dict/ESDB-Copyright.txt).

Use the speaker button to enable or mute speech. When enabled, the app reads
each locked board's suggested words once in their displayed order; enabling it
on an already locked board reads that board immediately. Otherwise it says
"Speech enabled" while waiting for a board. Only words are spoken, with a
300 ms pause between them and a speech rate of 0.9. Paths remain visible and
are highlighted segment by segment as each word is spoken, or in order without
speech when muted. Each highlight takes 200 ms for 2–4 letters, 300 ms for 5–7,
and 500 ms for 8 or more. Muting stops speech and restarts the highlights
silently; detecting a changed suggested path stops the previous speech and
highlights. Timed refreshes of the same board do not repeat speech, but do
replay its highlights. Speech is off initially because browsers may require a
user gesture, and availability depends on the browser and installed voices.

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
and OPERON as the best individual word. It also checks
`board-i-reading.JPG` twice against `ULIE UOTI RGGI UIRH`, a blank image,
synthetic QU and narrow I tiles, and simulated obstructions, and reports
processing time. To run just the capital-I photo check, use
`.testCapitalIPhoto()` instead of `.testPhotos()` in the command above.
It does not replace testing with a moving camera, a real finger or real
falling tiles.

## Copilot note: capital I on board-i-reading.JPG

Copilot: adjust the OCR until it reliably reads the letter "I" on
`public/board-i-reading.JPG`. The true letters on this board, left to right,
row by row, are: ULIE UOTI RGGI UIRH.

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
