// app/composables/useCamera.ts
export function useCamera() {
  const videoEl = ref<HTMLVideoElement | null>(null);
  const canvasEl = ref<HTMLCanvasElement | null>(null);
  const stream = ref<MediaStream | null>(null);
  const ready = ref(false);
  const error = ref<string | null>(null);
  const facingMode = ref<"environment" | "user">("environment");

  async function start() {
    stop();
    error.value = null;
    try {
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: facingMode.value,
          width: { ideal: 1280 },
          height: { ideal: 960 },
        },
        audio: false,
      };
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      stream.value = s;
      if (videoEl.value) {
        videoEl.value.srcObject = s;
        await videoEl.value.play();
      }
      ready.value = true;
    }
    catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e);
      ready.value = false;
    }
  }

  function stop() {
    if (stream.value) {
      for (const t of stream.value.getTracks()) t.stop();
      stream.value = null;
    }
    ready.value = false;
  }

  async function switchCamera() {
    facingMode.value = facingMode.value === "environment" ? "user" : "environment";
    await start();
  }

  /** Capture current video frame into the canvas and return it. */
  function captureFrame(): HTMLCanvasElement | null {
    if (!videoEl.value || !canvasEl.value || !ready.value)
      return null;
    const v = videoEl.value;
    const c = canvasEl.value;
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext("2d");
    if (!ctx)
      return null;
    ctx.drawImage(v, 0, 0);
    return c;
  }

  onUnmounted(stop);

  return {
    videoEl,
    canvasEl,
    stream: readonly(stream),
    ready: readonly(ready),
    error: readonly(error),
    facingMode: readonly(facingMode),
    start,
    stop,
    switchCamera,
    captureFrame,
  };
}
