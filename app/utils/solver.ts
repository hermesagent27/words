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
    const newScore = score + (letter === "q" || letter === "qu" ? 2 : 1);

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
  const seen = new Map<string, Set<number>>();
  const candidates: { mask: number; word: ScoredWord }[] = [];
  for (const word of paths) {
    const mask = word.path.reduce((bits, step) => bits | (1 << (step.row * 4 + step.col)), 0);
    let masks = seen.get(word.word);
    if (!masks) {
      masks = new Set<number>();
      seen.set(word.word, masks);
    }
    if (!masks.has(mask)) {
      masks.add(mask);
      candidates.push({ mask, word });
    }
  }

  const memo = new Map<string, ScoredWord[]>();
  function isBetter(candidate: ScoredWord[], current: ScoredWord[]): boolean {
    for (let i = 0; i < Math.max(candidate.length, current.length); i++) {
      const difference = (candidate[i]?.word.length ?? 0) - (current[i]?.word.length ?? 0);
      if (difference)
        return difference > 0;
    }
    for (let i = 0; i < candidate.length; i++) {
      const difference = candidate[i]!.word.localeCompare(current[i]!.word);
      if (difference)
        return difference < 0;
    }
    return false;
  }
  function choose(available: number, used: Set<string>): ScoredWord[] {
    const key = `${available}:${Array.from(used).sort().join(",")}`;
    const cached = memo.get(key);
    if (cached)
      return cached;
    let best: ScoredWord[] = [];
    for (const candidate of candidates) {
      if (best.length && candidate.word.word.length < best[0]!.word.length)
        break;
      if ((candidate.mask & available) !== candidate.mask || used.has(candidate.word.word))
        continue;
      used.add(candidate.word.word);
      const rest = choose(available ^ candidate.mask, used);
      used.delete(candidate.word.word);
      const selection = [candidate.word, ...rest].sort((a, b) => b.word.length - a.word.length || a.word.localeCompare(b.word));
      if (isBetter(selection, best))
        best = selection;
    }
    memo.set(key, best);
    return best;
  }
  return choose(0xFFFF, new Set<string>());
}

/** Show non-overlapping words, prioritizing each longest available word. */
export function suggestedWords(tiles: Tile[][], trie: Trie): ScoredWord[] {
  const paths = findWordPaths(tiles, trie);
  if (!paths.length)
    return [];
  return selectNonOverlappingWords(paths);
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
