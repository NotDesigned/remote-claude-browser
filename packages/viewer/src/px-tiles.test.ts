// @vitest-environment node
import { describe, expect, it } from "vitest";
import { changedTiles } from "./px-tiles";

const grid = (columns: number, rows: number, set: Record<number, number> = {}) => {
  const pixels = new Array<number>(columns * rows * 4).fill(255);
  for (const [tile, value] of Object.entries(set)) pixels[Number(tile) * 4] = value;
  return { columns, rows, pixels };
};

describe("pixel frame tiles", () => {
  it("ignores compression noise", () => {
    expect(changedTiles(grid(4, 4), grid(4, 4, { 5: 250 }))).toEqual([]);
  });

  it("marks a changed tile and its neighbours", () => {
    const tiles = changedTiles(grid(4, 4), grid(4, 4, { 0: 200 }))!;
    expect(tiles).toHaveLength(4);
    expect(tiles).toContainEqual({ column: 1, row: 1 });
  });

  it("refuses grids of different shapes", () => {
    expect(changedTiles(grid(4, 4), grid(4, 3))).toBeNull();
  });
});
