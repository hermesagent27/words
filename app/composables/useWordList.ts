// app/composables/useWordList.ts
import { Trie } from "~/utils/solver";

export function useWordList() {
  const trie = shallowRef<Trie | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load() {
    if (trie.value)
      return;
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch("/dict/words.txt");
      if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const t = new Trie();
      for (const line of text.split("\n")) {
        const w = line.trim();
        if (w.length >= 3)
          t.insert(w);
      }
      trie.value = t;
    }
    catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e);
    }
    finally {
      loading.value = false;
    }
  }

  return { trie, loading: readonly(loading), error: readonly(error), load };
}
