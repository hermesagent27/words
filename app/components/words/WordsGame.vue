<template>
  <div class="flex flex-col gap-4 p-4 max-w-2xl mx-auto">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">Words</h1>
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
      <h2 class="font-semibold mb-2">Manual Test Grid</h2>
      <div class="grid grid-cols-4 gap-2 mb-2">
        <input
          v-for="(t, i) in manualTiles.flat()"
          :key="i"
          v-model="manualTiles[Math.floor(i/4)][i%4].letter"
          maxlength="1"
          class="input input-bordered text-center uppercase font-mono"
          @input="manualTiles[Math.floor(i/4)][i%4].letter = manualTiles[Math.floor(i/4)][i%4].letter.toUpperCase()"
        >
      </div>
      <div class="grid grid-cols-4 gap-2 mb-2">
        <input
          v-for="(t, i) in manualTiles.flat()"
          :key="i"
          v-model.number="manualTiles[Math.floor(i/4)][i%4].dots"
          type="number"
          min="1"
          max="4"
          class="input input-bordered text-center"
        >
      </div>
      <button class="btn btn-primary btn-sm" @click="solveManual">Solve</button>
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

      <!-- Overlay: grid outline + word path -->
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
      </svg>

      <div v-if="cameraError" class="alert alert-error mt-2">
        {{ cameraError }}
      </div>

      <!-- Status line -->
      <div class="text-sm text-base-content/70 mt-2 text-center">
        {{ statusLine }}
      </div>
    </div>

    <!-- Result -->
    <div v-if="bestWord" class="card bg-base-200 border-2 border-base-300 p-4">
      <div class="flex items-baseline gap-2">
        <span class="text-3xl font-bold tracking-widest">{{ bestWord.word.toUpperCase() }}</span>
        <span class="text-lg text-base-content/70">{{ bestWord.score }} pts</span>
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

<script setup lang="ts">
import { solveBoard, type Tile, type ScoredWord } from '~/utils/solver'

const { trie, load: loadWords } = useWordList()
const { videoEl, canvasEl, ready: cameraReady, error: cameraError, start: startCamera, stop: stopCamera, switchCamera, captureFrame } = useCamera()
const { processing, detectGrid } = useOcr()

const manualMode = ref(false)
const manualTiles = ref<Tile[][]>(
  Array.from({ length: 4 }, (_, r) =>
    Array.from({ length: 4 }, (_, c) => ({ letter: '', dots: 1, row: r, col: c })),
  ),
)

const scanning = ref(false)
const detection = ref<{ corners: Array<{ x: number, y: number }> } | null>(null)
const tiles = ref<Tile[][] | null>(null)
const allWords = ref<ScoredWord[]>([])
const bestWord = ref<ScoredWord | null>(null)
const lastSignature = ref<string>('')
const statusLine = ref('Starting…')

const SCAN_INTERVAL_MS = 1500
let scanTimer: ReturnType<typeof setInterval> | null = null

const bestPath = computed(() => {
  if (!bestWord.value || !detection.value || !canvasEl.value) return []
  const c = detection.value.corners
  const path: Array<{ x: number, y: number }> = []
  for (const step of bestWord.value.path) {
    const u = (step.col + 0.5) / 4
    const v = (step.row + 0.5) / 4
    const x = (1 - u) * (1 - v) * c[0].x + u * (1 - v) * c[1].x + u * v * c[2].x + (1 - u) * v * c[3].x
    const y = (1 - u) * (1 - v) * c[0].y + u * (1 - v) * c[1].y + u * v * c[2].y + (1 - u) * v * c[3].y
    path.push({ x, y })
  }
  return path
})

onMounted(async () => {
  await loadWords()
  await startCamera()
  startScanning()
})

onUnmounted(() => {
  stopScanning()
  stopCamera()
})

function startScanning() {
  if (scanTimer) return
  scanTimer = setInterval(scanTick, SCAN_INTERVAL_MS)
  scanning.value = true
}

function stopScanning() {
  if (scanTimer) clearInterval(scanTimer)
  scanTimer = null
  scanning.value = false
}

async function scanTick() {
  if (manualMode.value || !cameraReady.value || processing.value) return
  const frame = captureFrame()
  if (!frame) return

  statusLine.value = 'Looking for board…'
  const result = await detectGrid(frame)
  if (!result) {
    detection.value = null
    // Don't clear bestWord immediately on a bad frame, keep the last good one
    return
  }

  // Compute signature of this board to detect changes
  const sig = result.tiles.flat().map(t => `${t.letter}${t.dots}`).join('|')
  if (sig === lastSignature.value) {
    // Same board, refresh path overlay but don't re-solve
    detection.value = { corners: result.corners }
    statusLine.value = 'Board locked'
    return
  }

  lastSignature.value = sig
  detection.value = { corners: result.corners }
  tiles.value = result.tiles
  statusLine.value = 'Solving…'
  solveCurrent()
  statusLine.value = `Board locked — ${tiles.value.flat().map(t => t.letter).join(' ')}`
}

function solveManual() {
  tiles.value = manualTiles.value
  detection.value = null
  solveCurrent()
}

function solveCurrent() {
  if (!tiles.value || !trie.value) return
  allWords.value = solveBoard(tiles.value, trie.value)
  bestWord.value = allWords.value.length ? allWords.value[0] : null
}

// Pause scanning when tab hidden to save battery
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopScanning()
    else startScanning()
  })
}
</script>
