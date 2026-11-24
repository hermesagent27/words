import assert from "node:assert/strict";
import { test } from "node:test";

import { applyGravity, predictedBoards, predictPathPosition, suggestedWords, Trie, wordPathChanged } from "../app/utils/solver.ts";

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

test("the largest word leads even when fewer words survive", () => {
  // With chko + bgjmn, keeping both means playing smaller-first; leading with
  // the largest is the priority, so bgjmn goes first and chko is dropped.
  const words = suggestedWords(board(["ABCD", "EFGH", "IJKL", "MNOP"]), dictionary("chko", "bgjmn"));
  assert.deepEqual(words.map(word => word.word), ["bgjmn"]);
});

test("a longer word leads even when it would drop a disjoint shorter word", () => {
  // mjeb and nolkf never share a tile and both survive gravity, so the longer
  // word leads and the shorter one follows.
  const words = suggestedWords(board(["ABCD", "EFGH", "IJKL", "MNOP"]), dictionary("mjeb", "nolkf"));
  assert.deepEqual(words.map(word => word.word), ["nolkf", "mjeb"]);
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

test("the largest word plays first when it leaves smaller words intact", () => {
  // bgjfe sweeps the left columns into new letters; nmi is untouched, so it
  // leads instead of the smaller lower word.
  const words = suggestedWords(board(["ABCD", "EFGH", "IJKL", "MNOP"]), dictionary("bgjfe", "nmi"));
  assert.deepEqual(words.map(word => word.word), ["bgjfe", "nmi"]);
});

test("play order stays top-down when the largest word would break smaller words", () => {
  // Playing kfein first drops I onto N and strands both din and ilp, so the
  // solver keeps them out entirely rather than let the biggest word lead.
  const words = suggestedWords(board(["ABCD", "EFGH", "IJKL", "MNOP"]), dictionary("din", "ilp", "kfein"));
  assert.deepEqual(words.map(word => word.word), ["kfein"]);
});

test("predictPathPosition only moves tiles above cells removed by earlier words", () => {
  const path = [{ row: 0, col: 0 }, { row: 1, col: 0 }];
  assert.deepEqual(predictPathPosition(path, []), path);
  assert.deepEqual(predictPathPosition(path, [[{ row: 3, col: 0 }]]), [
    { row: 1, col: 0 },
    { row: 2, col: 0 },
  ]);
  // Removals in other columns do not move this word.
  assert.deepEqual(predictPathPosition(path, [[{ row: 3, col: 1 }]]), path);
});

test("predictedBoards drops survivors and blanks the top row after each play", () => {
  // After jgc clears its own tiles, nolkf's letters settle onto the bottom row
  // and the rest of the column falls into place.
  const original = board(["ABCD", "EFGH", "IJKL", "MNOP"]);
  const words = suggestedWords(original, dictionary("afj", "nolkf", "jgc"));
  const boards = predictedBoards(original, words);
  assert.equal(boards.length, words.length);
  assert.deepEqual(letters(boards[0]!), ["ABCD", "EFGH", "IJKL", "MNOP"]);
  assert.deepEqual(letters(boards[1]!), ["A..D", "EB.H", "IFKL", "MNOP"]);
});

test("the trie forgets removed words but keeps words built on the same letters", () => {
  const trie = dictionary("cat", "cats", "car", "cartoon");
  assert.equal(trie.remove("cat"), true);
  assert.equal(trie.has("cat"), false);
  assert.ok(trie.has("cats"));
  assert.ok(trie.has("cartoon"));
  assert.equal(trie.remove("cartoon"), true);
  assert.equal(trie.has("cartoon"), false);
  assert.ok(trie.has("car"));
  assert.equal(trie.remove("nope"), false);
  assert.equal(trie.remove("ca"), false);
});
