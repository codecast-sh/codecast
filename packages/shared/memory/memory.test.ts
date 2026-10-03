import { describe, expect, test } from "bun:test";
import {
  buildMemoryAtlas,
  indexLineFiles,
  memoryIndexBudget,
  memoryLinkTargets,
  newMemoryRaw,
  readMemoryFields,
  removeIndexLinesFor,
  writeMemoryField,
} from "./index";

const file = (name: string, raw: string) => ({ file: name, raw, mtime: 1, bytes: raw.length });

describe("index budget", () => {
  test("cuts at the first whole line past 25,000 bytes or 200 lines", () => {
    const short = Array(260).fill("x".repeat(99)).join("\n") + "\n";
    expect(memoryIndexBudget(short).cutAt).toBe(201);
    const wide = Array(150).fill("y".repeat(199)).join("\n") + "\n";
    expect(memoryIndexBudget(wide).cutAt).toBe(126);
    expect(memoryIndexBudget("- [a](a.md)\n").cutAt).toBeNull();
  });
});

describe("links", () => {
  test("wiki and markdown links, never inside code", () => {
    const body = "See [[alpha-note]] and [b](dir/beta.md) and [site](https://x.dev/a.md).\n`[[ $- == *i* ]]`\n```\n[[not_a_link]]\n[c](c.md)\n```";
    expect(memoryLinkTargets(body).sort()).toEqual(["alpha-note", "beta.md"]);
  });
  test("an index line names the files it links", () => {
    expect(indexLineFiles("- Traps: [a](a.md) · [b](b.md)")).toEqual(["a.md", "b.md"]);
  });
});

describe("frontmatter edits keep every other line", () => {
  const raw = `---\nname: a\ndescription: "old: one"\nmetadata:\n  type: project\n  originSessionId: keep\n---\n\nbody\n`;
  test("nested type and quoted description", () => {
    expect(readMemoryFields(raw)).toEqual({ name: "a", description: "old: one", type: "project", hasFrontmatter: true });
    const next = writeMemoryField(writeMemoryField(raw, "type", "reference"), "description", "new: two");
    expect(next).toBe(`---\nname: a\ndescription: "new: two"\nmetadata:\n  type: reference\n  originSessionId: keep\n---\n\nbody\n`);
  });
  test("top-level type stays top-level", () => {
    const flat = writeMemoryField("---\nname: a\ntype: user\n---\n\nb", "type", "feedback");
    expect(flat).toBe("---\nname: a\ntype: feedback\n---\n\nb");
  });
  test("a new memory nests its type", () => {
    expect(newMemoryRaw({ name: "x-y", description: "d", type: "user" }, "b")).toBe("---\nname: x-y\ndescription: d\nmetadata:\n  type: user\n---\n\nb");
  });
});

describe("atlas reach", () => {
  const index = "- [A](a.md)\n" + Array(130).fill("z".repeat(199)).join("\n") + "\n- [C](c.md)\n";
  const atlas = buildMemoryAtlas(
    [
      file("a.md", "---\nname: alpha\n---\n\nsee [[beta_note]] and [[missing]]"),
      file("beta_note.md", "---\nname: beta-note\n---\n\nleaf"),
      file("c.md", "---\nname: c\n---\n\nbelow the cut"),
      file("d.md", "no frontmatter, links [[c]]"),
    ],
    index,
  );
  const reach = (f: string) => atlas.byFile.get(f)!.reach;
  test("loaded, reachable, cut and orphan", () => {
    expect(atlas.index.budget.cutAt).not.toBeNull();
    expect([reach("a.md"), reach("beta_note.md"), reach("c.md"), reach("d.md")]).toEqual(["loaded", "reachable", "cut", "orphan"]);
  });
  test("names resolve across hyphens and underscores; unknown targets stay null", () => {
    expect(atlas.byFile.get("a.md")!.links).toEqual([
      { raw: "beta_note", file: "beta_note.md" },
      { raw: "missing", file: null },
    ]);
    expect(atlas.byFile.get("c.md")!.inbound).toEqual(["d.md"]);
  });
  test("removing an index line drops only lines that point at that file alone", () => {
    expect(removeIndexLinesFor("- [A](a.md)\n- [A](a.md) · [B](b.md)\n", "a.md")).toEqual({ raw: "- [A](a.md) · [B](b.md)\n", removed: 1 });
  });
});
