import assert from "node:assert/strict";
import { test } from "node:test";

import { projectBoardPoint } from "../app/utils/boardGeometry.ts";
import { createBoardConsensus, createWordChangeMonitor } from "../app/utils/consensus.ts";
import { selectWordSet, solveBoard, Trie } from "../app/utils/solver.ts";
import { createWordSpeech } from "../app/utils/wordSpeech.ts";

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

test("locked words refresh only after every path has a confirmed changed tile", () => {
  const original = board(["ABCD", "EFGH", "IJKL", "MNOP"]);
  const words = [
    { word: "abc", score: 3, path: [{ row: 0, col: 0 }, { row: 0, col: 1 }] },
    { word: "abc", score: 3, path: [{ row: 1, col: 0 }, { row: 1, col: 1 }] },
  ];
  const monitor = createWordChangeMonitor(original, words);
  const consensus = createBoardConsensus();
  consensus.update(original);
  assert.deepEqual(monitor.update(consensus.update(original)), { count: 0, total: 2, complete: false });
  const first = board(["XBCD", "EFGH", "IJKL", "MNOP"]);
  assert.equal(monitor.update(consensus.update(first)).count, 0);
  assert.deepEqual(monitor.update(consensus.update(first)), { count: 1, total: 2, complete: false });
  const blank = board(["ABCD", ".FGH", "IJKL", "MNOP"]);
  assert.equal(monitor.update(consensus.update(blank)).count, 1);
  const second = board(["ABCD", "EYGH", "IJKL", "MNOP"]);
  assert.equal(monitor.update(consensus.update(second)).complete, false);
  assert.deepEqual(monitor.update(consensus.update(second)), { count: 2, total: 2, complete: true });
  assert.equal(createWordChangeMonitor(original, []).update(original).complete, false);
});

test("overlay projection follows perspective rather than bilinear interpolation", () => {
  const corners = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 80, y: 100 }, { x: 20, y: 100 }];
  assert.deepEqual(projectBoardPoint(corners, 0, 0), corners[0]);
  assert.deepEqual(projectBoardPoint(corners, 1, 1), corners[2]);
  const center = projectBoardPoint(corners, 0.5, 0.5);
  assert.ok(Math.abs(center.x - 50) < 1e-8);
  assert.ok(Math.abs(center.y - 62.5) < 1e-8);
});

test("speech reads the supplied order and cancels before replacing or stopping it", () => {
  type Request = { text: string; onerror: SpeechSynthesisUtterance["onerror"] };
  const actions: string[] = [];
  const speech = createWordSpeech(
    {
      cancel: () => { actions.push("cancel"); },
      speak: (request: Request) => { actions.push(request.text); },
    },
    (text: string): Request => ({ text, onerror: null }),
    message => assert.fail(message),
  );
  speech.speak(["now", "rut", "our"]);
  speech.speak(["new", "words"]);
  speech.stop();
  assert.deepEqual(actions, ["cancel", "now. rut. our", "cancel", "new. words", "cancel"]);
});

test("speech reports failures instead of silently appearing to work", () => {
  type Request = { text: string; onerror: SpeechSynthesisUtterance["onerror"] };
  const errors: string[] = [];
  const speech = createWordSpeech(
    {
      cancel: () => {},
      speak: (_request: Request) => { throw new Error("blocked"); },
    },
    (text: string): Request => ({ text, onerror: null }),
    message => errors.push(message),
  );
  speech.speak(["cat"]);
  assert.deepEqual(errors, ["Unable to start speech: blocked"]);
});
