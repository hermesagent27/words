import assert from "node:assert/strict";
import { test } from "node:test";

import { projectBoardPoint } from "../app/utils/boardGeometry.ts";
import { createBoardConsensus } from "../app/utils/consensus.ts";
import { selectWordSet, solveBoard, Trie } from "../app/utils/solver.ts";

function board(rows: string[]) {
  return rows.map((letters, row) =>
    [...letters].map((letter, col) => ({ row, col, letter: letter === "." ? "" : letter })));
}

function dictionary(...words: string[]) {
  const trie = new Trie();
  for (const word of words)
    trie.insert(word);
  return trie;
}

test("Q consumes QU in one tile and scores only Q", () => {
  const tiles = board(["QIT.", "....", "....", "...."]);
  const result = solveBoard(tiles, dictionary("quit", "qit"));
  assert.deepEqual(result.map(word => [word.word, word.score, word.path.length]), [["quit", 12, 3]]);
});

test("maximum-scoring set considers alternate paths and never shares cells", () => {
  const tiles = board(["CAT.", "CA..", "R...", "...."]);
  const result = selectWordSet(tiles, dictionary("cat", "car"));
  assert.equal(result.reduce((sum, word) => sum + word.score, 0), 10);
  assert.deepEqual(result.map(word => word.word).sort(), ["car", "cat"]);
  const cells = result.flatMap(word => word.path.map(step => `${step.row},${step.col}`));
  assert.equal(new Set(cells).size, cells.length);
});

test("partial boards only use confirmed letters", () => {
  const tiles = board(["CAT.", "....", "....", "...."]);
  assert.deepEqual(selectWordSet(tiles, dictionary("cat")).map(word => word.word), ["cat"]);
});

test("consensus requires consecutive matching reads and retains transient misses", () => {
  const consensus = createBoardConsensus();
  const a = board(["A...", "....", "....", "...."]);
  const b = board(["B...", "....", "....", "...."]);
  const blank = board(["....", "....", "....", "...."]);
  assert.equal(consensus.update(a)[0]![0]!.letter, "");
  assert.equal(consensus.update(blank)[0]![0]!.letter, "");
  assert.equal(consensus.update(a)[0]![0]!.letter, "");
  assert.equal(consensus.update(a)[0]![0]!.letter, "A");
  assert.equal(consensus.update(b)[0]![0]!.letter, "A");
  assert.equal(consensus.update(b)[0]![0]!.letter, "B");
  assert.equal(consensus.update(blank)[0]![0]!.letter, "B");
  assert.equal(consensus.update(blank)[0]![0]!.letter, "B");
  assert.equal(consensus.update(blank)[0]![0]!.letter, "");
});

test("overlay projection follows perspective rather than bilinear interpolation", () => {
  const corners = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 80, y: 100 }, { x: 20, y: 100 }];
  assert.deepEqual(projectBoardPoint(corners, 0, 0), corners[0]);
  assert.deepEqual(projectBoardPoint(corners, 1, 1), corners[2]);
  const center = projectBoardPoint(corners, 0.5, 0.5);
  assert.ok(Math.abs(center.x - 50) < 1e-8);
  assert.ok(Math.abs(center.y - 62.5) < 1e-8);
});
