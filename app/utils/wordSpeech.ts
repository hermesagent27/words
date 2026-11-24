import type { ScoredWord } from "./solver";

type Utterance = Pick<SpeechSynthesisUtterance, "onend" | "onerror" | "onstart" | "rate">;
type SpokenWord = Pick<ScoredWord, "word" | "path">;

export function createWordSpeech<T extends Utterance>(
  synthesis: { speak: (utterance: T) => void; cancel: () => void },
  createUtterance: (text: string) => T,
  reportError: (message: string) => void,
  onWordStart: (index: number) => void = () => {},
  onComplete: (success: boolean) => void = () => {},
) {
  let revision = 0;
  let active: T | null = null;
  let pause: ReturnType<typeof setTimeout> | null = null;

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

  return { enable, speak, stop };
}
