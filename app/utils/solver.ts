// app/utils/solver.ts
// Core Boggle-style solver: trie + DFS over 4x4 grid.
// Pure TypeScript, no Vue deps, so it can run in a Web Worker or be unit-tested.

export interface Tile {
  letter: string
  dots: number // 1..4
  row: number
  col: number
}

export interface PathStep {
  row: number
  col: number
}

export interface ScoredWord {
  word: string
  score: number
  path: PathStep[]
}

class TrieNode {
  children: Map<string, TrieNode> = new Map()
  isWord = false
}

export class Trie {
  root = new TrieNode()

  insert(word: string) {
    let node = this.root
    for (const ch of word) {
      if (!node.children.has(ch)) node.children.set(ch, new TrieNode())
      node = node.children.get(ch)!
    }
    node.isWord = true
  }

  has(word: string): boolean {
    let node = this.root
    for (const ch of word) {
      const next = node.children.get(ch)
      if (!next) return false
      node = next
    }
    return node.isWord
  }
}

const DIRS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
]

function inBounds(r: number, c: number) {
  return r >= 0 && r < 4 && c >= 0 && c < 4
}

/**
 * Find every valid word on the board, return them sorted by score desc then length desc.
 * Tiles: 4x4 array of { letter, dots }.
 * trie: pre-built dictionary trie.
 */
export function solveBoard(tiles: Tile[][], trie: Trie): ScoredWord[] {
  const found = new Map<string, ScoredWord>() // dedupe by word string
  const visited: boolean[][] = Array.from({ length: 4 }, () => Array(4).fill(false))

  function dfs(r: number, c: number, node: TrieNode, path: PathStep[], score: number) {
    if (!inBounds(r, c) || visited[r][c]) return
    const tile = tiles[r][c]
    const ch = tile.letter.toLowerCase()
    const next = node.children.get(ch)
    if (!next) return

    const newPath = [...path, { row: r, col: c }]
    const newScore = score + tile.dots

    if (next.isWord) {
      const word = newPath.map(p => tiles[p.row][p.col].letter.toLowerCase()).join('')
      const existing = found.get(word)
      if (!existing || newScore > existing.score) {
        found.set(word, { word, score: newScore, path: newPath })
      }
    }

    visited[r][c] = true
    for (const [dr, dc] of DIRS) {
      dfs(r + dr, c + dc, next, newPath, newScore)
    }
    visited[r][c] = false
  }

  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      dfs(r, c, trie.root, [], 0)
    }
  }

  return Array.from(found.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.word.length !== a.word.length) return b.word.length - a.word.length
    return a.word.localeCompare(b.word)
  })
}

/**
 * Convenience: pick the single best word.
 */
export function bestWord(tiles: Tile[][], trie: Trie): ScoredWord | null {
  const all = solveBoard(tiles, trie)
  return all.length ? all[0] : null
}
