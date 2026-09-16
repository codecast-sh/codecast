import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../Sidebar.tsx", import.meta.url), "utf8");

function block(startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

// A sidebar row swaps its trailing marker for its hover actions, so the two
// never fight over the row's width. A chat channel's huddle chip rode in that
// trailing slot, which meant pointing at "join" was what erased it: the chip
// vanished the moment the row was hovered and no mouse could ever reach it.
// The chip is a control now, and a control does not yield to hover.
test("the huddle chip is a control, not a trailing marker", () => {
  const signals = block("function channelSignals(", "const ChatNavRow = memo(");
  // Past the signature, which names both slots as types.
  const body = signals.slice(signals.indexOf("return {"));
  const control = body.slice(body.indexOf("control:"), body.indexOf("trailing:"));
  expect(control).toContain("<OccupancyChip");
  const trailing = body.slice(body.indexOf("trailing:"));
  expect(trailing).not.toContain("<OccupancyChip");
  expect(trailing).toContain("mentionCount");
});

test("a row's control survives hover while its trailing marker steps aside", () => {
  const row = block("function SectionRow(", "/** A numeric count on a nav row.");
  const control = row.slice(row.indexOf("{row.control &&"), row.indexOf("{row.trailing &&"));
  expect(control).not.toContain("group-hover/v:hidden");
  const trailing = row.slice(row.indexOf("{row.trailing &&"), row.indexOf("{!!row.actions?.length"));
  expect(trailing).toContain("group-hover/v:hidden");
});

test("both chat rows in the rail wear the same signals", () => {
  const spreads = source.match(/\.\.\.\(?(?:live \? )?channelSignals\(/g) ?? [];
  expect(spreads.length).toBe(2);
});
