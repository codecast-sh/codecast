import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LineProfileError, parseLineProfileText, starterLineProfile } from "./lineProfile";
import { applyLineProfileEdits, editLineProfile, runLineProfileEdit, type LineProfileEdit } from "./lineProfileEdit";

// The shape of codecast's own .codecast/line.toml: comments everywhere,
// aligned trailing notes, finders, and a comment block after the last finder.
const REPO = `# .codecast/line.toml: the line profile.
# \`cast line profile\` prints the resolved profile.

[line]
project = "Codecast: Product"        # default project for signals filed here
principles = ["docs/line/principles.md"]  # the shared set is always read too
prompting = "docs/prompting.md"
size_budget = 400                    # changed lines before a run returns to plan
watch_days = 7

# Run from the run's worktree; $vars expand in the command's own shell.
[line.commands]
check = "cast ws check"
prove = "bun scripts/line.ts prove --dir $run_dir"
eval  = "bun scripts/line.ts eval --base $default_branch --dir $run_dir"

[line.caps]
cards = 5                            # open cards per person

# What this repo listens to (LP3).
[[line.finders]]
id = "eval-drift"
source = "evals"
kind = ["regression", "prompt_miss"]
fingerprint = "evals:<surface>"
runs = "./evals check --signal"

[[line.finders]]
id = "lessons"
source = "lesson"
kind = "cohesion"
fingerprint = "lesson:<rule>"

# Not built: Sentry. No API token exists for this repo.
`;

const edit = (text: string, ...edits: LineProfileEdit[]) => applyLineProfileEdits(text, edits);
const values = (text: string) => parseLineProfileText(text).values;
/** The lines of `after` that are not in `before`, and the reverse: the whole footprint of an edit. */
function footprint(before: string, after: string) {
  const a = before.split("\n");
  const b = after.split("\n");
  return { added: b.filter((l) => !a.includes(l)), removed: a.filter((l) => !b.includes(l)) };
}

describe("set", () => {
  test("rewrites one value and nothing else; comments and their column survive", () => {
    const out = edit(REPO, { op: "set", key: "size_budget", value: 250 });
    expect(footprint(REPO, out)).toEqual({
      added: ["size_budget = 250                    # changed lines before a run returns to plan"],
      removed: ["size_budget = 400                    # changed lines before a run returns to plan"],
    });
    expect(values(out).size_budget).toBe(250);
  });

  test("a longer value pushes its comment out by the original gap", () => {
    const out = edit(REPO, { op: "set", key: "project", value: "A much longer project name than before" });
    expect(out).toContain('project = "A much longer project name than before"        # default project for signals filed here');
  });

  test("keeps the key's own spacing (aligned `eval  =`)", () => {
    const out = edit(REPO, { op: "set", key: "commands.eval", value: "bun x" });
    expect(out).toContain('eval  = "bun x"\n');
    expect(footprint(REPO, out).removed).toEqual(['eval  = "bun scripts/line.ts eval --base $default_branch --dir $run_dir"']);
  });

  test("string arrays, quotes and escapes round trip through the loader", () => {
    const out = edit(REPO,
      { op: "set", key: "principles", value: ["a.md", 'with "quotes" and \\ slash'] },
      { op: "set", key: "commands.check", value: "echo \"hi\"\tthere" });
    expect(values(out).principles).toEqual(["a.md", 'with "quotes" and \\ slash']);
    expect(values(out).commands?.check).toBe("echo \"hi\"\tthere");
    expect(() => edit(REPO, { op: "set", key: "team", value: "bell\u0007" })).toThrow(/control characters/);
  });

  test("an absent key is added after the table's last entry", () => {
    const out = edit(REPO, { op: "set", key: "commands.ship", value: "bun ship" }, { op: "set", key: "team", value: "Union" });
    expect(out).toContain('eval  = "bun scripts/line.ts eval --base $default_branch --dir $run_dir"\nship = "bun ship"\n');
    expect(out).toContain('watch_days = 7\nteam = "Union"\n');
    expect(footprint(REPO, out).removed).toEqual([]);
  });

  test("a missing subtable is created above the finders and their comment", () => {
    const text = REPO.replace(/\[line\.caps\]\ncards = 5 .*\n\n/, "");
    const out = edit(text, { op: "set", key: "caps.cards", value: 3 });
    expect(out).toContain("[line.caps]\ncards = 3\n\n# What this repo listens to (LP3).\n[[line.finders]]");
    expect(values(out).caps?.cards).toBe(3);
  });

  test("a value spanning lines is replaced whole", () => {
    const text = `[line]\nprinciples = [\n  "a.md", # first\n  "b.md",\n]\nwatch_days = 7\n`;
    const out = edit(text, { op: "set", key: "principles", value: ["c.md"] });
    expect(out).toBe(`[line]\nprinciples = ["c.md"]\nwatch_days = 7\n`);
  });

  test("a dotted key under [line] is edited where it is", () => {
    const text = `[line]\nproject = "P"\ncommands.check = "old"\n`;
    const out = edit(text, { op: "set", key: "commands.check", value: "new" });
    expect(out).toBe(`[line]\nproject = "P"\ncommands.check = "new"\n`);
  });

  test("a starter file's commented-out key becomes the live line and keeps its note", () => {
    const starter = starterLineProfile({ project: "P" });
    const out = edit(starter, { op: "set", key: "commands.prove", value: "bun prove" }, { op: "set", key: "team", value: "T" });
    expect(out).toMatch(/^prove = "bun prove" +# exits 0 only when the miss is shown/m);
    expect(out).toMatch(/^team = "T" +# workspace for writes from this repo/m);
    expect(out).not.toContain('# prove = "..."');
    expect(values(out).commands?.prove).toBe("bun prove");
    // The commented finder example under [line.caps] is not mistaken for anything.
    expect(out).toContain('# id = "lessons"');
  });

  test("CRLF files stay CRLF", () => {
    const out = edit("[line]\r\nwatch_days = 7\r\n", { op: "set", key: "watch_days", value: 3 });
    expect(out).toBe("[line]\r\nwatch_days = 3\r\n");
  });
});

describe("remove", () => {
  test("drops the key line, comment and all, and the value returns to its default", () => {
    const out = edit(REPO, { op: "remove", key: "caps.cards" });
    expect(footprint(REPO, out)).toEqual({ added: [], removed: ["cards = 5                            # open cards per person"] });
    const r = editLineProfile({ root: "/r", current: REPO, edits: [{ op: "remove", key: "caps.cards" }] }).resolved;
    expect(r.sources["caps.cards"]).toBe("default");
  });

  test("removing an absent key is a no-op", () => {
    expect(edit(REPO, { op: "remove", key: "team" })).toBe(REPO);
  });
});

describe("unknown keys are refused", () => {
  test("by the editor, naming the known keys", () => {
    expect(() => edit(REPO, { op: "set", key: "size_budgte", value: 1 })).toThrow(/unknown key "size_budgte" \(known: team, project,/);
    expect(() => edit(REPO, { op: "set", key: "commands.deploy", value: "x" })).toThrow(/unknown key "commands.deploy"/);
    expect(() => edit(REPO, { op: "set", key: "finders", value: "x" })).toThrow(/set_finder/);
    expect(() => edit(REPO, { op: "set_finder", finder: { id: "x", source: "s", kind: "bug", fingerprint: "f", colour: "red" } as any })).toThrow(/unknown key "colour"/);
    expect(() => edit(REPO, { op: "bogus" } as any)).toThrow(/unknown edit op/);
  });

  test("by the loader for whole-text writes, with nothing to write", () => {
    expect(() => editLineProfile({ root: "/r", current: REPO, content: `${REPO}\n[line.extra]\nx = 1\n` })).toThrow(LineProfileError);
    expect(() => editLineProfile({ root: "/r", current: REPO, content: "[line]\nwatch_days = -1\n" })).toThrow(/watch_days must be a positive integer/);
  });

  test("a value of the wrong type fails the loader with its message", () => {
    expect(() => editLineProfile({ root: "/r", current: REPO, edits: [{ op: "set", key: "size_budget", value: "big" }] }))
      .toThrow(/\/r\/\.codecast\/line\.toml: \[line\] size_budget must be a positive integer/);
  });
});

describe("finders", () => {
  const sentry = { id: "sentry", source: "sentry", kind: ["bug", "regression"], fingerprint: "sentry:<group>", runs: "a routine" };

  test("a new finder goes after the last one, before the trailing comment", () => {
    const out = edit(REPO, { op: "set_finder", finder: sentry });
    expect(out).toContain('fingerprint = "lesson:<rule>"\n\n[[line.finders]]\nid = "sentry"\nsource = "sentry"\nkind = ["bug", "regression"]\nfingerprint = "sentry:<group>"\nruns = "a routine"\n\n# Not built: Sentry.');
    expect(values(out).finders?.map((f) => f.id)).toEqual(["eval-drift", "lessons", "sentry"]);
  });

  test("updating a finder edits its block in place and drops keys it no longer sets", () => {
    const out = edit(REPO, { op: "set_finder", finder: { id: "eval-drift", source: "evals", kind: "regression", fingerprint: "evals:<surface>" } });
    expect(footprint(REPO, out)).toEqual({ added: ['kind = "regression"'], removed: ['kind = ["regression", "prompt_miss"]', 'runs = "./evals check --signal"'] });
  });

  test("the second of two finders is the one updated", () => {
    const out = edit(REPO, { op: "set_finder", finder: { id: "lessons", source: "lesson", kind: "cohesion", fingerprint: "lesson:<rule>", project: "Other" } });
    expect(out).toContain('fingerprint = "lesson:<rule>"\nproject = "Other"\n\n# Not built');
    expect(values(out).finders?.[0].project).toBeUndefined();
    expect(values(out).finders?.[1].project).toBe("Other");
  });

  test("removing a finder takes its block and leaves the comments around it", () => {
    const first = edit(REPO, { op: "remove_finder", id: "eval-drift" });
    expect(first).toContain("# What this repo listens to (LP3).\n[[line.finders]]\nid = \"lessons\"");
    expect(first).not.toContain("eval-drift");
    expect(first).not.toMatch(/\n\n\n/);
    const both = edit(first, { op: "remove_finder", id: "lessons" });
    expect(both).toContain("# What this repo listens to (LP3).\n# Not built: Sentry.");
    expect(values(both).finders).toBeUndefined();
  });

  test("removing an unknown finder is refused", () => {
    expect(() => edit(REPO, { op: "remove_finder", id: "nope" })).toThrow(/no finder with id "nope"/);
  });

  test("finders written as an inline array are refused rather than guessed at", () => {
    const text = `[line]\nfinders = [{ id = "a", source = "s", kind = "bug", fingerprint = "f" }]\n`;
    expect(() => edit(text, { op: "remove_finder", id: "a" })).toThrow(/edit the file by hand/);
  });
});

describe("empty and absent files", () => {
  test("an empty file grows a [line] table, then subtables and finders", () => {
    const out = edit("",
      { op: "set", key: "project", value: "P" },
      { op: "set", key: "commands.check", value: "make check" },
      { op: "set_finder", finder: { id: "f", source: "s", kind: "bug", fingerprint: "s:<x>" } });
    expect(out).toBe(`[line]\nproject = "P"\n\n[line.commands]\ncheck = "make check"\n\n[[line.finders]]\nid = "f"\nsource = "s"\nkind = "bug"\nfingerprint = "s:<x>"\n`);
    expect(values(out).project).toBe("P");
  });

  test("[line] is created above an existing [line.*] table and its comment", () => {
    const text = `# header\n\n# commands\n[line.commands]\ncheck = "x"\n`;
    expect(edit(text, { op: "set", key: "watch_days", value: 3 })).toBe(`# header\n\n[line]\nwatch_days = 3\n\n# commands\n[line.commands]\ncheck = "x"\n`);
  });

  test("no edits leave the text byte for byte", () => {
    expect(edit(REPO)).toBe(REPO);
    expect(editLineProfile({ root: "/r", current: REPO, edits: [] }).changed).toBe(false);
  });
});

test("codecast's own profile survives a round of edits with every comment intact", () => {
  const own = fs.readFileSync(path.join(import.meta.dir, "../../../.codecast/line.toml"), "utf8");
  const out = edit(own, { op: "set", key: "watch_days", value: 9 }, { op: "set", key: "watch_days", value: 7 });
  expect(out).toBe(own);
  const comments = (t: string) => t.split("\n").filter((l) => l.includes("#"));
  const changed = edit(own, { op: "set", key: "caps.cards", value: 6 });
  expect(comments(changed).length).toBe(comments(own).length);
});

describe("runLineProfileEdit", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "line-edit-"));
  const deps = (opts: { admit?: boolean } = {}) => {
    const calls = { writes: [] as Array<[string, string]>, publishes: [] as string[] };
    return {
      calls,
      deps: {
        admit: async (file: string) => (opts.admit === false ? null : file),
        write: (file: string, content: string) => { calls.writes.push([file, content]); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); },
        publish: async (root: string) => { calls.publishes.push(root); return { ok: true }; },
      },
    };
  };

  test("creates the file when absent, writes, republishes and answers the resolved profile", async () => {
    const root = tmp();
    const { calls, deps: d } = deps();
    const reply = await runLineProfileEdit({ root, edits: [{ op: "set", key: "project", value: "P" }] }, d);
    expect(reply.content).toBe('[line]\nproject = "P"\n');
    expect(reply.profile.project).toBe("P");
    expect(reply.sources.project).toBe("file");
    expect(reply.sources.team).toBe("default");
    expect(calls.writes.map(([f]) => f)).toEqual([path.join(root, ".codecast/line.toml")]);
    expect(calls.publishes).toEqual([path.resolve(root)]);
    expect(reply.published).toEqual({ ok: true });
  });

  test("an invalid result writes nothing and publishes nothing", async () => {
    const root = tmp();
    const { calls, deps: d } = deps();
    await expect(runLineProfileEdit({ root, edits: [{ op: "set", key: "caps.cards", value: 0 }] }, d)).rejects.toThrow(/cards must be a positive integer/);
    await expect(runLineProfileEdit({ root, content: "[line]\nwatch_days = \n" }, d)).rejects.toThrow(/invalid TOML/);
    expect(calls).toEqual({ writes: [], publishes: [] });
  });

  test("an unchanged result neither writes nor publishes", async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, ".codecast"));
    fs.writeFileSync(path.join(root, ".codecast/line.toml"), REPO);
    const { calls, deps: d } = deps();
    const reply = await runLineProfileEdit({ root, edits: [{ op: "remove", key: "team" }] }, d);
    expect(reply.changed).toBe(false);
    expect(reply.content).toBe(REPO);
    expect(calls).toEqual({ writes: [], publishes: [] });
  });

  test("a path outside the fence is refused before anything is read", async () => {
    const { calls, deps: d } = deps({ admit: false });
    await expect(runLineProfileEdit({ root: tmp(), edits: [] }, d)).rejects.toThrow(/not a line profile in a project this machine tracks/);
    expect(calls.writes).toEqual([]);
  });

  test("a whole-text write against a stale base is refused", async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, ".codecast"));
    fs.writeFileSync(path.join(root, ".codecast/line.toml"), REPO);
    const { calls, deps: d } = deps();
    await expect(runLineProfileEdit({ root, content: "[line]\n", base: "old text" }, d)).rejects.toThrow(/changed since it was read/);
    const ok = await runLineProfileEdit({ root, content: "[line]\nwatch_days = 2\n", base: REPO }, d);
    expect(ok.profile.watch_days).toBe(2);
    expect(calls.writes.length).toBe(1);
  });

  test("bad arguments are refused", async () => {
    const { deps: d } = deps();
    await expect(runLineProfileEdit({ root: "" } as any, d)).rejects.toThrow(/needs a root/);
    await expect(runLineProfileEdit({ root: tmp() } as any, d)).rejects.toThrow(/needs edits or content/);
  });
});
