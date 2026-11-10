import { expect, test } from "bun:test";
import { stageLattice } from "../stageHost";
import { safeReturnTo } from "../../../app/login/returnTo";

// Every tile on the stage gets a cell of its own: the rows are explicit
// equal tracks for every count, never implicit `auto` rows, which a video
// tile (no content height) collapses to nothing beside `fr` rows.
const cells = (n: number) => {
  const { gridTemplateColumns, gridTemplateRows } = stageLattice(n);
  const cols = Number(/repeat\((\d+),/.exec(gridTemplateColumns)![1]);
  const rows = Number(/repeat\((\d+),/.exec(gridTemplateRows)![1]);
  return { cols, rows };
};

test("the lattice has a cell for every tile, with no empty row", () => {
  for (let n = 1; n <= 16; n++) {
    const { cols, rows } = cells(n);
    expect(cols * rows).toBeGreaterThanOrEqual(n);
    expect(cols * (rows - 1)).toBeLessThan(n);
  }
});

test("the counts the audit names", () => {
  expect(cells(1)).toEqual({ cols: 1, rows: 1 });
  expect(cells(2)).toEqual({ cols: 2, rows: 1 });
  expect(cells(5)).toEqual({ cols: 3, rows: 2 });
  expect(cells(12)).toEqual({ cols: 4, rows: 3 });
});

test("a return path is followed only on this site, and never decoded twice", () => {
  expect(safeReturnTo("/join/abc", "/inbox")).toBe("/join/abc");
  expect(safeReturnTo("/docs/100%25", "/start")).toBe("/docs/100%25");
  expect(safeReturnTo("/bad%E0%A4%A", "/start")).toBe("/bad%E0%A4%A");
  expect(safeReturnTo(null, "/inbox")).toBe("/inbox");
  expect(safeReturnTo("https://evil.example", "/inbox")).toBe("/inbox");
  expect(safeReturnTo("//evil.example", "/inbox")).toBe("/inbox");
  expect(safeReturnTo("/\\evil.example", "/inbox")).toBe("/inbox");
});
