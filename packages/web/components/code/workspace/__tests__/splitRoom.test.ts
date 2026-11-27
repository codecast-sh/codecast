import { expect, test } from "bun:test";
import { minShare, roomToSplit } from "../CodeWorkspace";
import { emptyWorkspace, openTab, splitTo } from "../../../../lib/code/workspace/model";

test("the pixel floor becomes a share that can always be met", () => {
  // 260 px of a 900 px stage leaf.
  expect(Math.round(minShare(900, 2, 260))).toBe(29);
  // Three groups in a narrow pane: an equal share at most, so it never livelocks.
  expect(minShare(500, 3, 260)).toBeLessThan(100 / 3);
  // Wide or unmeasured: the old 12% minimum.
  expect(minShare(4000, 2, 260)).toBe(12);
  expect(minShare(0, 2, 260)).toBe(12);
});

test("a split needs both halves above the floor, and refuses at three groups", () => {
  let ws = openTab(emptyWorkspace(), "a");
  expect(roomToSplit(ws, "g1", "right", { w: 900, h: 700 })).toBe(true);
  expect(roomToSplit(ws, "g1", "right", { w: 480, h: 700 })).toBe(false);
  ws = splitTo(ws, "g1", "b", "right");
  // 450 px each in a 900 px leaf: no third column, but room to stack.
  expect(roomToSplit(ws, "g2", "right", { w: 900, h: 700 })).toBe(false);
  expect(roomToSplit(ws, "g2", "down", { w: 900, h: 700 })).toBe(true);
  ws = splitTo(ws, "g2", "c", "down");
  expect(roomToSplit(ws, "g1", "right", { w: 4000, h: 4000 })).toBe(false);
  expect(roomToSplit(openTab(emptyWorkspace(), "a"), "g1", "right", { w: 0, h: 0 })).toBe(true);
});
