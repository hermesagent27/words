import type { ScoredWord } from "./solver";

type Utterance = Pick<SpeechSynthesisUtterance, "onend" | "onerror" | "onstart" | "rate" | "voice">;
type SpokenWord = Pick<ScoredWord, "word" | "path">;

/** Voices known for clear diction; first available match wins. Falls back to any local en-US voice. */
const PREFERRED_VOICE_NAMES = [
  "Samantha",
  "Google US English",
  "Microsoft Aria Online (Natural) - English (United States)",
  "Microsoft Jenny Online (Natural) - English (United States)",
  "Alex",
  "Karen",
  "Moira",
  "Tessa",
  "Fred",
];

function pickClearVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  for (const name of PREFERRED_VOICE_NAMES) {
    const match = voices.find(v => v.name === name);
    if (match)
      return match;
  }
  return voices.find(v => v.localService && v.lang.startsWith("en"))
    ?? voices.find(v => v.lang.startsWith("en"))
    ?? null;
}

export function createWordSpeech<T extends Utterance>(
  synthesis: { speak: (utterance: T) => void; cancel: () => void; getVoices?: () => SpeechSynthesisVoice[] },
  createUtterance: (text: string) => T,
  reportError: (message: string) => void,
  onWordStart: (index: number) => void = () => {},
  onComplete: (success: boolean) => void = () => {},
) {
  let revision = 0;
  let active: T | null = null;
  let pause: ReturnType<typeof setTimeout> | null = null;
  let cachedVoice: SpeechSynthesisVoice | null = null;

  function resolveVoice(): SpeechSynthesisVoice | null {
    if (cachedVoice)
      return cachedVoice;
    if (typeof synthesis.getVoices !== "function")
      return null;
    const voices = synthesis.getVoices();
    if (!voices.length)
      return null;
    cachedVoice = pickClearVoice(voices);
    return cachedVoice;
  }

  function stop(): boolean {
    revision++;
    const wasActive = active !== null;
    active = null;
    if (pause !== null) {
      clearTimeout(pause);
      pause = null;
    }
    if (!wasActive)
      return true;
    try {
      synthesis.cancel();
      return true;
    }
    catch (error: unknown) {
      reportError(`Unable to stop speech: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  function speakMessages(messages: string[], revealWords = false) {
    if (!stop() || !messages.length)
      return;
    const current = revision;
    function speakWord(index: number) {
      if (revision !== current)
        return;
      try {
        const utterance = createUtterance(messages[index]!);
        utterance.rate = 0.9;
        const voice = resolveVoice();
        if (voice)
          utterance.voice = voice;
        active = utterance;
        utterance.onstart = () => {
          if (revision === current && active === utterance && revealWords)
            onWordStart(index);
        };
        utterance.onerror = (event) => {
          if (revision !== current || active !== utterance)
            return;
          active = null;
          revision++;
          reportError(`Speech failed: ${event.error}`);
          if (revealWords)
            onComplete(false);
        };
        utterance.onend = () => {
          if (revision !== current || active !== utterance)
            return;
          active = null;
          if (index + 1 < messages.length) {
            pause = setTimeout(() => {
              pause = null;
              speakWord(index + 1);
            }, 300);
          }
          else if (revealWords) {
            onComplete(true);
          }
        };
        synthesis.speak(utterance);
      }
      catch (error: unknown) {
        active = null;
        revision++;
        reportError(`Unable to start speech: ${error instanceof Error ? error.message : String(error)}`);
        if (revealWords)
          onComplete(false);
      }
    }
    speakWord(0);
  }

  function speak(words: SpokenWord[]) {
    speakMessages(words.map(({ word }) => word), true);
  }

  function enable() {
    speakMessages(["Speech enabled."]);
  }

  function warmVoice() {
    cachedVoice = null;
    resolveVoice();
  }

  return { enable, speak, stop, warmVoice };
}
