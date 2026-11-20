import assert from "node:assert/strict";
import { test } from "node:test";

import { projectBoardPoint } from "../app/utils/boardGeometry.ts";
import { isBoardObstructed } from "../app/utils/boardObstruction.ts";
import { createBoardConsensus, createWordChangeMonitor, currentConfirmedBoard, hasEnoughReadableTiles } from "../app/utils/consensus.ts";
import { bestWord, solveBoard, Trie } from "../app/utils/solver.ts";
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

test("Q consumes one tile but scores the spelled letters QU", () => {
  const tiles = board(["QIT.", "....", "....", "...."]);
  const result = solveBoard(tiles, dictionary("quit", "qit"));
  assert.deepEqual(result.map(word => [word.word, word.score, word.path.length]), [["quit", 4, 3]]);
});

test("only one longest word is selected when several tie", () => {
  const tiles = board(["CAT.", "CA..", "R...", "...."]);
  assert.equal(bestWord(tiles, dictionary("cat", "car"))?.word, "car");
});

test("the longest word is selected instead of a tied shorter-word combination", () => {
  const tiles = board(["TONE", "....", "....", "...."]);
  const result = bestWord(tiles, dictionary("tone", "to", "ne"));
  assert.deepEqual(result && [result.word, result.score], ["tone", 4]);
});

test("the single best word is returned instead of a combination of other words", () => {
  const tiles = board(["ABCD", "EFGH", "IJKL", "...."]);
  const result = bestWord(tiles, dictionary("abcdh", "efgji", "abef", "cdg"));
  assert.deepEqual(result && [result.word, result.score], ["abcdh", 5]);
});

test("partial boards only use confirmed letters", () => {
  const tiles = board(["CAT.", "....", "....", "...."]);
  assert.equal(bestWord(tiles, dictionary("cat"))?.word, "cat");
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

test("an interrupted scan preserves confirmed letters but breaks consecutive votes", () => {
  const consensus = createBoardConsensus();
  const a = board(["A...", "....", "....", "...."]);
  const b = board(["B...", "....", "....", "...."]);
  consensus.update(a);
  consensus.update(a);
  assert.equal(consensus.update(b)[0]![0]!.letter, "A");
  consensus.interrupt();
  assert.equal(consensus.update(b)[0]![0]!.letter, "A");
  assert.equal(consensus.update(b)[0]![0]!.letter, "B");
});

test("a snapshot needs 13 confirmed tiles that match the current reads", () => {
  const confirmed = board(["ABCD", "EFGH", "IJKL", "M..."]);
  assert.equal(hasEnoughReadableTiles(confirmed), true);
  assert.equal(hasEnoughReadableTiles(board(["ABCD", "EFGH", "IJKL", "...."])), false);
  assert.equal(hasEnoughReadableTiles(currentConfirmedBoard(confirmed, board(["ABCD", "EFGH", "IJKL", "X..."]))), false);
});

test("large skin-colored or dark patches block a board, but small glyphs do not", () => {
  const size = 400;
  const pixels = new Uint8Array(size * size * 4).fill(240);
  function patch(width: number, height: number, color: number[]) {
    for (let y = 20; y < 20 + height; y++) {
      for (let x = 20; x < 20 + width; x++) {
        const index = (y * size + x) * 4;
        pixels[index] = color[0]!;
        pixels[index + 1] = color[1]!;
        pixels[index + 2] = color[2]!;
      }
    }
  }
  patch(15, 30, [25, 25, 25]);
  assert.equal(isBoardObstructed(pixels, size), false);
  patch(45, 50, [198, 130, 94]);
  assert.equal(isBoardObstructed(pixels, size), true);
  patch(60, 60, [28, 28, 28]);
  assert.equal(isBoardObstructed(pixels, size), true);
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

test("locked paths require readable current tiles and matching confirmed changes", () => {
  const original = board(["ABCD", "EFGH", "IJKL", "MNOP"]);
  const words = [{ word: "abc", score: 3, path: [{ row: 0, col: 0 }, { row: 0, col: 1 }] }];
  const monitor = createWordChangeMonitor(original, words);
  const changed = board(["XBCD", "EFGH", "IJKL", "MNOP"]);
  assert.equal(monitor.update(changed, board(["X.CD", "EFGH", "IJKL", "MNOP"])).complete, false);
  assert.equal(monitor.update(changed, original).complete, false);
  assert.equal(monitor.update(changed, board(["XBCD", "EFGH", "IJKL", "M..."])).complete, true);
});

test("overlay projection follows perspective rather than bilinear interpolation", () => {
  const corners = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 80, y: 100 }, { x: 20, y: 100 }];
  assert.deepEqual(projectBoardPoint(corners, 0, 0), corners[0]);
  assert.deepEqual(projectBoardPoint(corners, 1, 1), corners[2]);
  const center = projectBoardPoint(corners, 0.5, 0.5);
  assert.ok(Math.abs(center.x - 50) < 1e-8);
  assert.ok(Math.abs(center.y - 62.5) < 1e-8);
});

test("speech reads slowly in order with a 300ms pause and cancels pending words", (t) => {
  type Request = { text: string; rate: number; onend: SpeechSynthesisUtterance["onend"]; onerror: SpeechSynthesisUtterance["onerror"] };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const actions: string[] = [];
  const requests: Request[] = [];
  const speech = createWordSpeech(
    {
      cancel: () => { actions.push("cancel"); },
      speak: (request: Request) => {
        actions.push(request.text);
        requests.push(request);
      },
    },
    (text: string): Request => ({ text, rate: 1, onend: null, onerror: null }),
    message => assert.fail(message),
  );
  speech.speak(["now", "rut", "our"]);
  assert.equal(requests[0]!.rate, 0.85);
  requests[0]!.onend!.call({} as SpeechSynthesisUtterance, {} as SpeechSynthesisEvent);
  t.mock.timers.tick(299);
  assert.deepEqual(actions, ["cancel", "now"]);
  t.mock.timers.tick(1);
  assert.deepEqual(actions, ["cancel", "now", "rut"]);
  requests[1]!.onend!.call({} as SpeechSynthesisUtterance, {} as SpeechSynthesisEvent);
  speech.speak(["new", "words"]);
  t.mock.timers.tick(300);
  assert.deepEqual(actions, ["cancel", "now", "rut", "cancel", "new"]);
  requests[2]!.onend!.call({} as SpeechSynthesisUtterance, {} as SpeechSynthesisEvent);
  speech.stop();
  t.mock.timers.tick(300);
  assert.deepEqual(actions, ["cancel", "now", "rut", "cancel", "new", "cancel"]);
});

test("speech reports failures instead of silently appearing to work", () => {
  type Request = { text: string; rate: number; onend: SpeechSynthesisUtterance["onend"]; onerror: SpeechSynthesisUtterance["onerror"] };
  const errors: string[] = [];
  const speech = createWordSpeech(
    {
      cancel: () => {},
      speak: (_request: Request) => { throw new Error("blocked"); },
    },
    (text: string): Request => ({ text, rate: 1, onend: null, onerror: null }),
    message => errors.push(message),
  );
  speech.speak(["cat"]);
  assert.deepEqual(errors, ["Unable to start speech: blocked"]);
});
