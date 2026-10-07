import { describe, expect, test } from "bun:test";
import type { TimelineEntry } from "../../convex/versions";
import { makeLiveSays, versionSummary } from "./versionCopy";

const entry = (number: number, over: Partial<TimelineEntry> = {}): TimelineEntry => ({
  number,
  parent_number: number > 1 ? number - 1 : null,
  kind: "build",
  summary: `Change ${number}`,
  author: null,
  request_message_id: null,
  source: null,
  undid: null,
  spotlight: null,
  try_it: null,
  file_count: 1,
  created_at: number,
  forks: [],
  ...over,
});

const byNumber = (...es: TimelineEntry[]) => new Map(es.map((e) => [e.number, e]));

describe("versionSummary", () => {
  test("a build says its own summary", () => {
    expect(versionSummary(entry(2), byNumber(entry(1), entry(2)))).toBe("Change 2");
  });

  test("a bring-back says so, with what it brought back", () => {
    const back = entry(4, { kind: "restore", parent_number: 3, source: { app_id: "a" as never, version: 1 }, summary: "Change 1" });
    expect(versionSummary(back, byNumber(entry(1), entry(2), entry(3), back))).toBe("Brought back v1: Change 1");
  });

  test("an undo says what it took out", () => {
    const undo = entry(4, { kind: "restore", parent_number: 3, source: { app_id: "a" as never, version: 2 }, undid: 3, summary: "Undid v3: Change 3" });
    expect(versionSummary(undo, byNumber(entry(2), entry(3), undo))).toBe("Undid v3: Change 3");
  });

  test("past the loaded timeline, a restore still says its verb once", () => {
    const undo = entry(40, { kind: "restore", parent_number: 39, source: { app_id: "a" as never, version: 2 }, undid: 39, summary: "Undid v39: X" });
    const back = entry(41, { kind: "restore", parent_number: 40, source: { app_id: "a" as never, version: 3 }, summary: "Y" });
    expect(versionSummary(undo, byNumber(undo))).toBe("Undid v39: X");
    expect(versionSummary(back, byNumber(back))).toBe("Brought back v3: Y");
  });
});

describe("makeLiveSays", () => {
  test("names the versions it takes out and the newest one's summary", () => {
    const tl = byNumber(entry(3), entry(4), entry(5), entry(6));
    expect(makeLiveSays(3, 6, tl)).toBe("Everyone sees v3. Takes out v4 to v6: Change 6");
    expect(makeLiveSays(5, 6, tl)).toBe("Everyone sees v5. Takes out v6: Change 6");
  });
});
