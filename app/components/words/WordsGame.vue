<script setup lang="ts">
import type { Point } from "~/utils/boardGeometry";
import type { ScoredWord, Tile } from "~/utils/solver";

import { projectBoardPoint } from "~/utils/boardGeometry";
import { createBoardConsensus, createWordChangeMonitor } from "~/utils/consensus";
import { selectWordSet, solveBoard } from "~/utils/solver";
import { createWordSpeech } from "~/utils/wordSpeech";

const { trie, error: dictionaryError, load: loadWords } = useWordList();
const { videoEl, canvasEl, ready: cameraReady, error: cameraError, start: startCamera, stop: stopCamera, captureFrame } = useCamera();
const { error: ocrError, detectGrid } = useOcr();
const consensus = createBoardConsensus();
const snapshotEl = ref<HTMLCanvasElement | null>(null);
const frozen = ref<{ width: number; height: number } | null>(null);

const speechEnabled = ref(false);
const speechSupported = ref(false);
const speechError = ref<string | null>(null);
const scanning = ref(false);
const detection = ref<Point[] | null>(null);
const tiles = ref<Tile[][] | null>(null);
const allWords = ref<ScoredWord[]>([]);
const selectedWords = ref<ScoredWord[]>([]);
const statusLine = ref("Starting…");
const lastSignature = ref("");
const colors = [
  ["#ef4444", "#f97316"],
  ["#facc15", "#84cc16"],
  ["#16a34a", "#14b8a6"],
  ["#7dd3fc", "#a855f7"],
];
const defaultColors = ["#000000", "#000000"];
let scanTimer: ReturnType<typeof setInterval> | null = null;
let revision = 0;
let working = false;
let pending: { frame: HTMLCanvasElement; revision: number } | null = null;
let monitor: ReturnType<typeof createWordChangeMonitor> | null = null;
let speech: ReturnType<typeof createWordSpeech<SpeechSynthesisUtterance>> | null = null;

function resetBoard() {
  speech?.stop();
  revision++;
  pending = null;
  consensus.reset();
  frozen.value = null;
  monitor = null;
  detection.value = null;
  tiles.value = null;
  allWords.value = [];
  selectedWords.value = [];
  lastSignature.value = "";
  statusLine.value = "Looking for board…";
}

function toggleSpeech() {
  if (!speech)
    return;
  speechEnabled.value = !speechEnabled.value;
  speechError.value = null;
  if (!speechEnabled.value) {
    speech.stop();
    return;
  }
  if (frozen.value)
    speech.speak(selectedWords.value.map(word => word.word));
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

const paths = computed(() => {
  if (!detection.value)
    return [];
  const corners = detection.value;
  return selectedWords.value.map(word => word.path.map(step =>
    projectBoardPoint(corners, (step.col + 0.5) / 4, (step.row + 0.5) / 4)));
});

function colorAt(index: number, fraction: number): string {
  const pair = colors[index] ?? defaultColors;
  const from = pair[0]!;
  const to = pair[1]!;
  const channels = [1, 3, 5].map((offset) => {
    const a = Number.parseInt(from.slice(offset, offset + 2), 16);
    const b = Number.parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(a + (b - a) * fraction);
  });
  return `rgb(${channels.join(",")})`;
}

function lockSnapshot(frame: HTMLCanvasElement, board: Tile[][]) {
  const canvas = snapshotEl.value;
  if (!canvas) {
    statusLine.value = "Unable to display snapshot";
    return;
  }
  canvas.width = frame.width;
  canvas.height = frame.height;
  const context = canvas.getContext("2d");
  if (!context) {
    statusLine.value = "Unable to display snapshot";
    return;
  }
  context.drawImage(frame, 0, 0);
  frozen.value = { width: frame.width, height: frame.height };
  monitor = createWordChangeMonitor(board, selectedWords.value);
  statusLine.value = `Board locked — 0/${selectedWords.value.length} suggested words changed`;
  if (speechEnabled.value && speech) {
    speechError.value = null;
    speech.speak(selectedWords.value.map(word => word.word));
  }
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
  if (!cameraReady.value)
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
      if (snapshot.revision !== revision)
        continue;
      if (!result) {
        consensus.reset();
        if (frozen.value) {
          statusLine.value = ocrError.value ? "Scan failed — keeping snapshot" : "Board not visible — keeping snapshot";
          continue;
        }
        tiles.value = null;
        allWords.value = [];
        selectedWords.value = [];
        lastSignature.value = "";
        detection.value = null;
        statusLine.value = ocrError.value ? "Scan failed" : "Board not visible";
        continue;
      }
      const board = consensus.update(result.tiles);
      if (monitor) {
        const progress = monitor.update(board);
        if (!progress.complete) {
          statusLine.value = `Board locked — ${progress.count}/${progress.total} suggested words changed`;
          continue;
        }
        speech?.stop();
        monitor = null;
        frozen.value = null;
      }
      detection.value = result.corners;
      solveCurrent(board);
      const count = board.flat().filter(tile => tile.letter).length;
      statusLine.value = `Reading board: ${count}/16 confirmed`;
      if (count === 16 && selectedWords.value.length)
        lockSnapshot(snapshot.frame, board);
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
  if ("speechSynthesis" in window && window.speechSynthesis
    && typeof window.speechSynthesis.speak === "function"
    && typeof window.speechSynthesis.cancel === "function"
    && typeof window.SpeechSynthesisUtterance === "function") {
    speech = createWordSpeech(
      window.speechSynthesis,
      text => new SpeechSynthesisUtterance(text),
      message => speechError.value = message,
    );
    speechSupported.value = true;
  }
  else {
    speechError.value = "Text-to-speech is not supported in this browser.";
  }
  document.addEventListener("visibilitychange", visibilityChanged);
  await loadWords();
  await startCamera();
  startScanning();
});

onUnmounted(() => {
  speech?.stop();
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
        <button
          class="btn btn-sm btn-ghost"
          :title="speechEnabled ? 'Mute spoken words' : 'Enable spoken words'"
          aria-label="Read words aloud"
          :aria-pressed="speechEnabled"
          :disabled="!speechSupported"
          @click="toggleSpeech"
        >
          <Icon :name="speechEnabled ? 'tabler:volume' : 'tabler:volume-off'" />
        </button>
      </div>
    </div>

    <div>
      <div class="relative">
        <video
          ref="videoEl"
          autoplay
          playsinline
          muted
          class="rounded-lg bg-black"
          :class="frozen ? 'absolute w-px h-px opacity-0 pointer-events-none' : 'w-full'"
        />
        <canvas
          v-show="frozen"
          ref="snapshotEl"
          class="w-full rounded-lg bg-black"
          aria-label="Locked board snapshot"
        />
        <canvas ref="canvasEl" class="hidden" />
        <svg
          v-if="detection"
          class="absolute inset-0 w-full h-full pointer-events-none"
          :viewBox="`0 0 ${frozen?.width || canvasEl?.width || 1} ${frozen?.height || canvasEl?.height || 1}`"
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
              r="24"
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

    <div v-if="cameraError" class="alert alert-error">
      {{ cameraError }}
    </div>
    <div v-if="ocrError" class="alert alert-error">
      {{ ocrError }}
    </div>
    <div v-if="dictionaryError" class="alert alert-error">
      Dictionary: {{ dictionaryError }}
    </div>
    <div v-if="speechError" class="alert alert-error" role="status">
      {{ speechError }}
    </div>

    <div v-if="selectedWords.length" class="card bg-base-200 border-2 border-base-300 p-4">
      <h2 class="font-semibold">
        Suggested words (top to bottom)
      </h2>
      <p class="text-sm">
        The snapshot stays until each suggested word changes. Falling tiles can change remaining paths.
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
