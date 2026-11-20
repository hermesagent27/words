// app/utils/solver.ts
// Core Boggle-style solver: trie + DFS over 4x4 grid.
// Pure TypeScript, no Vue deps, so it can run in a Web Worker or be unit-tested.

import { MAX_LENGTH_FOR_MULTIPLE_WORDS } from "../lib/constants.mjs";

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
 * Word score = number of spelled letters along the path.
 * Tiles: 4x4 array of { letter }.
 * trie: pre-built dictionary trie.
 */
function findWordPaths(tiles: Tile[][], trie: Trie): ScoredWord[] {
  const found: ScoredWord[] = [];
  const visited: boolean[][] = Array.from({ length: 4 }, () => Array.from<boolean>({ length: 4 }).fill(false));

  function dfs(r: number, c: number, node: TrieNode, path: PathStep[], score: number) {
    if (!inBounds(r, c) || visited[r]![c])
      return;
    const tile = tiles[r]![c]!;
    const letter = tile.letter.toLowerCase();
    if (!/^(?:[a-z]|qu)$/.test(letter))
      return;
    let next: TrieNode | undefined = node;
    for (const ch of letter === "q" ? "qu" : letter) {
      next = next.children.get(ch);
      if (!next)
        return;
    }

    const newPath = [...path, { row: r, col: c }];
    const newScore = score + (letter === "q" ? 2 : 1);

    if (next.isWord) {
      const word = newPath.map((p) => {
        const value = tiles[p.row]![p.col]!.letter.toLowerCase();
        return value === "q" ? "qu" : value;
      }).join("");
      found.push({ word, score: newScore, path: newPath });
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

  return found.sort((a, b) => {
    if (b.score !== a.score)
      return b.score - a.score;
    if (b.word.length !== a.word.length)
      return b.word.length - a.word.length;
    return a.word.localeCompare(b.word);
  });
}

export function solveBoard(tiles: Tile[][], trie: Trie): ScoredWord[] {
  const found = new Map<string, ScoredWord>();
  for (const word of findWordPaths(tiles, trie)) {
    if (!found.has(word.word))
      found.set(word.word, word);
  }
  return Array.from(found.values());
}

function selectNonOverlappingWords(paths: ScoredWord[]): ScoredWord[] {
  const longestLength = paths[0]!.word.length;
  const pathsByWord = new Map<string, Map<number, ScoredWord>>();
  for (const word of paths) {
    const mask = word.path.reduce((bits, step) => bits | (1 << (step.row * 4 + step.col)), 0);
    let wordPaths = pathsByWord.get(word.word);
    if (!wordPaths) {
      wordPaths = new Map<number, ScoredWord>();
      pathsByWord.set(word.word, wordPaths);
    }
    if (!wordPaths.has(mask))
      wordPaths.set(mask, word);
  }
  const groups = Array.from(pathsByWord)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([word, wordPaths]) => ({
      word,
      paths: Array.from(wordPaths, ([mask, candidate]) => ({ mask, word: candidate })),
    }));

  type Selection = { longestCount: number; count: number; score: number; words: ScoredWord[] };
  const memo = new Map<number, Map<number, Selection>>();
  function isBetter(candidate: Selection, current: Selection): boolean {
    if (candidate.longestCount !== current.longestCount)
      return candidate.longestCount > current.longestCount;
    if (candidate.count !== current.count)
      return candidate.count > current.count;
    if (candidate.score !== current.score)
      return candidate.score > current.score;
    const candidateWords = candidate.words.map(word => word.word).sort();
    const currentWords = current.words.map(word => word.word).sort();
    for (let i = 0; i < candidateWords.length; i++) {
      const difference = candidateWords[i]!.localeCompare(currentWords[i]!);
      if (difference)
        return difference < 0;
    }
    return false;
  }
  function choose(groupIndex: number, available: number): Selection {
    if (groupIndex === groups.length)
      return { longestCount: 0, count: 0, score: 0, words: [] };
    let groupMemo = memo.get(groupIndex);
    if (!groupMemo) {
      groupMemo = new Map<number, Selection>();
      memo.set(groupIndex, groupMemo);
    }
    const cached = groupMemo.get(available);
    if (cached)
      return cached;
    let best = choose(groupIndex + 1, available);
    for (const candidate of groups[groupIndex]!.paths) {
      if ((candidate.mask & available) !== candidate.mask)
        continue;
      const rest = choose(groupIndex + 1, available ^ candidate.mask);
      const selection = {
        longestCount: rest.longestCount + (candidate.word.word.length === longestLength ? 1 : 0),
        count: rest.count + 1,
        score: rest.score + candidate.word.score,
        words: [candidate.word, ...rest.words],
      };
      if (isBetter(selection, best))
        best = selection;
    }
    groupMemo.set(available, best);
    return best;
  }
  return choose(0, 0xFFFF).words.sort((a, b) => b.score - a.score || a.word.localeCompare(b.word));
}

/** Show a non-overlapping word set on short boards, otherwise show only the longest word. */
export function suggestedWords(tiles: Tile[][], trie: Trie): ScoredWord[] {
  const paths = findWordPaths(tiles, trie);
  if (!paths.length)
    return [];
  return paths[0]!.word.length <= MAX_LENGTH_FOR_MULTIPLE_WORDS
    ? selectNonOverlappingWords(paths)
    : [paths[0]!];
}

/**
 * Convenience: pick the single best word.
 */
export function bestWord(tiles: Tile[][], trie: Trie): ScoredWord | null {
  const all = solveBoard(tiles, trie);
  return all.length ? all[0]! : null;
}

/** Remove the played cells, drop survivors, and leave new top cells blank. */
export function applyGravity(tiles: Tile[][], path: PathStep[]): Tile[][] {
  const used = new Set(path.map(step => `${step.row},${step.col}`));
  const result: Tile[][] = Array.from({ length: 4 }, (_, row) =>
    Array.from({ length: 4 }, (_, col) => ({ row, col, letter: "" })));

  for (let col = 0; col < 4; col++) {
    let dest = 3;
    for (let row = 3; row >= 0; row--) {
      if (!used.has(`${row},${col}`)) {
        result[dest]![col]!.letter = tiles[row]![col]!.letter;
        dest--;
      }
    }
  }
  return result;
}

export function wordPathChanged(board: Tile[][], observed: Tile[][], path: PathStep[]): boolean {
  return path.length > 0 && path.every(({ row, col }) => {
    const read = observed[row]![col]!.letter;
    return read !== "" && read !== board[row]![col]!.letter;
  });
}
