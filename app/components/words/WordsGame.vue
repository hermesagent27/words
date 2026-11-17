<script setup lang="ts">
import type { GravityResult, ScoredWord, Tile } from "~/utils/solver";

import { applyGravity, bestDisjointWord, solveBoard } from "~/utils/solver";

const { trie, load: loadWords } = useWordList();
const { videoEl, canvasEl, ready: cameraReady, error: cameraError, start: startCamera, stop: stopCamera, switchCamera, captureFrame } = useCamera();
const { processing, detectGrid } = useOcr();

const manualMode = ref(false);
const manualTiles = ref<Tile[][]>(
  Array.from({ length: 4 }, (_, r) =>
    Array.from({ length: 4 }, (_, c) => ({ letter: "", row: r, col: c }))),
);
// Type-safe accessor for the template's v-for over the flat index.
function manualTileAt(i: number): Tile {
  return manualTiles.value[Math.floor(i / 4)]![i % 4]!;
}

const scanning = ref(false);
const detection = ref<{ corners: Array<{ x: number; y: number }> } | null>(null);
const tiles = ref<(Tile | null)[][] | null>(null);
const allWords = ref<ScoredWord[]>([]);
const lastSignature = ref<string>("");
const statusLine = ref("Starting…");

// ---------------------------------------------------------------------
// Played-word selection. The camera never sees the tap, so the user
// tells the app which word they actually played by tapping it (defaults
// to the top suggestion). The selection drives:
//   1) the red overlay path,
//   2) the best disjoint companion word (cyan overlay),
//   3) the gravity simulation for cell locking + guaranteed next word.
// ---------------------------------------------------------------------
const selectedWord = ref<ScoredWord | null>(null);
const secondWord = ref<ScoredWord | null>(null);
const gravity = ref<GravityResult | null>(null);
const guaranteedNext = ref<ScoredWord[]>([]);

// ---------------------------------------------------------------------
// Per-cell state machine. Each cell has:
//   - a live consensus vote (candidate/committed/missCount), and
//   - an expected letter + lock state driven by the game history.
//
// Locking rule (Tristan's pick): after a word is played, cells whose
// letter did NOT change position or value are locked. They are exempt
// from re-voting, miss counting, and quick-clear wiping. Fallen and
// newly spawned cells carry an `expected` letter (fallen: known letter
// from above; spawned: ''), and a mismatched read immediately unlocks
// them (fall tile OCR'd wrong, game reshuffled, etc).
// ---------------------------------------------------------------------
const CONSENSUS_FRAMES = 2;
const MISS_TOLERANCE = 3;
const QUICK_CLEAR_MISSES = 2;
const QUICK_CLEAR_RATIO = 0.5;
type CellState = {
  candidate: string;
  candidateCount: number;
  committed: string;
  missCount: number;
  locked: boolean;
  expected: string;
};
function freshCell(): CellState {
  return { candidate: "", candidateCount: 0, committed: "", missCount: 0, locked: false, expected: "" };
}
const cellState: CellState[][] = Array.from({ length: 4 }, () =>
  Array.from({ length: 4 }, () => freshCell()));

function resetCellStates() {
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++)
      cellState[r]![c] = freshCell();
  }
}

// Vote a new read into an unlocked cell; unlock on contradiction with the
// expected letter. Returns the committed letter (or '' if none yet).
function voteCell(r: number, c: number, read: string): string {
  const s = cellState[r]![c]!;
  if (s.expected && read && read !== s.expected) {
    // Reality disagrees with the simulated game state: trust the camera.
    s.locked = false;
    s.expected = "";
    s.committed = "";
    s.candidate = read;
    s.candidateCount = 1;
    s.missCount = 0;
  }
  if (read === "") {
    s.candidate = "";
    s.candidateCount = 0;
    s.missCount++;
    if (s.missCount >= MISS_TOLERANCE) {
      s.committed = "";
      s.missCount = 0;
    }
    return s.committed;
  }
  s.missCount = 0;
  if (s.candidate === read) {
    s.candidateCount++;
  }
  else {
    s.candidate = read;
    s.candidateCount = 1;
  }
  if (s.candidateCount >= CONSENSUS_FRAMES && s.committed !== s.candidate)
    s.committed = s.candidate;
  return s.committed;
}

const SCAN_INTERVAL_MS = 700;
let scanTimer: ReturnType<typeof setInterval> | null = null;
// True only when the current frame shows a real, settled board. Gates both
// the path drawing and the word card so stale results never linger while
// the game is loading a new board or solving a different word.
const boardVisible = ref(false);

function pathPoints(w: ScoredWord | null): Array<{ x: number; y: number }> {
  if (!w || !detection.value || !canvasEl.value)
    return [];
  const c = detection.value.corners;
  const path: Array<{ x: number; y: number }> = [];
  for (const step of w.path) {
    const u = (step.col + 0.5) / 4;
    const v = (step.row + 0.5) / 4;
    const x = (1 - u) * (1 - v) * c[0]!.x + u * (1 - v) * c[1]!.x + u * v * c[2]!.x + (1 - u) * v * c[3]!.x;
    const y = (1 - u) * (1 - v) * c[0]!.y + u * (1 - v) * c[1]!.y + u * v * c[2]!.y + (1 - u) * v * c[3]!.y;
    path.push({ x, y });
  }
  return path;
}

const bestPath = computed(() => pathPoints(selectedWord.value));
const secondPath = computed(() => pathPoints(secondWord.value));

onMounted(async () => {
  await loadWords();
  await startCamera();
  startScanning();
});

onUnmounted(() => {
  stopScanning();
  stopCamera();
});

function startScanning() {
  if (scanTimer)
    return;
  scanTimer = setInterval(scanTick, SCAN_INTERVAL_MS);
  scanning.value = true;
}

function stopScanning() {
  if (scanTimer)
    clearInterval(scanTimer);
  scanTimer = null;
  scanning.value = false;
}

async function scanTick() {
  if (manualMode.value || !cameraReady.value || processing.value)
    return;
  const frame = captureFrame();
  if (!frame)
    return;

  statusLine.value = "Looking for board…";
  const result = await detectGrid(frame);
  if (!result) {
    clearBoardDisplay("Board not visible");
    return;
  }

  const committedTiles: (Tile | null)[][] = [];
  let readCount = 0;

  // Pass 1: vote every UNLOCKED cell. Locked cells skip the vote entirely
  // (their letter survived the last play untouched, so the only way they
  // change is a contradiction unlock) and never accumulate misses.
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const s = cellState[r]![c]!;
      if (!s.locked) {
        const read = result.tiles[r]![c]!.letter;
        if (read)
          readCount++;
        voteCell(r, c, read);
      }
    }
  }

  // Pass 2: promote expected letters and assemble the committed board.
  for (let r = 0; r < 4; r++) {
    const rowTiles: (Tile | null)[] = [];
    for (let c = 0; c < 4; c++) {
      const s = cellState[r]![c]!;
      // A fallen cell's letter is already known; commit it as soon as the
      // camera agrees (or immediately while it is still mid-fall blank).
      if (!s.locked && s.expected && (!s.committed || s.committed !== s.expected)
        && (s.committed === s.expected || s.missCount >= 1 || s.candidate === s.expected)) {
        s.committed = s.expected;
        s.expected = "";
        s.locked = true;
        s.candidate = "";
        s.candidateCount = 0;
        s.missCount = 0;
      }
      rowTiles.push(s.committed ? { letter: s.committed, row: r, col: c } : null);
    }
    committedTiles.push(rowTiles);
  }

  // Quick-clear bail, counting only unlocked cells: a board mid-change has
  // most unlocked cells blank for 2 straight frames. Locked cells are
  // excluded so their stability never masks a wipe of the changing region.
  let unlocked = 0;
  let unlockedMissing = 0;
  let recentlyMissed = 0;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const s = cellState[r]![c]!;
      if (s.locked)
        continue;
      unlocked++;
      if (!s.committed)
        unlockedMissing++;
      if (s.missCount >= QUICK_CLEAR_MISSES)
        recentlyMissed++;
    }
  }
  const occluded = result.inkCoverage >= 0.5;
  if (unlocked > 0 && !occluded
    && (unlockedMissing / unlocked >= 0.75 || recentlyMissed >= QUICK_CLEAR_RATIO * unlocked || readCount < 3)) {
    clearBoardDisplay("Board changing…");
    return;
  }

  boardVisible.value = true;

  // Signature over the committed board (nulls as blanks); stable-board
  // frames only refresh the overlay geometry.
  const sig = committedTiles.flat().map(t => t?.letter || "").join("|");
  if (sig === lastSignature.value) {
    detection.value = { corners: result.corners };
    statusLine.value = "Board locked";
    return;
  }

  lastSignature.value = sig;
  detection.value = { corners: result.corners };
  tiles.value = committedTiles;
  statusLine.value = "Solving…";
  solveCurrent();
  statusLine.value = "Board locked";
}

/**
 * Hide the stale word + path immediately; per-cell letters stay committed
 * so a settled board re-locks instantly without re-voting every cell.
 * Game-history predictions (expected/locked) are kept too: a transient
 * board-out-of-frame should not discard what we know about the fall.
 */
function clearBoardDisplay(reason: string) {
  detection.value = null;
  boardVisible.value = false;
  lastSignature.value = "";
  statusLine.value = reason;
}

/**
 * Tap-to-play: mark a word as played on the real board. The solver
 * simulates gravity so the scanner knows which cells to keep (stable ->
 * locked), which to recheck (fallen -> expected letter), and which are
 * brand new (spawned).
 */
function playWord(w: ScoredWord) {
  if (!tiles.value)
    return;
  const g = applyGravity(tiles.value, w.path);
  gravity.value = g;
  for (const p of g.stable) {
    const s = cellState[p.row]![p.col]!;
    if (s.committed)
      s.locked = true;
  }
  for (const p of g.fallen) {
    const s = cellState[p.row]![p.col]!;
    s.locked = false;
    s.expected = g.board[p.row]![p.col]!.letter;
    s.committed = "";
    s.candidate = "";
    s.candidateCount = 0;
    s.missCount = 0;
  }
  for (const p of g.spawned) {
    const s = cellState[p.row]![p.col]!;
    s.locked = false;
    s.expected = "";
    s.committed = "";
    s.candidate = "";
    s.candidateCount = 0;
    s.missCount = 0;
  }
  // Force the next scan to re-solve against the post-play board instead of
  // matching the pre-play signature.
  lastSignature.value = "";
  // Guaranteed next word: known letters only (stable + fallen), no guesses
  // about what spawns on top.
  if (trie.value) {
    const known = solveBoard(g.board, trie.value);
    guaranteedNext.value = known.slice(0, 3);
  }
  statusLine.value = `Played ${w.word.toUpperCase()} — watching for the fall…`;
}

function solveManual() {
  tiles.value = manualTiles.value;
  detection.value = null;
  boardVisible.value = true;
  solveCurrent();
}

function solveCurrent() {
  if (!tiles.value || !trie.value)
    return;
  allWords.value = solveBoard(tiles.value, trie.value);
  const top = allWords.value.length ? allWords.value[0]! : null;
  // Keep the user's tapped word selected while it is still on the board;
  // otherwise fall back to the top suggestion.
  if (selectedWord.value && allWords.value.some(w => w.word === selectedWord.value!.word)) {
    selectedWord.value = allWords.value.find(w => w.word === selectedWord.value!.word)!;
  }
  else {
    selectedWord.value = top;
  }
  secondWord.value = selectedWord.value ? bestDisjointWord(allWords.value, selectedWord.value) : null;
}

watch(selectedWord, (w) => {
  secondWord.value = w ? bestDisjointWord(allWords.value, w) : null;
});

// Pause scanning when tab hidden to save battery
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden)
      stopScanning();
    else startScanning();
  });
}
</script>

<template>
  <div class="flex flex-col gap-4 p-4 max-w-2xl mx-auto">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">
        Words
      </h1>
      <div class="flex gap-2 items-center">
        <span v-if="scanning" class="loading loading-spinner loading-sm text-primary" />
        <button class="btn btn-sm btn-ghost" title="Reset board memory" @click="resetCellStates(); lastSignature = ''">
          <Icon name="tabler:refresh" />
        </button>
        <button class="btn btn-sm btn-ghost" @click="switchCamera">
          <Icon name="tabler:camera-rotate" />
        </button>
        <button class="btn btn-sm btn-ghost" @click="manualMode = !manualMode">
          <Icon name="tabler:keyboard" />
        </button>
      </div>
    </div>

    <!-- Manual test mode -->
    <div v-if="manualMode" class="card bg-base-200 border-2 border-base-300 p-4">
      <h2 class="font-semibold mb-2">
        Manual Test Grid
      </h2>
      <div class="grid grid-cols-4 gap-2 mb-2">
        <input
          v-for="(t, i) in manualTiles.flat()"
          :key="i"
          :model-value="manualTileAt(i).letter"
          maxlength="1"
          class="input input-bordered text-center uppercase font-mono"
          @input="manualTileAt(i).letter = ($event.target as HTMLInputElement).value.toUpperCase()"
        >
      </div>
      <button class="btn btn-primary btn-sm" @click="solveManual">
        Solve
      </button>
    </div>

    <!-- Camera view -->
    <div v-else class="relative">
      <video
        ref="videoEl"
        autoplay
        playsinline
        muted
        class="w-full rounded-lg bg-black"
      />
      <canvas ref="canvasEl" class="hidden" />

      <!-- Overlay: board outline + selected word (red) + disjoint companion
           word (cyan). boardVisible gates the drawing so it disappears the
           moment the board leaves the frame. -->
      <svg
        v-if="detection"
        class="absolute inset-0 w-full h-full pointer-events-none"
        :viewBox="`0 0 ${canvasEl?.width || 1} ${canvasEl?.height || 1}`"
        preserveAspectRatio="none"
      >
        <polygon
          :points="detection.corners.map(p => `${p.x},${p.y}`).join(' ')"
          fill="none"
          stroke="lime"
          stroke-width="3"
          opacity="0.7"
        />
        <template v-if="boardVisible">
          <polyline
            v-if="secondPath.length > 1"
            :points="secondPath.map(p => `${p.x},${p.y}`).join(' ')"
            fill="none"
            stroke="cyan"
            stroke-width="10"
            stroke-linecap="round"
            stroke-linejoin="round"
            opacity="0.75"
          />
          <polyline
            v-if="bestPath.length > 1"
            :points="bestPath.map(p => `${p.x},${p.y}`).join(' ')"
            fill="none"
            stroke="red"
            stroke-width="12"
            stroke-linecap="round"
            stroke-linejoin="round"
            opacity="0.9"
          />
          <circle
            v-for="(p, i) in bestPath"
            :key="i"
            :cx="p.x"
            :cy="p.y"
            r="6"
            fill="white"
            opacity="0.8"
          />
        </template>
      </svg>

      <div v-if="cameraError" class="alert alert-error mt-2">
        {{ cameraError }}
      </div>

      <!-- Status line -->
      <div class="text-sm text-base-content/70 mt-2 text-center">
        {{ statusLine }}
      </div>
    </div>

    <!-- Result: selected word large; tap any listed word to mark it played.
         Hidden entirely while the board is mid-load/mid-solve. -->
    <div v-if="selectedWord && boardVisible" class="card bg-base-200 border-2 border-base-300 p-4">
      <div class="flex items-baseline gap-2 flex-wrap">
        <span class="text-3xl font-bold tracking-widest text-error">{{ selectedWord.word.toUpperCase() }}</span>
        <span class="text-lg text-base-content/70">{{ selectedWord.score }} pts</span>
        <button class="btn btn-xs btn-outline btn-error ml-auto" @click="playWord(selectedWord)">
          Played it
        </button>
      </div>
      <div v-if="secondWord" class="flex items-baseline gap-2 mt-1">
        <span class="text-xl font-semibold tracking-wider text-info">{{ secondWord.word.toUpperCase() }}</span>
        <span class="text-sm text-base-content/70">{{ secondWord.score }} pts — also playable, no shared tiles</span>
      </div>
      <div
        v-for="w in allWords.slice(0, 6).filter(x => x.word !== selectedWord?.word && x.word !== secondWord?.word)"
        :key="w.word"
        class="flex items-baseline gap-2 mt-1 opacity-80"
      >
        <button class="text-xl font-semibold tracking-wider underline decoration-dotted" @click="selectedWord = w">
          {{ w.word.toUpperCase() }}
        </button>
        <span class="text-sm text-base-content/70">{{ w.score }} pts</span>
        <button class="btn btn-xs btn-ghost ml-auto" @click="playWord(w)">
          played
        </button>
      </div>
    </div>

    <!-- Guaranteed next word: solvable from the letters that survive the
         fall, no dependency on what spawns at the top. -->
    <div v-if="guaranteedNext.length && boardVisible" class="card bg-base-200 border-2 border-base-300 p-3">
      <div class="text-sm font-semibold text-base-content/70 mb-1">
        After the fall (guaranteed)
      </div>
      <div v-for="w in guaranteedNext" :key="w.word" class="flex items-baseline gap-2">
        <span class="text-lg font-semibold tracking-wider">{{ w.word.toUpperCase() }}</span>
        <span class="text-sm text-base-content/70">{{ w.score }} pts</span>
      </div>
    </div>

    <div v-else-if="!manualMode && detection && !selectedWord && boardVisible" class="alert alert-info">
      No valid words found on this board.
    </div>

    <!-- Word list (top 50) -->
    <div v-if="allWords.length" class="collapse collapse-arrow bg-base-200 border-2 border-base-300">
      <input type="checkbox">
      <div class="collapse-title font-medium">
        All words ({{ allWords.length }})
      </div>
      <div class="collapse-content">
        <div class="max-h-48 overflow-y-auto">
          <div
            v-for="w in allWords.slice(0, 50)"
            :key="w.word"
            class="flex justify-between text-sm py-1 border-b border-base-300"
            :class="{ 'font-bold text-error': w.word === selectedWord?.word, 'font-bold text-info': w.word === secondWord?.word }"
          >
            <span class="uppercase">{{ w.word }}</span>
            <span>{{ w.score }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
