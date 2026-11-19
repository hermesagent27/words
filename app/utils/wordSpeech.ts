type Utterance = { onerror: SpeechSynthesisUtterance["onerror"] };

export function createWordSpeech<T extends Utterance>(
  synthesis: { speak: (utterance: T) => void; cancel: () => void },
  createUtterance: (text: string) => T,
  reportError: (message: string) => void,
) {
  let revision = 0;

  function stop(): boolean {
    revision++;
    try {
      synthesis.cancel();
      return true;
    }
    catch (error: unknown) {
      reportError(`Unable to stop speech: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  function speak(words: string[]) {
    if (!stop() || !words.length)
      return;
    const current = revision;
    try {
      const utterance = createUtterance(words.join(". "));
      utterance.onerror = (event) => {
        if (revision === current)
          reportError(`Speech failed: ${event.error}`);
      };
      synthesis.speak(utterance);
    }
    catch (error: unknown) {
      reportError(`Unable to start speech: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { speak, stop };
}
