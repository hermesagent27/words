# Nuxt Minimal Starter

Look at the [Nuxt documentation](https://nuxt.com/docs/getting-started/introduction) to learn more.

## Words scanner

The scanner keeps the existing two-frame letter consensus. Once it has a
complete board, it watches the suggested word and assumes it was played when
every cell on that path has a different readable letter in two consecutive
unobstructed scans. Use **Played it** if a new or falling tile has the same
letter as before. Use **Use next word** or tap a backup before playing it.

After a play, unused tiles keep their order as they fall. Their letters are
locked at the predicted positions, and OCR reads the new cells at the top.
The scanner also reads the selected word's path to detect the next play.
Use **Reset board memory** after a reshuffle, a wrong read, or a play the app
did not track. Automatic recognition cannot distinguish a replacement tile
that happens to have the same letter, and a wrong starting read can persist
until reset.

Gravity checks can be run with:

```bash
node --experimental-strip-types scripts/test-gravity.mts
```

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
