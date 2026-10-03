import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODECAST_PROMPTING,
  findLineProfile,
  formatLineProfile,
  lineCommandEnv,
  lineProfileVars,
  loadLineProfile,
  parseLineProfileText,
  resolveLineProfile,
} from "./lineProfile";

const LP2_EXAMPLE = `
[line]
team = "Union"
project = "Agent Quality"
principles = ["outreach/docs/line/principles.md"]
prompting = "outreach/docs/line/prompting.md"
size_budget = 400
watch_days = 7

[line.commands]
check = "cast check && cd outreach/backend && bun run test:touched"
prove = "bun outreach/backend/scripts/line.ts prove --task $task_id --dir $run_dir"
eval  = "bun outreach/backend/scripts/line.ts eval --base $default_branch --dir $run_dir --out $run_dir/reps.json"
ship  = "bun outreach/backend/scripts/line.ts ship --task $task_id --branch $branch"

[line.caps]
cards = 5

[[line.finders]]
id = "invariants"
source = "union.invariant"
kind = "regression"
fingerprint = "union:invariant:<id>"
runs = "backend job captureInvariantSnapshots"
project = "Infrastructure"
`;

function tmpRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "line-profile-"));
  fs.mkdirSync(path.join(dir, ".git"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

describe("line profile (LP2)", () => {
  test("the LP2 example loads as written, every value from the file", () => {
    const { values, warnings } = parseLineProfileText(LP2_EXAMPLE);
    const r = resolveLineProfile(values, { warnings });
    expect(warnings).toEqual([]);
    expect(r.profile).toMatchObject({
      team: "Union",
      project: "Agent Quality",
      principles: ["outreach/docs/line/principles.md"],
      size_budget: 400,
      caps: { cards: 5 },
      finders: [{ id: "invariants", kind: ["regression"], project: "Infrastructure", runs: "backend job captureInvariantSnapshots" }],
    });
    expect(r.profile.commands.eval).toContain("reps.json");
    expect(Object.values(r.sources).every((s) => s === "file")).toBe(true);
  });

  test("no file: the defaults, each marked default, and the stations that pass with a note say so", () => {
    const r = resolveLineProfile({});
    expect(r.profile).toEqual({
      team: null,
      project: null,
      principles: [],
      prompting: CODECAST_PROMPTING,
      size_budget: 400,
      watch_days: 7,
      commands: { check: "cast ws check", prove: null, eval: null, ship: null },
      caps: { cards: 5 },
      finders: [],
    });
    expect(Object.values(r.sources).every((s) => s === "default")).toBe(true);
    expect(r.notes.join("\n")).toContain("the prove station passes with a note");
    expect(r.notes.join("\n")).toContain("the eval station passes with a note");
  });

  test("a partial file keeps the defaults it does not set", () => {
    const r = resolveLineProfile(parseLineProfileText(`[line]\nproject = "X"\n[line.commands]\neval = "./evals line"\n`).values);
    expect(r.profile.commands).toEqual({ check: "cast ws check", prove: null, eval: "./evals line", ship: null });
    expect(r.sources["commands.eval"]).toBe("file");
    expect(r.sources["commands.check"]).toBe("default");
    expect(r.sources.project).toBe("file");
  });

  test("unknown keys are refused with where they are", () => {
    const err = (t: string) => { try { parseLineProfileText(t, ".codecast/line.toml"); } catch (e) { return e as Error; } return null; };
    expect(err(`[line]\nprojet = "X"`)?.message).toBe('.codecast/line.toml: [line] has unknown key "projet" (known: team, project, principles, prompting, size_budget, watch_days, commands, caps, finders)');
    expect(err(`[line.commands]\nverify = "x"`)?.message).toContain('[line.commands] has unknown key "verify"');
    expect(err(`[line.caps]\nhands = 3`)?.message).toContain('[line.caps] has unknown key "hands"');
    expect(err(`[[line.finders]]\nid = "a"\nsource = "s"\nkind = "bug"\nfingerprint = "f"\nowner = "x"`)?.message).toContain('[[line.finders]] #1 has unknown key "owner"');
    expect(err(`[verify]\ncommand = "x"`)?.message).toContain('the file has unknown key "verify"');
    expect(err(`[line]\nsize_budget = "big"`)?.message).toContain("[line] size_budget must be a positive integer");
    expect(err(`[[line.finders]]\nid = "a"\nsource = "s"\nkind = "crash"\nfingerprint = "f"`)?.message).toContain('names unknown kind "crash"');
    expect(err(`[[line.finders]]\nid = "a"\nsource = "s"\nkind = "bug"\nfingerprint = "f"\n[[line.finders]]\nid = "a"\nsource = "t"\nkind = "bug"\nfingerprint = "g"`)?.message).toContain('repeats id "a"');
    expect(err(`[line]\nteam = = 1`)?.message).toContain("invalid TOML");
  });

  test("kind is one value, a list, or any; a sentence is read as its list with a warning", () => {
    const parse = (kind: string) => parseLineProfileText(`[[line.finders]]\nid = "a"\nsource = "s"\nkind = ${kind}\nfingerprint = "f"`);
    expect(parse(`"bug"`).values.finders![0].kind).toEqual(["bug"]);
    expect(parse(`["prompt_miss", "bug"]`).values.finders![0].kind).toEqual(["prompt_miss", "bug"]);
    expect(parse(`"any"`).values.finders![0].kind).toBe("any");
    const sentence = parse(`"prompt_miss, bug or request"`);
    expect(sentence.values.finders![0].kind).toEqual(["prompt_miss", "bug", "request"]);
    expect(sentence.warnings).toEqual(['[[line.finders]] "a" kind = "prompt_miss, bug or request" is a sentence; write the list: kind = ["prompt_miss", "bug", "request"]']);
  });

  test("the loader walks up from a subdirectory to the profile, and stops at the repository root", () => {
    const repo = tmpRepo({ ".codecast/line.toml": `[line]\nproject = "Agent Quality"\n`, "outreach/backend/x.ts": "" });
    const r = loadLineProfile(path.join(repo, "outreach", "backend"));
    expect(r.file).toBe(path.join(repo, ".codecast/line.toml"));
    expect(r.root).toBe(repo);
    expect(r.profile.project).toBe("Agent Quality");
    const bare = tmpRepo({ "src/a.ts": "" });
    expect(findLineProfile(path.join(bare, "src"))).toEqual({ file: null, root: bare });
    expect(loadLineProfile(bare).profile.commands.check).toBe("cast ws check");
  });

  test("Union's committed profile loads, and only its sentence kinds warn", () => {
    const union = path.join(os.homedir(), "src/union-mobile/.codecast/worktrees/line-union/.codecast/line.toml");
    if (!fs.existsSync(union)) return;
    const r = loadLineProfile(path.dirname(path.dirname(union)));
    expect(r.profile.team).toBe("Union");
    expect(r.profile.finders.length).toBeGreaterThan(5);
    expect(r.profile.finders.find((f) => f.id === "people")?.kind).toBe("any");
    expect(r.warnings.every((w) => w.includes("is a sentence"))).toBe(true);
    expect(formatLineProfile(r)).toContain("commands.eval");
  });

  test("vars flatten the profile for the runner", () => {
    const vars = lineProfileVars(resolveLineProfile(parseLineProfileText(LP2_EXAMPLE).values).profile);
    expect(vars["line.commands.check"]).toContain("test:touched");
    expect(vars["line.size_budget"]).toBe("400");
    expect(vars["line.principles"]).toBe("outreach/docs/line/principles.md");
    const empty = lineProfileVars(resolveLineProfile({}).profile);
    expect(empty["line.commands.prove"]).toBe("");
    expect(empty["line.principles"]).toBe("none");
    expect(empty["line.commands.check"]).toBe("cast ws check");
  });

  test("a station's command env carries the run values a profile command names, and nothing else", () => {
    expect(lineCommandEnv({ task_id: "ct-1", run_dir: "/r", task_title: "x", "red.json": "{}" })).toEqual({ task_id: "ct-1", run_dir: "/r" });
  });
});
