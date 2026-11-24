// app/composables/useWordList.ts
import { Trie } from "~/utils/solver";

export type RemoveWordResult = {
  removed: boolean;
  persisted?: "github" | "local";
  message?: string;
};

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

  function removeLocal(word: string): { removed: boolean; message?: string } {
    const w = word.trim().toLowerCase();
    if (!w)
      return { removed: false, message: "Enter a word to remove" };
    if (!trie.value)
      return { removed: false, message: "Dictionary is still loading" };
    if (!trie.value.has(w))
      return { removed: false, message: `"${w}" is not in the dictionary` };
    trie.value.remove(w);
    return { removed: true };
  }

  /**
   * Remove a word from the dictionary. Always removes it from the live trie so
   * solving stops suggesting it immediately; when the server has a GitHub token
   * configured, also commits the removal to the repo's words.txt.
   */
  async function remove(word: string): Promise<RemoveWordResult> {
    const w = word.trim().toLowerCase();
    const local = removeLocal(w);
    if (!local.removed)
      return local;
    try {
      const res = await fetch("/api/dictionary/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word: w }),
      });
      if (!res.ok)
        return { removed: true, persisted: "local", message: `Removed locally (GitHub save failed: HTTP ${res.status})` };
      const body = await res.json() as { persisted?: string };
      if (body.persisted === "local")
        return { removed: true, persisted: "local", message: "Removed locally (GitHub token not configured on the server)" };
      return { removed: true, persisted: "github" };
    }
    catch (e: unknown) {
      return { removed: true, persisted: "local", message: `Removed locally (GitHub save failed: ${e instanceof Error ? e.message : String(e)})` };
    }
  }

  return { trie, loading: readonly(loading), error: readonly(error), load, remove };
}
