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

  /** Remove a single entry; pruning empty branches keeps enumeration clean. */
  remove(word: string): boolean {
    const chain: [TrieNode, string][] = [];
    let node = this.root;
    for (const ch of word) {
      const next = node.children.get(ch);
      if (!next)
        return false;
      chain.push([node, ch]);
      node = next;
    }
    if (!node.isWord)
      return false;
    node.isWord = false;
    for (let i = chain.length - 1; i >= 0; i--) {
      const [parent, ch] = chain[i]!;
      const child = parent.children.get(ch)!;
      if (child.isWord || child.children.size)
        break;
      parent.children.delete(ch);
    }
    return true;
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
  const candidates: { mask: number; word: ScoredWord }[] = [];
  for (const word of paths) {
    const mask = word.path.reduce((bits, step) => bits | (1 << (step.row * 4 + step.col)), 0);
    candidates.push({ mask, word });
  }

  function topDown(a: ScoredWord, b: ScoredWord): number {
    const aRows = a.path.reduce((sum, step) => sum + step.row, 0);
    const bRows = b.path.reduce((sum, step) => sum + step.row, 0);
    return aRows * b.path.length - bRows * a.path.length
      || b.word.length - a.word.length
      || a.word.localeCompare(b.word);
  }

  function playable(word: ScoredWord, removed: number): boolean {
    const fallen = word.path.map(({ row, col }) => {
      let destination = row;
      for (let below = row + 1; below < 4; below++) {
        if (removed & (1 << (below * 4 + col)))
          destination++;
      }
      return { row: destination, col };
    });
    for (let i = 1; i < fallen.length; i++) {
      if (Math.abs(fallen[i]!.row - fallen[i - 1]!.row) > 1
        || Math.abs(fallen[i]!.col - fallen[i - 1]!.col) > 1) {
        return false;
      }
    }
    return true;
  }

  /** Prefer longer words, backtracking when that prevents a playable sequence. */
  function orderForPlay(words: ScoredWord[]): ScoredWord[] {
    const candidates = words.map((word, index) => ({
      index,
      mask: word.path.reduce((bits, step) => bits | (1 << (step.row * 4 + step.col)), 0),
      word,
    })).sort((a, b) => b.word.word.length - a.word.word.length || topDown(a.word, b.word));
    const memo = new Map<number, ScoredWord[] | null>();

    function findOrder(remaining: number, removed: number): ScoredWord[] | null {
      if (!remaining)
        return [];
      if (memo.has(remaining))
        return memo.get(remaining)!;
      for (const candidate of candidates) {
        const bit = 1 << candidate.index;
        if (!(remaining & bit) || !playable(candidate.word, removed))
          continue;
        const rest = findOrder(remaining ^ bit, removed | candidate.mask);
        if (rest) {
          const result = [candidate.word, ...rest];
          memo.set(remaining, result);
          return result;
        }
      }
      memo.set(remaining, null);
      return null;
    }

    return findOrder((1 << words.length) - 1, 0) ?? [];
  }

  function isBetter(candidate: ScoredWord[], current: ScoredWord[]): boolean {
    const candidateProfile = candidate.map(word => word.word).sort((a, b) => b.length - a.length || a.localeCompare(b));
    const currentProfile = current.map(word => word.word).sort((a, b) => b.length - a.length || a.localeCompare(b));
    for (let i = 0; i < Math.min(candidateProfile.length, currentProfile.length); i++) {
      const lengthDifference = candidateProfile[i]!.length - currentProfile[i]!.length;
      if (lengthDifference)
        return lengthDifference > 0;
    }
    if (candidateProfile.length !== currentProfile.length)
      return candidateProfile.length > currentProfile.length;
    for (let i = 0; i < candidateProfile.length; i++) {
      const difference = candidateProfile[i]!.localeCompare(currentProfile[i]!);
      if (difference)
        return difference < 0;
    }
    return false;
  }
  function choose(start: number, available: number, used: Set<string>, selected: ScoredWord[]): ScoredWord[] {
    let best = orderForPlay(selected).length ? selected : [];
    for (let index = start; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      if ((candidate.mask & available) !== candidate.mask || used.has(candidate.word.word))
        continue;
      const selection = [...selected, candidate.word];
      used.add(candidate.word.word);
      const result = choose(index + 1, available ^ candidate.mask, used, selection);
      used.delete(candidate.word.word);
      if (result.length >= selection.length) {
        if (isBetter(result, best))
          best = result;
      }
    }
    return best;
  }
  return orderForPlay(choose(0, 0xFFFF, new Set<string>(), []));
}

/** Show long, non-overlapping words in a top-down order that survives gravity. */
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

/**
 * Predict the board positions where a word's letters will sit after every word
 * before it is played. Unknown letters entering from the top are blank, so the
 * tail of a path may sit on cells whose letters are not yet known.
 */
export function predictPathPosition(path: PathStep[], playedBefore: PathStep[][]): PathStep[] {
  const removed = new Set(playedBefore.flat().map(step => `${step.row},${step.col}`));
  return path.map(({ row, col }) => {
    let destination = row;
    for (let below = row + 1; below < 4; below++) {
      if (removed.has(`${below},${col}`))
        destination++;
    }
    return { row: destination, col };
  });
}

/**
 * Predict the letter at every board cell before each play in the order.
 * Before play 1 the board is untouched; after each play the survivors fall
 * and new blank cells appear at the top.
 */
export function predictedBoards(tiles: Tile[][], words: ScoredWord[]): Tile[][][] {
  const boards: Tile[][][] = [];
  let current = tiles;
  for (const word of words) {
    boards.push(current);
    current = applyGravity(current, word.path);
  }
  return boards;
}

export function wordPathChanged(board: Tile[][], observed: Tile[][], path: PathStep[]): boolean {
  return path.length > 0 && path.every(({ row, col }) => {
    const read = observed[row]![col]!.letter;
    return read !== "" && read !== board[row]![col]!.letter;
  });
}
