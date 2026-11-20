import assert from "node:assert/strict";
import { test } from "node:test";

import { applyGravity, suggestedWords, Trie, wordPathChanged } from "../app/utils/solver.ts";

function board(rows: string[]) {
  return rows.map((letters, row) =>
    [...letters].map((letter, col) => ({ row, col, letter })));
}

function letters(tiles: ReturnType<typeof board>) {
  return tiles.map(row => row.map(tile => tile.letter || ".").join(""));
}

function dictionary(...words: string[]) {
  const trie = new Trie();
  for (const word of words)
    trie.insert(word);
  return trie;
}

test("suggestions remain playable in top-down order after each fall", () => {
  const original = board(["ABCD", "EFGH", "IJKL", "MNOP"]);
  const words = suggestedWords(original, dictionary("dcbe", "afjg", "nmi"));
  assert.deepEqual(words.map(word => word.word), ["dcbe", "afjg", "nmi"]);
  let current = original;
  let moved = false;
  for (const word of words) {
    const path = word.path.map(({ row, col }) => {
      const tile = current.flat().find(tile => tile.letter === original[row]![col]!.letter);
      assert.ok(tile);
      return tile;
    });
    for (let i = 0; i < path.length; i++) {
      if (path[i]!.row !== word.path[i]!.row)
        moved = true;
      if (i > 0) {
        assert.ok(Math.abs(path[i]!.row - path[i - 1]!.row) <= 1);
        assert.ok(Math.abs(path[i]!.col - path[i - 1]!.col) <= 1);
      }
    }
    current = applyGravity(current, path);
  }
  assert.equal(moved, true);
});

test("a word is omitted when gravity would break its path", () => {
  const words = suggestedWords(board(["ABCD", "EFGH", "IJKL", "MNOP"]), dictionary("chko", "bgjmn"));
  assert.deepEqual(words.map(word => word.word), ["bgjmn"]);
});

test("a shorter upper word is played before a longer lower word", () => {
  const words = suggestedWords(board(["ABCD", "EFGH", "IJKL", "MNOP"]), dictionary("mjeb", "nolkf"));
  assert.deepEqual(words.map(word => word.word), ["mjeb", "nolkf"]);
});

test("an earlier short word can make two longer words playable together", () => {
  const words = suggestedWords(board(["ABCD", "EFGH", "IJKL", "MNOP"]), dictionary("kfein", "dhlo", "jgc"));
  assert.deepEqual(words.map(word => word.word), ["jgc", "dhlo", "kfein"]);
});

test("unused letters fall in order and new cells appear at the top", () => {
  const original = board(["ABCD", "EFGH", "IJKL", "MNOP"]);
  const result = applyGravity(original, [
    { row: 3, col: 0 },
    { row: 1, col: 0 },
    { row: 2, col: 1 },
  ]);
  assert.deepEqual(letters(result), ["..CD", ".BGH", "AFKL", "INOP"]);
  assert.deepEqual(letters(original), ["ABCD", "EFGH", "IJKL", "MNOP"]);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      assert.equal(result[row]![col]!.row, row);
      assert.equal(result[row]![col]!.col, col);
    }
  }
});

test("removing a whole column leaves only new blank cells", () => {
  const result = applyGravity(board(["ABCD", "EFGH", "IJKL", "MNOP"]), [
    { row: 0, col: 2 },
    { row: 1, col: 2 },
    { row: 2, col: 2 },
    { row: 3, col: 2 },
  ]);
  assert.deepEqual(letters(result), ["AB.D", "EF.H", "IJ.L", "MN.P"]);
});

test("unknown surviving cells keep their positions in the falling stack", () => {
  const original = board(["ABCD", "EFGH", "IJKL", "MNOP"]);
  original[1]![0]!.letter = "";
  const result = applyGravity(original, [{ row: 3, col: 0 }]);
  assert.deepEqual(letters(result), [".BCD", "AFGH", ".JKL", "INOP"]);
});

test("played-word detection requires every path letter to be readable and changed", () => {
  const original = board(["ABCD", "EFGH", "IJKL", "MNOP"]);
  const observed = board(["XYCD", "EFGH", "IJKL", "MNOP"]);
  const path = [{ row: 0, col: 0 }, { row: 0, col: 1 }];
  assert.equal(wordPathChanged(original, observed, path), true);
  observed[0]![1]!.letter = "B";
  assert.equal(wordPathChanged(original, observed, path), false);
  observed[0]![1]!.letter = "";
  assert.equal(wordPathChanged(original, observed, path), false);
  assert.equal(wordPathChanged(original, observed, []), false);
});
