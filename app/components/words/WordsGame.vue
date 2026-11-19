<script setup lang="ts">
import type { Point } from "~/utils/boardGeometry";
import type { ScoredWord, Tile } from "~/utils/solver";

import { projectBoardPoint } from "~/utils/boardGeometry";
import { createBoardConsensus } from "~/utils/consensus";
import { selectWordSet, solveBoard } from "~/utils/solver";

const { trie, error: dictionaryError, load: loadWords } = useWordList();
const { videoEl, canvasEl, ready: cameraReady, error: cameraError, start: startCamera, stop: stopCamera, switchCamera, captureFrame } = useCamera();
const { error: ocrError, detectGrid } = useOcr();
const consensus = createBoardConsensus();

const manualMode = ref(false);
const manualTiles = ref<Tile[][]>(Array.from({ length: 4 }, (_, row) =>
  Array.from({ length: 4 }, (_, col) => ({ letter: "", row, col }))));
const scanning = ref(false);
const detection = ref<Point[] | null>(null);
const tiles = ref<Tile[][] | null>(null);
const allWords = ref<ScoredWord[]>([]);
const selectedWords = ref<ScoredWord[]>([]);
const statusLine = ref("Starting…");
const lastSignature = ref("");
const colors = [
  ["#f43f5e", "#fbbf24"],
  ["#22c55e", "#06b6d4"],
  ["#a855f7", "#ec4899"],
  ["#3b82f6", "#a3e635"],
  ["#f97316", "#facc15"],
  ["#14b8a6", "#818cf8"],
  ["#e11d48", "#c084fc"],
  ["#64748b", "#f8fafc"],
];
let scanTimer: ReturnType<typeof setInterval> | null = null;
let revision = 0;
let working = false;
let pending: { frame: HTMLCanvasElement; revision: number } | null = null;

function resetBoard() {
  revision++;
  pending = null;
  consensus.reset();
  detection.value = null;
  tiles.value = null;
  allWords.value = [];
  selectedWords.value = [];
  lastSignature.value = "";
  statusLine.value = "Looking for board…";
}

function toggleManualMode() {
  resetBoard();
  manualMode.value = !manualMode.value;
}

async function changeCamera() {
  resetBoard();
  await switchCamera();
}

function solveCurrent(board: Tile[][]) {
  tiles.value = board;
  if (!trie.value)
    return;
  const signature = board.flat().map(tile => tile.letter).join("|");
  if (signature === lastSignature.value)
    return;
  lastSignature.value = signature;
  allWords.value = solveBoard(board, trie.value);
  selectedWords.value = selectWordSet(board, trie.value);
}

function solveManual() {
  solveCurrent(manualTiles.value.map(row => row.map(tile => ({ ...tile }))));
}

function manualTileAt(i: number): Tile {
  return manualTiles.value[Math.floor(i / 4)]![i % 4]!;
}

const paths = computed(() => {
  if (!detection.value)
    return [];
  const corners = detection.value;
  return selectedWords.value.map(word => word.path.map(step =>
    projectBoardPoint(corners, (step.col + 0.5) / 4, (step.row + 0.5) / 4)));
});

function colorAt(index: number, fraction: number): string {
  const pair = colors[index % colors.length]!;
  const from = pair[0]!;
  const to = pair[1]!;
  const channels = [1, 3, 5].map((offset) => {
    const a = Number.parseInt(from.slice(offset, offset + 2), 16);
    const b = Number.parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(a + (b - a) * fraction);
  });
  return `rgb(${channels.join(",")})`;
}

function startScanning() {
  if (scanTimer)
    return;
  scanning.value = true;
  scanTimer = setInterval(captureSnapshot, 500);
}

function stopScanning() {
  if (scanTimer)
    clearInterval(scanTimer);
  scanTimer = null;
  scanning.value = false;
  revision++;
  pending = null;
}

function captureSnapshot() {
  if (manualMode.value || !cameraReady.value)
    return;
  const source = captureFrame();
  if (!source)
    return;
  const frame = document.createElement("canvas");
  frame.width = source.width;
  frame.height = source.height;
  const context = frame.getContext("2d");
  if (!context) {
    statusLine.value = "Unable to capture snapshot";
    return;
  }
  context.drawImage(source, 0, 0);
  pending = { frame, revision };
  void processSnapshots();
}

async function processSnapshots() {
  if (working)
    return;
  working = true;
  try {
    while (pending) {
      const snapshot: { frame: HTMLCanvasElement; revision: number } = pending;
      pending = null;
      const result = await detectGrid(snapshot.frame);
      if (snapshot.revision !== revision || manualMode.value)
        continue;
      if (!result) {
        consensus.reset();
        tiles.value = null;
        allWords.value = [];
        selectedWords.value = [];
        lastSignature.value = "";
        detection.value = null;
        statusLine.value = ocrError.value ? "Scan failed" : "Board not visible";
        continue;
      }
      detection.value = result.corners;
      const board = consensus.update(result.tiles);
      solveCurrent(board);
      const count = board.flat().filter(tile => tile.letter).length;
      statusLine.value = `Reading board: ${count}/16 confirmed`;
    }
  }
  finally {
    working = false;
  }
}

function visibilityChanged() {
  if (document.hidden)
    stopScanning();
  else
    startScanning();
}

onMounted(async () => {
  document.addEventListener("visibilitychange", visibilityChanged);
  await loadWords();
  await startCamera();
  startScanning();
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", visibilityChanged);
  stopScanning();
  stopCamera();
});
</script>

<template>
  <div class="flex flex-col gap-4 p-4 max-w-2xl mx-auto">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">
        Words
      </h1>
      <div class="flex gap-2 items-center">
        <span v-if="scanning" class="loading loading-spinner loading-sm text-primary" />
        <button
          class="btn btn-sm btn-ghost"
          title="Reset board memory"
          aria-label="Reset board memory"
          @click="resetBoard"
        >
          <Icon name="tabler:refresh" />
        </button>
        <button class="btn btn-sm btn-ghost" aria-label="Switch camera" @click="changeCamera">
          <Icon name="tabler:camera-rotate" />
        </button>
        <button class="btn btn-sm btn-ghost" aria-label="Toggle manual entry" @click="toggleManualMode">
          <Icon name="tabler:keyboard" />
        </button>
      </div>
    </div>

    <div v-if="manualMode" class="card bg-base-200 border-2 border-base-300 p-4">
      <h2 class="font-semibold mb-2">
        Manual Test Grid
      </h2>
      <div class="grid grid-cols-4 gap-2 mb-2">
        <input
          v-for="(_, i) in manualTiles.flat()"
          :key="i"
          :model-value="manualTileAt(i).letter"
          maxlength="1"
          class="input input-bordered text-center uppercase font-mono"
          @input="manualTileAt(i).letter = ($event.target as HTMLInputElement).value.toUpperCase().replace(/[^A-Z]/g, '')"
        >
      </div>
      <p class="text-sm mb-2">
        Enter Q for a QU tile.
      </p>
      <button class="btn btn-primary btn-sm" @click="solveManual">
        Solve
      </button>
    </div>

    <div v-else>
      <div class="relative">
        <video
          ref="videoEl"
          autoplay
          playsinline
          muted
          class="w-full rounded-lg bg-black"
        />
        <canvas ref="canvasEl" class="hidden" />
        <svg
          v-if="detection"
          class="absolute inset-0 w-full h-full pointer-events-none"
          :viewBox="`0 0 ${canvasEl?.width || 1} ${canvasEl?.height || 1}`"
          preserveAspectRatio="none"
        >
          <polygon
            :points="detection.map(p => `${p.x},${p.y}`).join(' ')"
            fill="none"
            stroke="lime"
            stroke-width="3"
            opacity="0.7"
          />
          <template v-for="(path, index) in paths" :key="index">
            <template v-for="(point, i) in path.slice(1)" :key="i">
              <defs>
                <linearGradient
                  :id="`word-${index}-${i}`"
                  gradientUnits="userSpaceOnUse"
                  :x1="path[i]!.x"
                  :y1="path[i]!.y"
                  :x2="point.x"
                  :y2="point.y"
                >
                  <stop offset="0%" :stop-color="colorAt(index, i / (path.length - 1))" />
                  <stop offset="100%" :stop-color="colorAt(index, (i + 1) / (path.length - 1))" />
                </linearGradient>
              </defs>
              <line
                :x1="path[i]!.x"
                :y1="path[i]!.y"
                :x2="point.x"
                :y2="point.y"
                :stroke="`url(#word-${index}-${i})`"
                stroke-width="12"
                stroke-linecap="round"
              />
            </template>
            <circle
              v-if="path[0]"
              :cx="path[0].x"
              :cy="path[0].y"
              r="10"
              :fill="colorAt(index, 0)"
              stroke="white"
              stroke-width="3"
            />
          </template>
        </svg>
      </div>
      <div class="text-sm text-base-content/70 mt-2 text-center">
        {{ statusLine }}
      </div>
      <div v-if="tiles" class="text-sm text-center font-mono" aria-label="Confirmed board">
        {{ tiles.map(row => row.map(tile => tile.letter === "Q" ? "QU" : tile.letter || "?").join(" ")).join(" / ") }}
      </div>
    </div>

    <div v-if="cameraError && !manualMode" class="alert alert-error">
      {{ cameraError }}
    </div>
    <div v-if="ocrError && !manualMode" class="alert alert-error">
      {{ ocrError }}
    </div>
    <div v-if="dictionaryError" class="alert alert-error">
      Dictionary: {{ dictionaryError }}
    </div>

    <div v-if="selectedWords.length" class="card bg-base-200 border-2 border-base-300 p-4">
      <h2 class="font-semibold">
        Suggested words (top to bottom)
      </h2>
      <p class="text-sm">
        Rescan after each play; falling tiles can change remaining paths.
      </p>
      <div v-for="(word, i) in selectedWords" :key="`${word.word}-${i}`" class="flex items-baseline gap-2 mt-1">
        <span :style="{ color: colorAt(i, 0) }" aria-hidden="true">●</span>
        <span class="text-xl font-semibold tracking-wider">{{ word.word.toUpperCase() }}</span>
        <span class="text-sm text-base-content/70">{{ word.score }} pts</span>
      </div>
    </div>
    <div v-else-if="tiles" class="alert alert-info">
      No valid words found on confirmed tiles.
    </div>

    <div v-if="allWords.length" class="collapse collapse-arrow bg-base-200 border-2 border-base-300">
      <input type="checkbox">
      <div class="collapse-title font-medium">
        All words ({{ allWords.length }})
      </div>
      <div class="collapse-content">
        <div class="max-h-48 overflow-y-auto">
          <div v-for="word in allWords.slice(0, 50)" :key="word.word" class="flex justify-between text-sm py-1 border-b border-base-300">
            <span class="uppercase">{{ word.word }}</span>
            <span>{{ word.score }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
