import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { addVault } from "./vaultRegistry.js";
import {
  VAULT_EXIT,
  VaultCliError,
  applyEdit,
  joinBody,
  linkReport,
  openVault,
  pathGlobMatcher,
  readNote,
  resolveNote,
  searchNotes,
  selectVault,
  targetNote,
  moveNote,
  trashNote,
  writeNote,
} from "./vaultCli.js";
import { buildMatcher, contextWindow, matchingLines, resolveLineRange } from "../textView.js";

let base = "";
let configDir = "";
let notesDir = "";

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "vault-cli-"));
  configDir = path.join(base, ".codecast");
  notesDir = path.join(base, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
});

function note(rel: string, body: string): void {
  const abs = path.join(notesDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

/** Run `fn` and hand back the VaultCliError it threw. */
async function failure(fn: () => unknown | Promise<unknown>): Promise<VaultCliError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof VaultCliError) return err;
    throw err;
  }
  throw new Error("expected a VaultCliError");
}

// ---------------------------------------------------------------------------

describe("selectVault", () => {
  test("defaults to the only registered vault", () => {
    const added = addVault(configDir, notesDir);
    expect(selectVault(configDir).id).toBe(added.id);
  });

  test("no vaults registered is a not-found", async () => {
    const err = await failure(() => selectVault(configDir));
    expect(err.exitCode).toBe(VAULT_EXIT.notFound);
    expect(err.message).toContain("cast vault add");
  });

  test("several vaults and no --vault is ambiguous, and lists them", async () => {
    const other = path.join(base, "wiki");
    fs.mkdirSync(other);
    addVault(configDir, notesDir);
    addVault(configDir, other, "Wiki");

    const err = await failure(() => selectVault(configDir));
    expect(err.exitCode).toBe(VAULT_EXIT.ambiguous);
    expect(err.candidates).toHaveLength(2);
  });

  test("--vault matches an id, a root path or a name", () => {
    const other = path.join(base, "wiki");
    fs.mkdirSync(other);
    const notes = addVault(configDir, notesDir, "Notes");
    const wiki = addVault(configDir, other, "Wiki");

    expect(selectVault(configDir, notes.id).id).toBe(notes.id);
    expect(selectVault(configDir, notesDir).id).toBe(notes.id);
    expect(selectVault(configDir, "wiki").id).toBe(wiki.id);
    expect(selectVault(configDir, "WIKI").id).toBe(wiki.id);
  });

  test("two vaults sharing a name is ambiguous, not a silent pick", async () => {
    const other = path.join(base, "wiki");
    fs.mkdirSync(other);
    addVault(configDir, notesDir, "Same");
    addVault(configDir, other, "Same");

    const err = await failure(() => selectVault(configDir, "Same"));
    expect(err.exitCode).toBe(VAULT_EXIT.ambiguous);
  });

  test("an unknown --vault is a not-found", async () => {
    addVault(configDir, notesDir);
    const err = await failure(() => selectVault(configDir, "nope"));
    expect(err.exitCode).toBe(VAULT_EXIT.notFound);
  });
});

describe("openVault", () => {
  test("a registered root that has since vanished is unreachable, not empty", async () => {
    addVault(configDir, notesDir);
    fs.rmSync(notesDir, { recursive: true, force: true });
    const err = await failure(() => openVault(configDir, undefined));
    expect(err.exitCode).toBe(VAULT_EXIT.unreachable);
  });

  test("indexes paths without reading any bodies by default", async () => {
    note("A.md", "body");
    addVault(configDir, notesDir);
    const ctx = await openVault(configDir, undefined);
    expect(ctx.hasContent).toBe(false);
    expect(ctx.contents.size).toBe(0);
    expect(ctx.index.paths()).toEqual(["A.md"]);
  });
});

describe("resolveNote", () => {
  test("resolves an exact path, a path without its extension, and a bare name", async () => {
    note("Areas/Health/Sleep.md", "# Sleep");
    addVault(configDir, notesDir);
    const ctx = await openVault(configDir, undefined);

    for (const input of ["Areas/Health/Sleep.md", "Areas/Health/Sleep", "Health/Sleep", "Sleep", "sleep"]) {
      expect((await resolveNote(ctx, input)).path).toBe("Areas/Health/Sleep.md");
    }
  });

  test("a name in two folders is ambiguous and names the candidates", async () => {
    note("A/Sleep.md", "one");
    note("B/Sleep.md", "two");
    addVault(configDir, notesDir);
    const ctx = await openVault(configDir, undefined);

    const err = await failure(() => resolveNote(ctx, "Sleep"));
    expect(err.exitCode).toBe(VAULT_EXIT.ambiguous);
    expect(err.candidates).toEqual(["A/Sleep.md", "B/Sleep.md"]);
  });

  test("an exact path wins over the same name elsewhere", async () => {
    note("A/Sleep.md", "one");
    note("B/Sleep.md", "two");
    addVault(configDir, notesDir);
    const ctx = await openVault(configDir, undefined);
    expect((await resolveNote(ctx, "A/Sleep.md")).path).toBe("A/Sleep.md");
  });

  test("a frontmatter alias resolves, reading bodies only once the paths miss", async () => {
    note("Areas/Rest.md", "---\naliases: [Kip]\n---\n\n# Rest\n");
    addVault(configDir, notesDir);
    const ctx = await openVault(configDir, undefined);
    expect(ctx.hasContent).toBe(false);

    expect((await resolveNote(ctx, "Kip")).path).toBe("Areas/Rest.md");
    expect(ctx.hasContent).toBe(true);
  });

  test("an unknown name is a not-found", async () => {
    note("A.md", "x");
    addVault(configDir, notesDir);
    const ctx = await openVault(configDir, undefined);
    const err = await failure(() => resolveNote(ctx, "Nope"));
    expect(err.exitCode).toBe(VAULT_EXIT.notFound);
  });

  test("a path escaping the vault is refused", async () => {
    note("A.md", "x");
    addVault(configDir, notesDir);
    const ctx = await openVault(configDir, undefined);
    await failure(() => resolveNote(ctx, "../secrets.md"));
  });
});

describe("targetNote", () => {
  test("an existing note resolves; a new name becomes a literal .md path", async () => {
    note("A/Sleep.md", "x");
    addVault(configDir, notesDir);
    const ctx = await openVault(configDir, undefined);

    const existing = await targetNote(ctx, "Sleep");
    expect(existing).toMatchObject({ path: "A/Sleep.md", exists: true });

    const fresh = await targetNote(ctx, "Inbox/New Idea");
    expect(fresh).toMatchObject({ path: "Inbox/New Idea.md", exists: false });
  });

  test("an explicit extension the vault serves is kept as typed", async () => {
    addVault(configDir, notesDir);
    const ctx = await openVault(configDir, undefined);
    expect((await targetNote(ctx, "notes/log.markdown")).path).toBe("notes/log.markdown");
  });

  test("ambiguity still errors rather than creating a new file", async () => {
    note("A/Sleep.md", "one");
    note("B/Sleep.md", "two");
    addVault(configDir, notesDir);
    const ctx = await openVault(configDir, undefined);
    const err = await failure(() => targetNote(ctx, "Sleep"));
    expect(err.exitCode).toBe(VAULT_EXIT.ambiguous);
  });
});

describe("applyEdit", () => {
  test("replaces the one occurrence", () => {
    expect(applyEdit("a\nold\nb", "old", "new")).toBe("a\nnew\nb");
  });

  test("absent old text is a not-found", () => {
    try {
      applyEdit("a\nb", "missing", "x");
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as VaultCliError).exitCode).toBe(VAULT_EXIT.notFound);
    }
  });

  test("more than one occurrence is ambiguous and says how many", () => {
    try {
      applyEdit("dup\nmid\ndup", "dup", "x");
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as VaultCliError).exitCode).toBe(VAULT_EXIT.ambiguous);
      expect((err as VaultCliError).message).toContain("2 times");
    }
  });

  test("an empty --old is refused rather than inserting everywhere", () => {
    expect(() => applyEdit("abc", "", "x")).toThrow();
  });

  test("multi-line old text matches verbatim, whitespace included", () => {
    expect(applyEdit("# T\n\n- a\n- b\n", "- a\n- b", "- a\n- b\n- c")).toBe("# T\n\n- a\n- b\n- c\n");
  });
});

describe("joinBody", () => {
  test("append and prepend keep one blank line at the seam", () => {
    expect(joinBody("# T\n", "more", "append")).toBe("# T\n\nmore\n");
    expect(joinBody("# T\n", "intro", "prepend")).toBe("intro\n\n# T\n");
  });

  test("an empty side contributes nothing but the trailing newline", () => {
    expect(joinBody("", "only", "append")).toBe("only\n");
    expect(joinBody("# T\n", "", "append")).toBe("# T\n");
  });
});

describe("write, read and trash", () => {
  test("writing then reading round-trips through the vault", async () => {
    addVault(configDir, notesDir);
    const ctx = await openVault(configDir, undefined);
    const target = await targetNote(ctx, "Inbox/Idea");
    await writeNote(target, "# Idea\n");
    expect(fs.readFileSync(path.join(notesDir, "Inbox/Idea.md"), "utf8")).toBe("# Idea\n");

    const reopened = await openVault(configDir, undefined);
    const ref = await resolveNote(reopened, "Idea");
    expect(await readNote(reopened, ref)).toBe("# Idea\n");
  });

  test("cat on an attachment refuses instead of printing bytes", async () => {
    note("img.png", " binary");
    addVault(configDir, notesDir);
    const ctx = await openVault(configDir, undefined);
    const ref = await resolveNote(ctx, "img.png");
    await failure(() => readNote(ctx, ref));
  });

  test("rm moves the note out of the vault rather than unlinking it", async () => {
    note("Gone.md", "bye");
    addVault(configDir, notesDir);
    const ctx = await openVault(configDir, undefined);
    const ref = await resolveNote(ctx, "Gone");

    const dest = trashNote(ctx, ref);
    expect(fs.existsSync(ref.abs)).toBe(false);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, "utf8")).toBe("bye");
    try { fs.rmSync(dest, { force: true }); } catch {}
  });
});

describe("moveNote", () => {
  test("moves the file and repoints the links that pointed at it", async () => {
    note("Hub.md", "# Hub\n\nSee [[Sleep]] and [[Sleep|a nap]].\n");
    note("Sleep.md", "# Sleep\n");
    addVault(configDir, notesDir);
    const ctx = await openVault(configDir, undefined);

    const result = await moveNote(ctx, await resolveNote(ctx, "Sleep"), await targetNote(ctx, "Areas/Rest"));
    expect(result).toMatchObject({ from: "Sleep.md", to: "Areas/Rest.md", rewritten: ["Hub.md"] });
    expect(fs.existsSync(path.join(notesDir, "Areas/Rest.md"))).toBe(true);
    // The shortest spelling that still resolves uniquely, and the alias kept —
    // the same rule the browser's rename follows.
    expect(fs.readFileSync(path.join(notesDir, "Hub.md"), "utf8")).toBe(
      "# Hub\n\nSee [[Rest]] and [[Rest|a nap]].\n",
    );
  });

  test("--no-rewrite-links moves the file and leaves every link alone", async () => {
    note("Hub.md", "See [[Sleep]].\n");
    note("Sleep.md", "# Sleep\n");
    addVault(configDir, notesDir);
    const ctx = await openVault(configDir, undefined);

    const result = await moveNote(
      ctx,
      await resolveNote(ctx, "Sleep"),
      await targetNote(ctx, "Areas/Rest"),
      { rewriteLinks: false },
    );
    expect(result.rewritten).toEqual([]);
    expect(fs.readFileSync(path.join(notesDir, "Hub.md"), "utf8")).toBe("See [[Sleep]].\n");
  });

  test("moving onto an existing note is refused, not an overwrite", async () => {
    note("A.md", "one");
    note("B.md", "two");
    addVault(configDir, notesDir);
    const ctx = await openVault(configDir, undefined);

    const err = await failure(async () =>
      moveNote(ctx, await resolveNote(ctx, "A"), await targetNote(ctx, "B")),
    );
    expect(err.exitCode).toBe(VAULT_EXIT.ambiguous);
    expect(fs.readFileSync(path.join(notesDir, "A.md"), "utf8")).toBe("one");
  });
});

describe("linkReport", () => {
  test("splits a note's links into resolved, unresolved and incoming", async () => {
    note("Hub.md", "# Hub\n\nSee [[Sleep]] and [[Nowhere]].\n");
    note("Areas/Sleep.md", "# Sleep\n\nBack to [[Hub]].\n");
    addVault(configDir, notesDir);
    const ctx = await openVault(configDir, undefined, { content: true });

    const report = linkReport(ctx, "Hub.md");
    expect(report.outgoing.map((l) => l.resolved)).toEqual(["Areas/Sleep.md", null]);
    expect(report.unresolved).toEqual(["Nowhere"]);
    expect(report.backlinks.map((b) => b.source)).toEqual(["Areas/Sleep.md"]);
  });
});

describe("searchNotes", () => {
  beforeEach(() => {
    note("Areas/Sleep.md", "---\ntags: [health, habit/night]\n---\n\n# Sleep hygiene\n\nGo to bed earlier.\n");
    note("Projects/Ship.md", "# Ship it\n\n#work deadline is friday.\n");
    addVault(configDir, notesDir);
  });

  test("tag: filters, including tags nested under it", async () => {
    const ctx = await openVault(configDir, undefined, { content: true });
    expect(searchNotes(ctx, "tag:health").map((h) => h.path)).toEqual(["Areas/Sleep.md"]);
    expect(searchNotes(ctx, "tag:habit").map((h) => h.path)).toEqual(["Areas/Sleep.md"]);
    expect(searchNotes(ctx, "tag:work").map((h) => h.path)).toEqual(["Projects/Ship.md"]);
  });

  test("path: and file: filter on where the note lives and what it is called", async () => {
    const ctx = await openVault(configDir, undefined, { content: true });
    expect(searchNotes(ctx, "path:projects").map((h) => h.path)).toEqual(["Projects/Ship.md"]);
    expect(searchNotes(ctx, "file:sleep").map((h) => h.path)).toEqual(["Areas/Sleep.md"]);
  });

  test("a title hit outranks a body hit", async () => {
    note("Other.md", "# Other\n\nthe word ship appears here.\n");
    const ctx = await openVault(configDir, undefined, { content: true });
    expect(searchNotes(ctx, "ship")[0].path).toBe("Projects/Ship.md");
  });

  test('a "quoted phrase" must appear contiguously', async () => {
    const ctx = await openVault(configDir, undefined, { content: true });
    expect(searchNotes(ctx, '"bed earlier"').map((h) => h.path)).toEqual(["Areas/Sleep.md"]);
    expect(searchNotes(ctx, '"earlier bed"')).toEqual([]);
  });

  test("-term drops notes that mention it", async () => {
    const ctx = await openVault(configDir, undefined, { content: true });
    expect(searchNotes(ctx, "tag:health -hygiene")).toEqual([]);
  });

  test("an empty query is refused rather than listing the vault", async () => {
    const ctx = await openVault(configDir, undefined, { content: true });
    await failure(() => searchNotes(ctx, "   "));
  });
});

describe("pathGlobMatcher", () => {
  test("* stays inside a segment and ** crosses them", () => {
    const inRoot = pathGlobMatcher("*.md");
    expect(inRoot("Note.md")).toBe(true);
    expect(inRoot("A/Note.md")).toBe(true); // bare pattern also tries the basename

    const deep = pathGlobMatcher("Areas/**/*.md");
    expect(deep("Areas/Health/Sleep.md")).toBe(true);
    expect(deep("Projects/Ship.md")).toBe(false);

    const oneLevel = pathGlobMatcher("Areas/*.md");
    expect(oneLevel("Areas/Sleep.md")).toBe(true);
    expect(oneLevel("Areas/Health/Sleep.md")).toBe(false);
  });

  test("matching ignores case and takes ? as one character", () => {
    expect(pathGlobMatcher("areas/sleep.md")("Areas/Sleep.md")).toBe(true);
    expect(pathGlobMatcher("A?.md")("A1.md")).toBe(true);
    expect(pathGlobMatcher("A?.md")("A12.md")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The reading primitives cast doc and cast vault share
// ---------------------------------------------------------------------------

describe("resolveLineRange", () => {
  test("start:end, open ends, and a single line", () => {
    expect(resolveLineRange(300, { range: "100:250" })).toMatchObject({ start: 100, end: 250 });
    expect(resolveLineRange(300, { range: "100:" })).toMatchObject({ start: 100, end: 300 });
    expect(resolveLineRange(300, { range: ":50" })).toMatchObject({ start: 1, end: 50 });
    expect(resolveLineRange(300, { range: "42" })).toMatchObject({ start: 42, end: 42 });
  });

  test("clamps past the end and never returns an inverted range", () => {
    expect(resolveLineRange(10, { range: "5:999" })).toMatchObject({ start: 5, end: 10 });
    expect(resolveLineRange(10, { range: "99" })).toMatchObject({ start: 10, end: 10 });
    expect(resolveLineRange(10, { range: "8:3" })).toMatchObject({ start: 8, end: 8 });
  });

  test("--full and paging", () => {
    expect(resolveLineRange(500, { full: true })).toMatchObject({ start: 1, end: 500, pages: 1 });
    expect(resolveLineRange(500, { page: 2, pageSize: 200 })).toMatchObject({ start: 201, end: 400, pages: 3 });
    expect(resolveLineRange(500, { page: 9, pageSize: 200 })).toMatchObject({ start: 401, end: 500, page: 3 });
  });

  test("an explicit range wins over a page number", () => {
    expect(resolveLineRange(500, { range: "10:20", page: 3 })).toMatchObject({ start: 10, end: 20 });
  });
});

describe("buildMatcher", () => {
  test("a valid regex is used as a regex", () => {
    const m = buildMatcher("P0\\.");
    expect(m.literal).toBe(false);
    expect(matchingLines(["P0. one", "P1. two"], m)).toEqual([0]);
  });

  test("an invalid regex falls back to a literal search", () => {
    const m = buildMatcher("count(");
    expect(m.literal).toBe(true);
    expect(matchingLines(["count( x )", "other"], m)).toEqual([0]);
  });

  test("-i is case-insensitive", () => {
    expect(matchingLines(["Sleep"], buildMatcher("sleep"))).toEqual([]);
    expect(matchingLines(["Sleep"], buildMatcher("sleep", true))).toEqual([0]);
  });

  test("the global copy is separate, so repeated tests do not skip lines", () => {
    const m = buildMatcher("a", false);
    expect(matchingLines(["a", "a", "a"], m)).toEqual([0, 1, 2]);
  });
});

describe("contextWindow", () => {
  test("no context lists the hits themselves", () => {
    expect(contextWindow([1, 5], 0, 10)).toEqual([1, null, 5]);
  });

  test("overlapping windows merge instead of repeating lines", () => {
    expect(contextWindow([2, 3], 1, 10)).toEqual([1, 2, 3, 4]);
  });

  test("context is clamped at both ends of the body", () => {
    expect(contextWindow([0], 2, 3)).toEqual([0, 1, 2]);
    expect(contextWindow([2], 2, 3)).toEqual([0, 1, 2]);
  });
});
