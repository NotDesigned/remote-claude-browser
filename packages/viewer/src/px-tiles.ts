/** Coarse thumbnails tell which parts of the page changed between two pixel frames. */
export const GRID_COLUMNS = 128;
/** Per colour channel: above JPEG's noise once averaged, below a caret's mark on a tile. */
const CHANGED_DIFFERENCE = 6;

export interface TileGrid {
  columns: number;
  rows: number;
  pixels: ArrayLike<number>;
}

/** Tiles that differ, with their neighbours so a change on a tile's edge is fully covered. */
export function changedTiles(
  before: TileGrid,
  after: TileGrid,
): { column: number; row: number }[] | null {
  if (before.columns !== after.columns || before.rows !== after.rows) return null;
  const { columns, rows } = after;
  const marked = new Set<number>();
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const at = (row * columns + column) * 4;
      let changed = false;
      for (let channel = 0; channel < 3 && !changed; channel++)
        changed =
          Math.abs(before.pixels[at + channel]! - after.pixels[at + channel]!) > CHANGED_DIFFERENCE;
      if (!changed) continue;
      for (let y = Math.max(0, row - 1); y <= Math.min(rows - 1, row + 1); y++)
        for (let x = Math.max(0, column - 1); x <= Math.min(columns - 1, column + 1); x++)
          marked.add(y * columns + x);
    }
  }
  return [...marked].map((index) => ({
    column: index % columns,
    row: Math.floor(index / columns),
  }));
}
