type Glyph = {
  width: number;
  height: number;
  area: number;
  centerX: number;
};

/** A plain capital I can be a narrow, solid vertical stroke. */
export function isNarrowI(glyph: Glyph, cellSize: number): boolean {
  return glyph.width >= cellSize * 0.04
    && glyph.height >= cellSize * 0.4
    && glyph.height <= cellSize * 0.85
    && glyph.width <= glyph.height * 0.22
    && glyph.area >= glyph.width * glyph.height * 0.8
    && Math.abs(glyph.centerX - cellSize / 2) <= cellSize * 0.12;
}
