import { describe, expect, test } from "bun:test";
import { buildMemoryAtlas } from "@codecast/shared/memory";
import { healthAlarm, memoryHealth, memoryHref, noteMatches } from "../memoryView";

const file = (name: string, raw: string) => ({ file: name, raw, mtime: 1, bytes: raw.length });

describe("memory page helpers", () => {
  const atlas = buildMemoryAtlas(
    [
      file("a.md", "---\nname: alpha\ndescription: first\nmetadata:\n  type: project\n---\n\nsee [[gone]]"),
      file("b.md", "---\nname: beta\ntype: trap\n---\n\nleaf"),
      file("c.md", "plain"),
    ],
    "- [A](a.md)\n- [Missing](missing.md)\n",
  );

  test("health names what keeps memories out of reach", () => {
    const h = memoryHealth(atlas);
    expect(h.unreached.map((n) => n.file)).toEqual(["b.md", "c.md"]);
    expect(h.danglingIndex).toEqual([{ line: 2, target: "missing.md" }]);
    expect(h.unwritten.map((u) => u.target)).toEqual(["gone"]);
    expect(h.undescribed.map((n) => n.file)).toEqual(["b.md", "c.md"]);
    expect(h.oddType.map((n) => n.file)).toEqual(["b.md"]);
    expect(healthAlarm(h)).toBe(3);
  });

  test("search reads name, file, description and body; type chips hide by kind", () => {
    const a = atlas.byFile.get("a.md")!;
    expect(noteMatches(a, "FIRST", new Set())).toBe(true);
    expect(noteMatches(a, "gone", new Set())).toBe(true);
    expect(noteMatches(a, "", new Set(["project"]))).toBe(false);
    expect(noteMatches(atlas.byFile.get("b.md")!, "", new Set(["other"]))).toBe(false);
  });

  test("hrefs leave the defaults out", () => {
    expect(memoryHref()).toBe("/memory");
    expect(memoryHref({ project: "-Users-me-app", view: "map", file: "a.md" })).toBe("/memory?p=-Users-me-app&m=a.md");
    expect(memoryHref({ view: "health" })).toBe("/memory?view=health");
  });
});
