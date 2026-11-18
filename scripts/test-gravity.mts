import assert from "node:assert/strict";
import { test } from "node:test";

import { applyGravity, wordPathChanged } from "../app/utils/solver.ts";

function board(rows: string[]) {
  return rows.map((letters, row) =>
    [...letters].map((letter, col) => ({ row, col, letter })));
}

function letters(tiles: ReturnType<typeof board>) {
  return tiles.map(row => row.map(tile => tile.letter || ".").join(""));
}

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
