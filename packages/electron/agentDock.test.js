const { test, expect } = require("bun:test");
const { mergeAgentDock, placeAgentDock } = require("./agentDock");

test("off unless asked for, and junk is dropped", () => {
  expect(mergeAgentDock(undefined)).toEqual({ enabled: false, edge: "right", offset: 0.28, minimized: false });
  expect(mergeAgentDock({ enabled: "yes", edge: "top", offset: 9, extra: 1 })).toEqual({ enabled: false, edge: "right", offset: 0.9, minimized: false });
  expect(mergeAgentDock({ enabled: true, edge: "left", offset: 0.5, minimized: true })).toEqual({ enabled: true, edge: "left", offset: 0.5, minimized: true });
});

test("flush to the right edge and grows leftward", () => {
  const area = { x: 0, y: 25, width: 1512, height: 957 };
  const s = mergeAgentDock({ enabled: true });
  const pill = placeAgentDock(area, { width: 44, height: 300 }, s);
  const open = placeAgentDock(area, { width: 520, height: 300 }, s);
  expect(pill.x + pill.width).toBe(1512);
  expect(open.x + open.width).toBe(1512);
  expect(open.y).toBe(pill.y);
});

test("a tall card is pulled up rather than hanging off the bottom", () => {
  const area = { x: 0, y: 0, width: 1000, height: 800 };
  const r = placeAgentDock(area, { width: 400, height: 700 }, mergeAgentDock({ enabled: true, offset: 0.5 }));
  expect(r.y + r.height).toBe(800);
});

test("left edge on a second display", () => {
  const area = { x: 1512, y: 0, width: 1920, height: 1080 };
  const r = placeAgentDock(area, { width: 44, height: 200 }, mergeAgentDock({ enabled: true, edge: "left" }));
  expect(r.x).toBe(1512);
});
