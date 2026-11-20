/**
 * Check the tile interiors for a large, very dark obstruction.
 * Letters are much smaller than the area required to trigger this check.
 */
export function isBoardObstructed(pixels: ArrayLike<number>, size: number): boolean {
  if (size <= 0 || size % 4 !== 0 || pixels.length < size * size * 4)
    throw new Error("Invalid board image for obstruction detection");
  const cell = size / 4;
  const inset = Math.floor(cell * 0.2);
  const step = 2;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      let dark = 0;
      let total = 0;
      for (let y = row * cell + inset; y < (row + 1) * cell - inset; y += step) {
        for (let x = col * cell + inset; x < (col + 1) * cell - inset; x += step) {
          const index = (y * size + x) * 4;
          const r = pixels[index]!;
          const g = pixels[index + 1]!;
          const b = pixels[index + 2]!;
          if (Math.max(r, g, b) < 65)
            dark++;
          total++;
        }
      }
      if (dark / total > 0.4)
        return true;
    }
  }
  return false;
}
