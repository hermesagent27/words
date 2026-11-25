import assert from "node:assert/strict";
import { test } from "node:test";

import { projectBoardPoint } from "../app/utils/boardGeometry.ts";
import { isBoardObstructed } from "../app/utils/boardObstruction.ts";
import { createBoardConsensus, createWordChangeMonitor, currentConfirmedBoard, hasEnoughReadableTiles } from "../app/utils/consensus.ts";
import { isNarrowI } from "../app/utils/ocrGlyph.ts";
import { createSilentPathSequence, pathLineStyle } from "../app/utils/pathAnimation.ts";
import { solveBoard, suggestedWords, Trie } from "../app/utils/solver.ts";
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

test("narrow I detection rejects short, off-center and irregular marks", () => {
  const glyph = { width: 4, height: 33, area: 132, centerX: 34 };
  assert.equal(isNarrowI(glyph, 70), true);
  assert.equal(isNarrowI({ ...glyph, height: 12, area: 48 }, 70), false);
  assert.equal(isNarrowI({ ...glyph, centerX: 20 }, 70), false);
  assert.equal(isNarrowI({ ...glyph, area: 60 }, 70), false);
});

test("Q consumes one tile but scores the spelled letters QU", () => {
  const tiles = board(["QIT.", "....", "....", "...."]);
  const result = solveBoard(tiles, dictionary("quit", "qit"));
  assert.deepEqual(result.map(word => [word.word, word.score, word.path.length]), [["quit", 4, 3]]);
});

test("QU tile values count both spelled letters when ranking words", () => {
  const tiles = board([".IT.", "ABC.", "....", "...."]);
  tiles[0]![0]!.letter = "QU";
  assert.deepEqual(suggestedWords(tiles, dictionary("quit", "abc")).map(word => [word.word, word.score]), [["quit", 4], ["abc", 3]]);
});

test("alternate paths leave room for non-overlapping words of the same length", () => {
  const tiles = board(["CAT.", "CA..", "R...", "...."]);
  const result = suggestedWords(tiles, dictionary("cat", "car"));
  assert.deepEqual(result.map(word => word.word), ["cat", "car"]);
  const cells = result.flatMap(word => word.path.map(step => `${step.row},${step.col}`));
  assert.equal(new Set(cells).size, cells.length);
});

test("four-letter boards show multiple words instead of one maximum word", () => {
  const tiles = board(["TONE", "CAT.", "....", "...."]);
  const result = suggestedWords(tiles, dictionary("tone", "to", "ne", "cat"));
  assert.deepEqual(result.map(word => [word.word, word.score]), [["tone", 4], ["cat", 3]]);
  const cells = result.flatMap(word => word.path.map(step => `${step.row},${step.col}`));
  assert.equal(new Set(cells).size, cells.length);
});

test("five-letter boards show non-overlapping words", () => {
  const tiles = board(["ABCD", "EFGH", "IJKL", "...."]);
  const result = suggestedWords(tiles, dictionary("abcdh", "efgji", "abef", "cdg"));
  assert.deepEqual(result.map(word => [word.word, word.score]), [["abcdh", 5], ["efgji", 5]]);
  const cells = result.flatMap(word => word.path.map(step => `${step.row},${step.col}`));
  assert.equal(new Set(cells).size, cells.length);
});

test("longest words are shown with other long non-overlapping words", () => {
  const tiles = board(["ABCD", "EFGH", "IJKL", "...."]);
  const result = suggestedWords(tiles, dictionary("abcdhl", "efgji", "ef", "gji"));
  assert.deepEqual(result.map(word => [word.word, word.score]), [["abcdhl", 6], ["efgji", 5]]);
});

test("partial boards only use confirmed letters", () => {
  const tiles = board(["CAT.", "....", "....", "...."]);
  assert.deepEqual(suggestedWords(tiles, dictionary("cat")).map(word => word.word), ["cat"]);
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

test("dark obstructions block a board, but skin-colored tiles and small glyphs do not", () => {
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
  assert.equal(isBoardObstructed(pixels, size), false);
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

test("more than two locked words refresh after the first confirmed path change", () => {
  const original = board(["ABCD", "EFGH", "IJKL", "MNOP"]);
  const words = [
    { word: "abc", score: 3, path: [{ row: 0, col: 0 }, { row: 0, col: 1 }] },
    { word: "efg", score: 3, path: [{ row: 1, col: 0 }, { row: 1, col: 1 }] },
    { word: "ijk", score: 3, path: [{ row: 2, col: 0 }, { row: 2, col: 1 }] },
  ];
  const monitor = createWordChangeMonitor(original, words);
  const consensus = createBoardConsensus();
  consensus.update(original);
  assert.deepEqual(monitor.update(consensus.update(original)), { count: 0, total: 3, complete: false });
  const changed = board(["XBCD", "EFGH", "IJKL", "MNOP"]);
  assert.equal(monitor.update(consensus.update(changed), changed).complete, false);
  assert.deepEqual(monitor.update(consensus.update(changed), changed), { count: 1, total: 3, complete: true });
});

test("overlay projection follows perspective rather than bilinear interpolation", () => {
  const corners = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 80, y: 100 }, { x: 20, y: 100 }];
  assert.deepEqual(projectBoardPoint(corners, 0, 0), corners[0]);
  assert.deepEqual(projectBoardPoint(corners, 1, 1), corners[2]);
  const center = projectBoardPoint(corners, 0.5, 0.5);
  assert.ok(Math.abs(center.x - 50) < 1e-8);
  assert.ok(Math.abs(center.y - 62.5) < 1e-8);
});

test("path segments share the whole-word duration based on spelled length", () => {
  const from = { x: 0, y: 0 };
  const to = { x: 3, y: 4 };
  for (const [word, segmentCount, totalDuration] of [["at", 1, 150], ["quit", 2, 150], ["quite", 3, 250], ["seventh", 6, 250], ["eighteen", 7, 450]] as const) {
    const segmentIndex = segmentCount - 1;
    const duration = totalDuration / segmentCount;
    const style = pathLineStyle(word, segmentCount, segmentIndex, from, to);
    assert.equal(style.strokeDashoffset, 5);
    assert.equal(style.animation, `draw-path-line ${duration}ms linear ${duration * segmentIndex}ms forwards, fade-path-line 150ms linear ${totalDuration}ms forwards`);
  }
});

test("silent paths animate in order and cancel when replaced", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const actions: (number | string)[] = [];
  const sequence = createSilentPathSequence(index => actions.push(index), () => actions.push("done"));
  sequence.start(["quit", "seventh"]);
  assert.deepEqual(actions, [0]);
  t.mock.timers.tick(449);
  assert.deepEqual(actions, [0]);
  t.mock.timers.tick(1);
  assert.deepEqual(actions, [0, 1]);
  sequence.stop();
  t.mock.timers.tick(1000);
  assert.deepEqual(actions, [0, 1]);
  sequence.start(["eighteen"]);
  t.mock.timers.tick(599);
  assert.deepEqual(actions, [0, 1, 0]);
  t.mock.timers.tick(1);
  assert.deepEqual(actions, [0, 1, 0, "done"]);
});

test("speech reads only words in order, pauses between them, and cancels pending words", (t) => {
  type Request = { text: string; rate: number; onstart: SpeechSynthesisUtterance["onstart"]; onend: SpeechSynthesisUtterance["onend"]; onerror: SpeechSynthesisUtterance["onerror"] };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const actions: string[] = [];
  const requests: Request[] = [];
  const startedWords: number[] = [];
  const completed: boolean[] = [];
  const speech = createWordSpeech(
    {
      cancel: () => { actions.push("cancel"); },
      speak: (request: Request) => {
        actions.push(request.text);
        requests.push(request);
      },
    },
    (text: string): Request => ({ text, rate: 1, onstart: null, onend: null, onerror: null }),
    message => assert.fail(message),
    index => startedWords.push(index),
    success => completed.push(success),
  );
  speech.speak([
    { word: "now", path: [{ row: 0, col: 0 }, { row: 0, col: 3 }, { row: 3, col: 3 }] },
    { word: "rut", path: [{ row: 2, col: 0 }, { row: 1, col: 2 }, { row: 1, col: 3 }] },
    { word: "our", path: [{ row: 1, col: 0 }] },
  ]);
  assert.equal(requests[0]!.rate, 0.9);
  requests[0]!.onstart!.call({} as SpeechSynthesisUtterance, {} as SpeechSynthesisEvent);
  requests[0]!.onend!.call({} as SpeechSynthesisUtterance, {} as SpeechSynthesisEvent);
  t.mock.timers.tick(299);
  assert.deepEqual(actions, ["now"]);
  t.mock.timers.tick(1);
  assert.deepEqual(actions, ["now", "rut"]);
  requests[1]!.onstart!.call({} as SpeechSynthesisUtterance, {} as SpeechSynthesisEvent);
  requests[1]!.onend!.call({} as SpeechSynthesisUtterance, {} as SpeechSynthesisEvent);
  speech.speak([
    { word: "new", path: [{ row: 0, col: 1 }] },
    { word: "words", path: [{ row: 1, col: 0 }] },
  ]);
  t.mock.timers.tick(300);
  assert.deepEqual(actions, ["now", "rut", "new"]);
  requests[2]!.onstart!.call({} as SpeechSynthesisUtterance, {} as SpeechSynthesisEvent);
  assert.deepEqual(startedWords, [0, 1, 0]);
  requests[2]!.onend!.call({} as SpeechSynthesisUtterance, {} as SpeechSynthesisEvent);
  speech.stop();
  requests[2]!.onstart!.call({} as SpeechSynthesisUtterance, {} as SpeechSynthesisEvent);
  assert.deepEqual(startedWords, [0, 1, 0]);
  assert.deepEqual(completed, []);
  t.mock.timers.tick(300);
  assert.deepEqual(actions, ["now", "rut", "new"]);
  speech.speak([{ word: "last", path: [{ row: 0, col: 0 }] }]);
  requests[3]!.onend!.call({} as SpeechSynthesisUtterance, {} as SpeechSynthesisEvent);
  assert.deepEqual(completed, [true]);
});

test("speech enabled before a board is ready resumes on refreshed boards", () => {
  type Request = { text: string; rate: number; onstart: SpeechSynthesisUtterance["onstart"]; onend: SpeechSynthesisUtterance["onend"]; onerror: SpeechSynthesisUtterance["onerror"] };
  const requests: Request[] = [];
  const startedWords: number[] = [];
  let cancellations = 0;
  const speech = createWordSpeech(
    {
      cancel: () => { cancellations++; },
      speak: (request: Request) => { requests.push(request); },
    },
    (text: string): Request => ({ text, rate: 1, onstart: null, onend: null, onerror: null }),
    message => assert.fail(message),
    index => startedWords.push(index),
  );
  speech.enable();
  assert.equal(requests[0]!.text, "Speech enabled.");
  requests[0]!.onstart!.call({} as SpeechSynthesisUtterance, {} as SpeechSynthesisEvent);
  assert.deepEqual(startedWords, []);
  requests[0]!.onend!.call({} as SpeechSynthesisUtterance, {} as SpeechSynthesisEvent);
  speech.speak([{ word: "quit", path: [{ row: 0, col: 0 }, { row: 1, col: 1 }, { row: 2, col: 2 }] }]);
  assert.equal(requests[1]!.text, "quit");
  requests[1]!.onstart!.call({} as SpeechSynthesisUtterance, {} as SpeechSynthesisEvent);
  assert.deepEqual(startedWords, [0]);
  speech.stop();
  assert.equal(cancellations, 1);
  speech.speak([{ word: "new", path: [{ row: 3, col: 3 }] }]);
  requests[1]!.onerror!.call({} as SpeechSynthesisUtterance, { error: "interrupted" } as SpeechSynthesisErrorEvent);
  assert.equal(requests[2]!.text, "new");
  requests[2]!.onend!.call({} as SpeechSynthesisUtterance, {} as SpeechSynthesisEvent);
  speech.stop();
  speech.speak([{ word: "next", path: [{ row: 0, col: 1 }] }]);
  assert.equal(cancellations, 1);
  assert.equal(requests[3]!.text, "next");
});

test("speech reports failures instead of silently appearing to work", () => {
  type Request = { text: string; rate: number; onstart: SpeechSynthesisUtterance["onstart"]; onend: SpeechSynthesisUtterance["onend"]; onerror: SpeechSynthesisUtterance["onerror"] };
  const errors: string[] = [];
  const completed: boolean[] = [];
  const speech = createWordSpeech(
    {
      cancel: () => {},
      speak: (_request: Request) => { throw new Error("blocked"); },
    },
    (text: string): Request => ({ text, rate: 1, onstart: null, onend: null, onerror: null }),
    message => errors.push(message),
    () => {},
    success => completed.push(success),
  );
  speech.speak([{ word: "cat", path: [{ row: 0, col: 0 }] }]);
  assert.deepEqual(errors, ["Unable to start speech: blocked"]);
  assert.deepEqual(completed, [false]);
});
