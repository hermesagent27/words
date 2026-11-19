import type { Tile } from "./solver";

type CellState = { candidate: string; count: number; committed: string; misses: number };

export function createBoardConsensus() {
  const cells: CellState[][] = Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => ({ candidate: "", count: 0, committed: "", misses: 0 })));

  function update(reads: Tile[][]): Tile[][] {
    return cells.map((row, r) => row.map((state, c) => {
      const read = reads[r]![c]!.letter;
      if (!read) {
        state.candidate = "";
        state.count = 0;
        if (++state.misses >= 3)
          state.committed = "";
      }
      else {
        state.misses = 0;
        if (state.candidate === read) {
          state.count++;
        }
        else {
          state.candidate = read;
          state.count = 1;
        }
        if (state.count >= 2)
          state.committed = read;
      }
      return { row: r, col: c, letter: state.committed };
    }));
  }

  function reset() {
    for (const row of cells) {
      for (const cell of row)
        Object.assign(cell, { candidate: "", count: 0, committed: "", misses: 0 });
    }
  }

  return { update, reset };
}
