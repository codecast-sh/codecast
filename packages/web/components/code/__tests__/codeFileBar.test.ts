import { expect, test } from "bun:test";
import { foldedFolders } from "../../../lib/code/workspace/crumbFold";

test("leading folders fold first; the nearest one never folds", () => {
  const widths = [70, 40, 80, 60];
  expect(foldedFolders(widths, 300)).toBe(0);
  // 250 px of folders in 220: dropping the first (70) leaves 180 plus the "…" crumb (30).
  expect(foldedFolders(widths, 220)).toBe(1);
  expect(foldedFolders(widths, 100)).toBe(3);
  expect(foldedFolders(widths, 10)).toBe(3);
  expect(foldedFolders([], 0)).toBe(0);
});
