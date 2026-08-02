// The bookmark list's rules: one row per target, labels that fall back to the
// target's own name, and following the vault when paths move or vanish.

import { test, expect, describe } from "bun:test";
import {
  addBookmark,
  bookmarkKey,
  bookmarkLabel,
  bookmarkSubtitle,
  defaultBookmarkLabel,
  findBookmark,
  isBookmarked,
  removeBookmark,
  retargetBookmarks,
  retitleBookmark,
  sortBookmarks,
  type BookmarkItem,
} from "../bookmarks";

let seq = 0;
const note = (path: string, title?: string): BookmarkItem => ({
  kind: "note",
  path,
  id: `n${seq++}`,
  createdAt: seq,
  ...(title ? { title } : {}),
});
const folder = (path: string): BookmarkItem => ({ kind: "folder", path, id: `f${seq++}`, createdAt: seq });
const heading = (path: string, headingText: string, slug: string): BookmarkItem => ({
  kind: "heading",
  path,
  headingText,
  slug,
  id: `h${seq++}`,
  createdAt: seq,
});
const search = (query: string): BookmarkItem => ({ kind: "search", query, id: `s${seq++}`, createdAt: seq });

describe("identity", () => {
  test("a target is bookmarked once, however many times it is added", () => {
    const list = addBookmark(addBookmark([], note("a/One.md")), note("a/One.md"));
    expect(list).toHaveLength(1);
  });

  test("adding an already-bookmarked target returns the same array", () => {
    const list = addBookmark([], note("a/One.md"));
    expect(addBookmark(list, note("a/One.md"))).toBe(list);
  });

  test("kinds never collide, and a heading is keyed by its deduped slug", () => {
    expect(bookmarkKey(note("Notes/A.md"))).not.toBe(bookmarkKey(folder("Notes/A.md")));
    expect(bookmarkKey(heading("A.md", "Plan", "plan"))).not.toBe(
      bookmarkKey(heading("A.md", "Plan", "plan-2")),
    );
    // Two headings with the same text in one note are two bookmarks.
    const list = addBookmark(addBookmark([], heading("A.md", "Plan", "plan")), heading("A.md", "Plan", "plan-2"));
    expect(list).toHaveLength(2);
  });

  test("a saved search is keyed by its trimmed query", () => {
    const list = addBookmark([], search("tag:draft"));
    expect(isBookmarked(list, { kind: "search", query: "  tag:draft  " })).toBe(true);
    expect(isBookmarked(list, { kind: "search", query: "tag:done" })).toBe(false);
  });

  test("findBookmark returns the row so a toggle can remove it", () => {
    const row = note("a/One.md");
    expect(findBookmark([row], { kind: "note", path: "a/One.md" })?.id).toBe(row.id);
    expect(findBookmark([row], { kind: "note", path: "other.md" })).toBeNull();
  });
});

describe("labels", () => {
  test("a note shows its name without the extension or folders", () => {
    expect(bookmarkLabel(note("Projects/Q3 Plan.md"))).toBe("Q3 Plan");
    expect(bookmarkSubtitle(note("Projects/Q3 Plan.md"))).toBe("Projects/Q3 Plan.md");
  });

  test("a folder shows its own name, and the vault root says so", () => {
    expect(bookmarkLabel(folder("Projects/Q3"))).toBe("Q3");
    expect(bookmarkLabel(folder(""))).toBe("Vault root");
  });

  test("a saved search says what it searches for", () => {
    expect(bookmarkLabel(search("tag:draft"))).toBe("tag:draft");
    expect(bookmarkSubtitle(search("tag:draft"))).toBe("Saved search: tag:draft");
  });

  test("a heading shows its text over the note it lives in", () => {
    const h = heading("Projects/Q3 Plan.md", "Risks", "risks");
    expect(bookmarkLabel(h)).toBe("Risks");
    expect(bookmarkSubtitle(h)).toBe("Q3 Plan");
  });

  test("a user title wins, and clearing it falls back to the target's name", () => {
    const list = [note("Projects/Q3 Plan.md")];
    const titled = retitleBookmark(list, list[0].id, "  The plan  ");
    expect(bookmarkLabel(titled[0])).toBe("The plan");
    expect(defaultBookmarkLabel(titled[0])).toBe("Q3 Plan");
    const cleared = retitleBookmark(titled, list[0].id, "");
    expect(cleared[0].title).toBeUndefined();
    expect(bookmarkLabel(cleared[0])).toBe("Q3 Plan");
  });

  test("retitling to what it already says changes nothing", () => {
    const list = [note("A.md", "Mine")];
    expect(retitleBookmark(list, list[0].id, "Mine")).toBe(list);
    expect(retitleBookmark(list, "no-such-id", "x")).toBe(list);
  });
});

describe("following the vault", () => {
  const list = [
    note("Projects/Q3 Plan.md"),
    folder("Projects"),
    heading("Projects/Q3 Plan.md", "Risks", "risks"),
    search("tag:draft"),
  ];

  test("a rename retargets every bookmark on that path, heading included", () => {
    const moved = retargetBookmarks(list, (p) =>
      p === "Projects/Q3 Plan.md" ? "Projects/Q4 Plan.md" : undefined,
    );
    expect(moved.map((b) => (b.kind === "search" ? b.query : b.path))).toEqual([
      "Projects/Q4 Plan.md",
      "Projects",
      "Projects/Q4 Plan.md",
      "tag:draft",
    ]);
    // The heading keeps its slug: it still points at the same section.
    expect(moved[2]).toMatchObject({ kind: "heading", slug: "risks", headingText: "Risks" });
  });

  test("a folder rename retargets the folder bookmark", () => {
    const moved = retargetBookmarks(list, (p) => (p === "Projects" ? "Archive/Projects" : undefined));
    expect(moved[1]).toMatchObject({ kind: "folder", path: "Archive/Projects" });
  });

  test("a delete drops the bookmarks that pointed there", () => {
    const after = retargetBookmarks(list, (p) => (p === "Projects/Q3 Plan.md" ? null : undefined));
    expect(after).toHaveLength(2);
    expect(after.map((b) => b.kind)).toEqual(["folder", "search"]);
  });

  test("saved searches are never touched, and an untouched list keeps its identity", () => {
    expect(retargetBookmarks(list, () => undefined)).toBe(list);
    // A resolver that would drop everything still leaves the search alone.
    expect(retargetBookmarks(list, () => null)).toEqual([list[3]]);
  });
});

describe("order", () => {
  test("oldest first, so a new bookmark lands at the bottom", () => {
    const a: BookmarkItem = { kind: "note", path: "a.md", id: "a", createdAt: 30 };
    const b: BookmarkItem = { kind: "note", path: "b.md", id: "b", createdAt: 10 };
    const c: BookmarkItem = { kind: "note", path: "c.md", id: "c", createdAt: 20 };
    expect(sortBookmarks([a, b, c]).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  test("removing a row leaves the rest in place, and a miss changes nothing", () => {
    const list = [note("a.md"), note("b.md")];
    expect(removeBookmark(list, list[0].id).map((b) => (b.kind === "note" ? b.path : ""))).toEqual(["b.md"]);
    expect(removeBookmark(list, "nope")).toBe(list);
  });
});
