<script setup lang="ts">
import type { Point } from "~/utils/boardGeometry";
import type { ScoredWord, Tile } from "~/utils/solver";

import { projectBoardPoint } from "~/utils/boardGeometry";
import { createBoardConsensus, createWordChangeMonitor, currentConfirmedBoard, hasEnoughReadableTiles } from "~/utils/consensus";
import { createSilentPathSequence, pathAnimationDuration, pathLineStyle, wordStepChunks } from "~/utils/pathAnimation";
import { predictedBoards, predictPathPosition, suggestedWords } from "~/utils/solver";
import { createWordSpeech } from "~/utils/wordSpeech";

const { trie, error: dictionaryError, load: loadWords, remove: removeWord } = useWordList();
const { videoEl, canvasEl, ready: cameraReady, error: cameraError, start: startCamera, stop: stopCamera, captureFrame } = useCamera();
const { error: ocrError, detectGrid } = useOcr();
const consensus = createBoardConsensus();
const snapshotEl = ref<HTMLCanvasElement | null>(null);
const frozen = ref<{ width: number; height: number } | null>(null);

const speechEnabled = ref(false);
const speechSupported = ref(false);
const speechError = ref<string | null>(null);
const animatedWords = ref<number[]>([]);
const animationRun = ref(0);
const scanning = ref(false);
const processedSnapshots = ref(0);
const detection = ref<Point[] | null>(null);
const tiles = ref<Tile[][] | null>(null);
const selectedWords = ref<ScoredWord[]>([]);
const statusLine = ref("Starting…");
const lastSignature = ref("");
let lastSpokenSignature = "";
const colors = ["#ef4444", "#facc15", "#16a34a", "#3b82f6"];
const fallbackColor = "#000000";
let scanTimer: ReturnType<typeof setInterval> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let completionTimer: ReturnType<typeof setTimeout> | null = null;
let animationEndsAt = 0;
let playbackActive = false;
let refreshDue = false;
let revision = 0;
let working = false;
let pending: { frame: HTMLCanvasElement; revision: number } | null = null;
let monitor: ReturnType<typeof createWordChangeMonitor> | null = null;
let speech: ReturnType<typeof createWordSpeech<SpeechSynthesisUtterance>> | null = null;
const silentSequence = createSilentPathSequence(animateWord, finishPlayback);

function onVoicesChanged() {
  speech?.warmVoice();
}

function animateWord(index: number) {
  const word = selectedWords.value[index];
  if (word && !animatedWords.value.includes(index)) {
    animatedWords.value = [...animatedWords.value, index];
    animationEndsAt = Math.max(animationEndsAt, Date.now() + pathAnimationDuration(word.word) + 150);
  }
}

function finishPlayback() {
  playbackActive = false;
  if (refreshDue && frozen.value && scanning.value) {
    resetBoard();
    captureSnapshot();
  }
}

function finishSpokenPlayback(success: boolean) {
  if (!success) {
    startPlayback(false);
    return;
  }
  const remaining = Math.max(0, animationEndsAt - Date.now());
  if (!remaining) {
    finishPlayback();
    return;
  }
  completionTimer = setTimeout(() => {
    completionTimer = null;
    finishPlayback();
  }, remaining);
}

function stopSpeech() {
  silentSequence.stop();
  if (completionTimer !== null)
    clearTimeout(completionTimer);
  completionTimer = null;
  animationEndsAt = 0;
  playbackActive = false;
  speech?.stop();
  animatedWords.value = [];
}

function startPlayback(spoken: boolean) {
  stopSpeech();
  animationRun.value++;
  playbackActive = true;
  if (spoken && speech) {
    speechError.value = null;
    animateWord(0);
    speech.speak(selectedWords.value);
    lastSpokenSignature = lastSignature.value;
  }
  else {
    silentSequence.start(selectedWords.value.map(word => word.word));
  }
}

function resetBoard() {
  clearRefreshTimer();
  stopSpeech();
  refreshDue = false;
  revision++;
  pending = null;
  consensus.reset();
  frozen.value = null;
  monitor = null;
  detection.value = null;
  tiles.value = null;
  selectedWords.value = [];
  lastSignature.value = "";
  statusLine.value = "Looking for board…";
}

function clearRefreshTimer() {
  if (refreshTimer !== null)
    clearTimeout(refreshTimer);
  refreshTimer = null;
}

function scheduleBoardRefresh() {
  clearRefreshTimer();
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (playbackActive) {
      refreshDue = true;
    }
    else {
      resetBoard();
      captureSnapshot();
    }
  }, 2500);
}

function toggleSpeech() {
  if (!speech)
    return;
  speechEnabled.value = !speechEnabled.value;
  speechError.value = null;
  if (!speechEnabled.value) {
    stopSpeech();
    lastSpokenSignature = "";
    if (frozen.value)
      startPlayback(false);
    return;
  }
  if (frozen.value) {
    startPlayback(true);
  }
  else {
    speech.enable();
  }
}

const settingsOpen = ref(false);
const wordToRemove = ref("");
const removingWord = ref(false);
const removeWordMessage = ref<string | null>(null);

async function submitRemoveWord() {
  const word = wordToRemove.value.trim().toLowerCase();
  if (!word || removingWord.value)
    return;
  removingWord.value = true;
  removeWordMessage.value = null;
  try {
    const result = await removeWord(word);
    removeWordMessage.value = result.persisted === "github"
      ? `Removed "${word}" from the dictionary.`
      : (result.message ?? `Removed "${word}" for this session.`);
    if (result.removed) {
      wordToRemove.value = "";
      lastSignature.value = "";
      if (tiles.value) {
        solveCurrent(tiles.value);
        if (frozen.value && selectedWords.value.length) {
          monitor = createWordChangeMonitor(tiles.value, selectedWords.value);
          startPlayback(speechEnabled.value && !!speech);
        }
        else if (frozen.value) {
          resetBoard();
          captureSnapshot();
        }
      }
    }
  }
  finally {
    removingWord.value = false;
  }
}

function solveCurrent(board: Tile[][]) {
  tiles.value = board;
  if (!trie.value)
    return;
  const signature = board.flat().map(tile => tile.letter).join("|");
  if (signature === lastSignature.value)
    return;
  lastSignature.value = signature;
  selectedWords.value = suggestedWords(board, trie.value).slice(0, 4);
}

/**
 * Draw every remaining word where its letters WILL sit when it is that word's
 * turn, applying gravity from the words played before it. New letters entering
 * from the top keep their predicted (blank) positions, so lines aim at where
 * tiles land rather than where they currently are.
 */
const paths = computed(() => {
  if (!detection.value || !tiles.value)
    return [];
  const corners = detection.value;
  return selectedWords.value.map((word, index) =>
    predictPathPosition(word.path, selectedWords.value.slice(0, index).map(previous => previous.path))
      .map(step => projectBoardPoint(corners, (step.col + 0.5) / 4, (step.row + 0.5) / 4)));
});

/** Predicted letters for the board right before each play; drives the board read-out. */
const predictedTiles = computed(() => {
  if (!tiles.value || !selectedWords.value.length)
    return [] as string[];
  return predictedBoards(tiles.value, selectedWords.value)
    .map(board => board.map(row => row.map(tile => tile.letter === "Q" ? "QU" : tile.letter || "?").join(" ")).join(" / "));
});

function colorAt(index: number): string {
  return colors[index] ?? fallbackColor;
}

/** Letters per path step, synced to the redraw segments (Qu tile = one step). */
const stepLabels = computed(() =>
  selectedWords.value.map(word => wordStepChunks(word.word.toLowerCase()).map(chunk => chunk.toUpperCase())));

function stepLabelStyle(word: string, stepCount: number, stepIndex: number) {
  const stepMs = pathAnimationDuration(word) / stepCount;
  return {
    animation: `draw-step-label ${stepMs}ms linear ${stepIndex * stepMs}ms forwards`,
  };
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
  statusLine.value = selectedWords.value.length > 2
    ? "Board locked — refreshing shortly or when a suggested word changes"
    : `Board locked — refreshing shortly (0/${selectedWords.value.length} suggested words changed)`;
  scheduleBoardRefresh();
  startPlayback(speechEnabled.value && !!speech && lastSpokenSignature !== lastSignature.value);
}

function startScanning() {
  if (scanTimer)
    return;
  scanning.value = true;
  scanTimer = setInterval(captureSnapshot, 500);
  if (frozen.value)
    scheduleBoardRefresh();
}

function stopScanning() {
  if (scanTimer)
    clearInterval(scanTimer);
  scanTimer = null;
  clearRefreshTimer();
  refreshDue = false;
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
      processedSnapshots.value++;
      if (!result) {
        consensus.reset();
        if (frozen.value) {
          statusLine.value = ocrError.value ? "Scan failed — keeping snapshot" : "Board not visible — keeping snapshot";
          continue;
        }
        tiles.value = null;
        selectedWords.value = [];
        lastSignature.value = "";
        detection.value = null;
        statusLine.value = ocrError.value ? "Scan failed" : "Board not visible";
        continue;
      }
      if (result.obstructed) {
        consensus.interrupt();
        statusLine.value = frozen.value ? "Board obstructed — keeping snapshot" : "Board obstructed — waiting for a clear view";
        continue;
      }
      if (frozen.value && !hasEnoughReadableTiles(result.tiles)) {
        consensus.interrupt();
        statusLine.value = "Waiting for a clear, readable board — keeping snapshot";
        continue;
      }
      let board = consensus.update(result.tiles);
      if (monitor) {
        const progress = monitor.update(board, result.tiles);
        if (!progress.complete) {
          statusLine.value = progress.total > 2
            ? "Board locked — refreshing shortly or when a suggested word changes"
            : `Board locked — refreshing shortly (${progress.count}/${progress.total} suggested words changed)`;
          continue;
        }
        clearRefreshTimer();
        refreshDue = false;
        stopSpeech();
        lastSpokenSignature = "";
        monitor = null;
        frozen.value = null;
        consensus.reset();
        board = consensus.update(result.tiles);
      }
      detection.value = result.corners;
      const currentBoard = currentConfirmedBoard(board, result.tiles);
      solveCurrent(currentBoard);
      const count = currentBoard.flat().filter(tile => tile.letter).length;
      statusLine.value = `Reading board: ${count}/16 confirmed`;
      if (hasEnoughReadableTiles(currentBoard) && selectedWords.value.length)
        lockSnapshot(snapshot.frame, currentBoard);
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
      animateWord,
      finishSpokenPlayback,
    );
    speechSupported.value = true;
    window.speechSynthesis.addEventListener?.("voiceschanged", onVoicesChanged);
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
  stopSpeech();
  if (speechSupported.value && window.speechSynthesis)
    window.speechSynthesis.removeEventListener?.("voiceschanged", onVoicesChanged);
  document.removeEventListener("visibilitychange", visibilityChanged);
  stopScanning();
  stopCamera();
});
</script>

<template>
  <div class="flex h-full w-full min-h-0 flex-col gap-1 p-2">
    <div class="flex shrink-0 items-center justify-between">
      <h1 class="text-xl font-bold">
        Words
      </h1>
      <div class="flex gap-2 items-center">
        <span v-if="scanning" class="loading loading-spinner loading-sm text-primary" />
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
        <div class="relative">
          <button
            class="btn btn-sm btn-ghost"
            title="Settings"
            aria-label="Settings"
            :aria-expanded="settingsOpen"
            @click.stop="settingsOpen = !settingsOpen"
          >
            <Icon name="tabler:settings" />
          </button>
          <button
            v-if="settingsOpen"
            class="fixed inset-0 z-40 cursor-default bg-transparent"
            aria-label="Close settings"
            @click="settingsOpen = false"
          />
          <div
            v-if="settingsOpen"
            class="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border-2 border-base-300 bg-base-200 p-2 shadow-lg"
          >
            <p class="text-sm font-semibold">
              Remove a word
            </p>
            <p class="text-xs text-base-content/70">
              Stop the solver from suggesting a word. Saved to the dictionary when the server is connected to GitHub.
            </p>
            <form class="mt-1 flex gap-1" @submit.prevent="submitRemoveWord">
              <input
                v-model="wordToRemove"
                type="text"
                class="input input-sm min-w-0 flex-1"
                placeholder="word"
                autocapitalize="off"
                autocomplete="off"
                spellcheck="false"
                :disabled="removingWord"
              >
              <button type="submit" class="btn btn-sm btn-primary" :disabled="removingWord || !wordToRemove.trim()">
                <span v-if="removingWord" class="loading loading-spinner loading-xs" />
                Remove
              </button>
            </form>
            <p v-if="removeWordMessage" class="mt-1 text-xs text-base-content/70" role="status">
              {{ removeWordMessage }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <div class="flex flex-1 min-h-0 flex-col gap-1 landscape:flex-row">
      <div class="flex flex-1 min-h-0 min-w-0 flex-col gap-1">
        <div class="relative flex-1 min-h-0 overflow-hidden rounded-lg bg-black">
          <video
            ref="videoEl"
            autoplay
            playsinline
            muted
            class="absolute inset-0 h-full w-full object-contain"
            :class="{ 'pointer-events-none': frozen }"
          />
          <canvas
            v-show="frozen"
            ref="snapshotEl"
            class="absolute inset-0 h-full w-full bg-black object-contain"
            aria-label="Locked board snapshot"
          />
          <canvas ref="canvasEl" class="hidden" />
          <svg
            v-if="detection"
            class="absolute inset-0 w-full h-full pointer-events-none"
            :viewBox="`0 0 ${frozen?.width || canvasEl?.width || 1} ${frozen?.height || canvasEl?.height || 1}`"
            preserveAspectRatio="xMidYMid meet"
          >
            <polygon
              :points="detection.map(p => `${p.x},${p.y}`).join(' ')"
              fill="none"
              stroke="lime"
              stroke-width="3"
              opacity="0.7"
            />
            <template v-for="(path, index) in paths" :key="index">
              <template v-if="!animatedWords.includes(index)">
                <line
                  v-for="(point, i) in path.slice(1)"
                  :key="i"
                  :x1="path[i]!.x"
                  :y1="path[i]!.y"
                  :x2="point.x"
                  :y2="point.y"
                  :stroke="colorAt(index)"
                  stroke-width="12"
                  stroke-linecap="round"
                />
                <circle
                  v-if="path[0]"
                  :cx="path[0].x"
                  :cy="path[0].y"
                  r="30"
                  :fill="colorAt(index)"
                  stroke="white"
                  stroke-width="3"
                />
              </template>
            </template>
            <template v-for="(path, index) in paths" :key="`animation-${animationRun}-${index}`">
              <line
                v-for="(point, i) in path.slice(1)"
                v-show="animatedWords.includes(index)"
                :key="i"
                :x1="path[i]!.x"
                :y1="path[i]!.y"
                :x2="point.x"
                :y2="point.y"
                :stroke="colorAt(index)"
                :style="pathLineStyle(selectedWords[index]!.word, path.length - 1, i, path[i]!, point)"
                stroke-width="12"
                stroke-linecap="round"
              />
              <circle
                v-if="path[0]"
                v-show="animatedWords.includes(index)"
                :cx="path[0].x"
                :cy="path[0].y"
                r="30"
                :fill="colorAt(index)"
                stroke="white"
                stroke-width="3"
              />
              <text
                v-for="(point, i) in path"
                v-show="animatedWords.includes(index)"
                :key="`label-${i}`"
                :x="point.x"
                :y="point.y"
                :fill="colorAt(index)"
                stroke="white"
                stroke-width="6"
                paint-order="stroke"
                font-size="150"
                font-weight="bold"
                text-anchor="middle"
                dominant-baseline="central"
                class="draw-step-label"
                :style="stepLabelStyle(selectedWords[index]!.word, path.length, i)"
              >{{ stepLabels[index]?.[i] }}</text>
            </template>
          </svg>
        </div>
        <div class="flex shrink-0 flex-wrap justify-center gap-x-2 text-center text-xs text-base-content/70">
          <span>{{ statusLine }}</span>
          <span>Processed snapshots: {{ processedSnapshots }}</span>
          <span v-if="tiles" class="font-mono" aria-label="Confirmed board">
            {{ tiles.map(row => row.map(tile => tile.letter === "Q" ? "QU" : tile.letter || "?").join(" ")).join(" / ") }}
          </span>
        </div>
        <div v-if="cameraError || ocrError || dictionaryError || speechError" class="shrink-0 max-h-[20dvh] overflow-y-auto text-sm">
          <div v-if="cameraError" class="alert alert-error py-1">
            {{ cameraError }}
          </div>
          <div v-if="ocrError" class="alert alert-error py-1">
            {{ ocrError }}
          </div>
          <div v-if="dictionaryError" class="alert alert-error py-1">
            Dictionary: {{ dictionaryError }}
          </div>
          <div v-if="speechError" class="alert alert-error py-1" role="status">
            {{ speechError }}
          </div>
        </div>
      </div>

      <div v-if="selectedWords.length || tiles" class="flex shrink-0 flex-col gap-1 landscape:w-[min(36%,18rem)]">
        <div v-if="selectedWords.length" class="rounded-lg border border-base-300 bg-base-200 px-2 py-1">
          <h2 class="text-sm font-semibold">
            Play in this order
          </h2>
          <p class="text-xs text-base-content/70">
            Paths show where each word's letters will be when it is played.
          </p>
          <div class="flex flex-wrap gap-x-3 gap-y-1">
            <div v-for="(word, i) in selectedWords" :key="`${word.word}-${i}`" class="flex items-baseline gap-1">
              <span :style="{ color: colorAt(i) }" aria-hidden="true">●</span>
              <span class="text-xs">{{ i + 1 }}.</span>
              <span class="text-lg font-bold tracking-wide">{{ word.word.toUpperCase() }}</span>
              <span class="text-xs text-base-content/70">{{ word.score }} pts</span>
              <span v-if="predictedTiles[i + 1]" class="font-mono text-xs text-base-content/70">→ {{ predictedTiles[i + 1] }}</span>
            </div>
          </div>
        </div>
        <div v-else-if="tiles" class="rounded-lg bg-base-200 px-2 py-1 text-sm">
          No valid words found on confirmed tiles.
        </div>
      </div>
    </div>
  </div>
</template>

<style>
@keyframes draw-path-line {
  to {
    stroke-dashoffset: 0;
  }
}

.draw-step-label {
  opacity: 0;
}

@keyframes draw-step-label {
  0% {
    opacity: 0;
  }
  15% {
    opacity: 1;
  }
  100% {
    opacity: 1;
  }
}
</style>
