// app/utils/solver.ts
// Core Boggle-style solver: trie + DFS over 4x4 grid.
// Pure TypeScript, no Vue deps, so it can run in a Web Worker or be unit-tested.

export type Tile = {
  letter: string;
  row: number;
  col: number;
};

export type PathStep = {
  row: number;
  col: number;
};

export type ScoredWord = {
  word: string;
  score: number;
  path: PathStep[];
};

// Standard Scrabble tile values (English edition).
export const SCRABBLE_VALUES: Record<string, number> = {
  A: 1,
  B: 3,
  C: 3,
  D: 2,
  E: 1,
  F: 4,
  G: 2,
  H: 4,
  I: 1,
  J: 8,
  K: 5,
  L: 1,
  M: 3,
  N: 1,
  O: 1,
  P: 3,
  Q: 10,
  R: 1,
  S: 1,
  T: 1,
  U: 1,
  V: 4,
  W: 4,
  X: 8,
  Y: 4,
  Z: 10,
};

export function letterValue(letter: string): number {
  if (!letter)
    return 0;
  return SCRABBLE_VALUES[letter.toUpperCase()] ?? 0;
}

class TrieNode {
  children: Map<string, TrieNode> = new Map();
  isWord = false;
}

export class Trie {
  root = new TrieNode();

  insert(word: string) {
    let node = this.root;
    for (const ch of word) {
      if (!node.children.has(ch))
        node.children.set(ch, new TrieNode());
      node = node.children.get(ch)!;
    }
    node.isWord = true;
  }

  has(word: string): boolean {
    let node = this.root;
    for (const ch of word) {
      const next = node.children.get(ch);
      if (!next)
        return false;
      node = next;
    }
    return node.isWord;
  }
}

const DIRS = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

function inBounds(r: number, c: number) {
  return r >= 0 && r < 4 && c >= 0 && c < 4;
}

/**
 * Find every valid word on the board, return them sorted by score desc then length desc.
 * Word score = sum of Scrabble letter values along the path.
 * Tiles: 4x4 array of { letter }.
 * trie: pre-built dictionary trie.
 */
export function solveBoard(tiles: (Tile | null)[][], trie: Trie): ScoredWord[] {
  const found = new Map<string, ScoredWord>(); // dedupe by word string
  const visited: boolean[][] = Array.from({ length: 4 }, () => Array.from<boolean>({ length: 4 }).fill(false));

  function dfs(r: number, c: number, node: TrieNode, path: PathStep[], score: number) {
    if (!inBounds(r, c) || visited[r]![c])
      return;
    const tile = tiles[r]![c];
    if (!tile || !tile.letter)
      return;
    const ch = tile.letter.toLowerCase();
    const next = node.children.get(ch);
    if (!next)
      return;

    const newPath = [...path, { row: r, col: c }];
    const newScore = score + letterValue(tile.letter);

    if (next.isWord) {
      const word = newPath.map((p) => {
        const t = tiles[p.row]![p.col];
        return t ? t.letter.toLowerCase() : "";
      }).join("");
      const existing = found.get(word);
      if (!existing || newScore > existing.score) {
        found.set(word, { word, score: newScore, path: newPath });
      }
    }

    visited[r]![c] = true;
    for (const [dr, dc] of DIRS) {
      dfs(r + dr!, c + dc!, next, newPath, newScore);
    }
    visited[r]![c] = false;
  }

  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      dfs(r, c, trie.root, [], 0);
    }
  }

  return Array.from(found.values()).sort((a, b) => {
    if (b.score !== a.score)
      return b.score - a.score;
    if (b.word.length !== a.word.length)
      return b.word.length - a.word.length;
    return a.word.localeCompare(b.word);
  });
}

/**
 * Convenience: pick the single best word.
 */
export function bestWord(tiles: (Tile | null)[][], trie: Trie): ScoredWord | null {
  const all = solveBoard(tiles, trie);
  return all.length ? all[0]! : null;
}

// ---------------------------------------------------------------------
// Gravity simulation (Bookworm-style): played tiles vanish, the tiles
// above them fall down, and fresh unknown tiles spawn at the top.
// Unknown spawn cells come out as null so callers can either leave them
// blank (OCR will fill them next frame) or exclude them from solving.
// ---------------------------------------------------------------------

export type GravityResult = {
  /** Post-fall board. Unknown newly-spawned top cells are null. */
  board: (Tile | null)[][];
  /** Cells whose letter survived WITHOUT moving (row/col + letter unchanged). */
  stable: PathStep[];
  /** Cells that received a falling tile from above. */
  fallen: PathStep[];
  /** Cells that will be filled by newly spawned tiles. */
  spawned: PathStep[];
};

export function applyGravity(tiles: (Tile | null)[][], usedPath: PathStep[]): GravityResult {
  const used = new Set(usedPath.map(p => `${p.row},${p.col}`));
  const board: (Tile | null)[][] = Array.from({ length: 4 }, () => Array.from<Tile | null>({ length: 4 }).fill(null));
  const stable: PathStep[] = [];
  const fallen: PathStep[] = [];
  const spawned: PathStep[] = [];

  for (let c = 0; c < 4; c++) {
    const removedRows = new Set<number>();
    for (let r = 0; r < 4; r++) {
      if (used.has(`${r},${c}`))
        removedRows.add(r);
    }
    // Keep the surviving tiles bottom-up so they stack without gaps.
    const survivors: { letter: string; fromRow: number }[] = [];
    for (let r = 3; r >= 0; r--) {
      if (!removedRows.has(r)) {
        const t = tiles[r]![c];
        if (t && t.letter)
          survivors.push({ letter: t.letter, fromRow: r });
      }
    }
    const spawnCount = removedRows.size;
    for (let r = 3; r >= 0; r--) {
      if (r >= spawnCount) {
        const s = survivors[3 - r]!;
        board[r]![c] = { letter: s.letter, row: r, col: c };
        if (s.fromRow === r)
          stable.push({ row: r, col: c });
        else
          fallen.push({ row: r, col: c });
      }
      else {
        board[r]![c] = null;
        spawned.push({ row: r, col: c });
      }
    }
  }
  return { board, stable, fallen, spawned };
}

/**
 * Best-scoring word from `words` whose path shares no cell with `first`.
 * Returns null when every candidate overlaps.
 */
export function bestDisjointWord(words: ScoredWord[], first: ScoredWord): ScoredWord | null {
  const used = new Set(first.path.map(p => `${p.row},${p.col}`));
  for (const w of words) {
    if (w.word === first.word && w.path.length === first.path.length
      && w.path.every((p, i) => p.row === first.path[i]!.row && p.col === first.path[i]!.col)) {
      continue;
    }
    if (w.path.every(p => !used.has(`${p.row},${p.col}`)))
      return w;
  }
  return null;
}
