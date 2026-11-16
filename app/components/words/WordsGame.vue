<script setup lang="ts">
import type { ScoredWord, Tile } from "~/utils/solver";

import { solveBoard } from "~/utils/solver";

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
const tiles = ref<Tile[][] | null>(null);
const allWords = ref<ScoredWord[]>([]);
const bestWord = ref<ScoredWord | null>(null);
const lastSignature = ref<string>("");
const statusLine = ref("Starting…");

// Per-cell consensus voting. Each cell has a candidate letter (latest read)
// and a stable letter (committed). A letter is only committed after
// CONSENSUS_FRAMES consecutive scans agree. Blurry/glare frames that read
// '' or the wrong letter don't drop the committed letter immediately; we
// tolerate up to MISS_TOLERANCE misses before clearing it.
// This stops the constant flicker/rescan of single cells under glare.
const CONSENSUS_FRAMES = 2;
const MISS_TOLERANCE = 3;
// Faster than the old 3-miss tolerance: while a game is loading or solving
// for another word, most cells fail to read for 2 consecutive frames. That
// is the signal to wipe the old word + drawing immediately.
const QUICK_CLEAR_MISSES = 2;
const QUICK_CLEAR_RATIO = 0.5;
type CellState = { candidate: string; candidateCount: number; committed: string; missCount: number };
const cellState: CellState[][] = Array.from({ length: 4 }, () =>
  Array.from({ length: 4 }, () => ({ candidate: "", candidateCount: 0, committed: "", missCount: 0 })));

// Vote a new read into the cell. Returns the committed letter (or '' if none yet).
function voteCell(r: number, c: number, read: string): string {
  const s = cellState[r]![c]!;
  if (read === "") {
    s.candidate = "";
    s.candidateCount = 0;
    s.missCount++;
    // Tolerate transient blanks (glare, shake) before clearing the letter.
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
  if (s.candidateCount >= CONSENSUS_FRAMES && s.committed !== s.candidate) {
    s.committed = s.candidate;
  }
  return s.committed;
}

const SCAN_INTERVAL_MS = 700;
let scanTimer: ReturnType<typeof setInterval> | null = null;
// True only when the current frame shows a real, settled board. Gates both
// the path drawing and the word card so stale results never linger while
// the game is loading a new board or solving a different word.
const boardVisible = ref(false);
const nextWords = computed(() => allWords.value.slice(1, 3));

const bestPath = computed(() => {
  if (!bestWord.value || !detection.value || !canvasEl.value)
    return [];
  const c = detection.value.corners;
  const path: Array<{ x: number; y: number }> = [];
  for (const step of bestWord.value.path) {
    const u = (step.col + 0.5) / 4;
    const v = (step.row + 0.5) / 4;
    const x = (1 - u) * (1 - v) * c[0]!.x + u * (1 - v) * c[1]!.x + u * v * c[2]!.x + (1 - u) * v * c[3]!.x;
    const y = (1 - u) * (1 - v) * c[0]!.y + u * (1 - v) * c[1]!.y + u * v * c[2]!.y + (1 - u) * v * c[3]!.y;
    path.push({ x, y });
  }
  return path;
});

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

  // Vote each cell's fresh read into its consensus state. Committed letters
  // only change after CONSENSUS_FRAMES consecutive matching reads.
  let readCount = 0;
  let recentlyMissed = 0;
  const committedTiles: Tile[][] = [];
  for (let r = 0; r < 4; r++) {
    const rowTiles: Tile[] = [];
    for (let c = 0; c < 4; c++) {
      const read = result.tiles[r]![c]!.letter;
      if (read)
        readCount++;
      const committed = voteCell(r, c, read);
      if (cellState[r]![c]!.missCount >= QUICK_CLEAR_MISSES)
        recentlyMissed++;
      rowTiles.push({ letter: committed, row: r, col: c });
    }
    committedTiles.push(rowTiles);
  }

  // Quick-change bail: while the game is between words/boards, most cells
  // read blank for 2 straight frames. Wipe the old word and drawing now
  // instead of waiting out the per-cell miss tolerance.
  //
  // BUT: a finger on the board during manual word entry occludes cells so
  // they also read blank. Distinguish by ink coverage: cells under a finger
  // go mostly dark in the binary image, so an occluded board has high
  // coverage. Never clear results while the user is actually tracing.
  const occluded = result.inkCoverage >= 0.5;
  if (!occluded && (recentlyMissed >= QUICK_CLEAR_RATIO * 16 || readCount < 3)) {
    clearBoardDisplay("Board changing…");
    return;
  }

  boardVisible.value = true;

  // Compute signature of this committed board to detect changes
  const sig = committedTiles.flat().map(t => t.letter).join("|");
  if (sig === lastSignature.value) {
    // Same board, refresh path overlay but don't re-solve
    detection.value = { corners: result.corners };
    statusLine.value = "Board locked";
    return;
  }

  lastSignature.value = sig;
  detection.value = { corners: result.corners };
  tiles.value = committedTiles;
  statusLine.value = "Solving…";
  solveCurrent();
  statusLine.value = `Board locked — ${committedTiles.flat().map(t => t.letter || "?").join(" ")}`;
}

/**
 * Hide the stale word + path immediately; per-cell letters stay committed
 *  so a settled board re-locks instantly without re-voting every cell.
 */
function clearBoardDisplay(reason: string) {
  detection.value = null;
  boardVisible.value = false;
  lastSignature.value = "";
  statusLine.value = reason;
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
  bestWord.value = allWords.value.length ? allWords.value[0]! : null;
}

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

      <!-- Overlay: board outline + word path. boardVisible gates the whole
           drawing so it disappears the moment the board leaves the frame. -->
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

    <!-- Result: #1 word large, next 2 smaller below it. Hidden entirely
         while the board is mid-load/mid-solve (boardVisible=false). -->
    <div v-if="bestWord && boardVisible" class="card bg-base-200 border-2 border-base-300 p-4">
      <div class="flex items-baseline gap-2">
        <span class="text-3xl font-bold tracking-widest">{{ bestWord.word.toUpperCase() }}</span>
        <span class="text-lg text-base-content/70">{{ bestWord.score }} pts</span>
      </div>
      <div
        v-for="w in nextWords"
        :key="w.word"
        class="flex items-baseline gap-2 mt-1 opacity-80"
      >
        <span class="text-xl font-semibold tracking-wider">{{ w.word.toUpperCase() }}</span>
        <span class="text-sm text-base-content/70">{{ w.score }} pts</span>
      </div>
    </div>

    <div v-else-if="!manualMode && detection" class="alert alert-info">
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
            :class="{ 'font-bold text-primary': w.word === bestWord?.word }"
          >
            <span class="uppercase">{{ w.word }}</span>
            <span>{{ w.score }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
