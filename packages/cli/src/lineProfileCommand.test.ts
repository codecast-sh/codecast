import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runEvalResult } from "./lineProfileCommand";

// `cast line eval-result` on reps.json in the shape Union's eval writes
// (outreach/backend/src/lib/eval/lineEval.ts RepsFile): the station's exit
// code is the result's verdict, and an unreadable file is never a pass.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-result-"));
afterEach(() => { for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f)); });

const rep = (passed: boolean) => ({ passed, score: passed ? 0.9 : 0.1, reply: passed ? "Thursday at 7, Barn Hall." : "I am not sure.", judge_note: passed ? "names the venue" : "no venue", cost_usd: 0.02 });
const unionReps = (branchPasses: boolean, gates: string[] = []) => ({
  version: 1,
  base: { ref: "main", sha: "aaa" },
  head: { sha: "bbb", dirty: false },
  created_at: "2026-10-03T10:00:00Z",
  dry: false,
  reps: 5,
  surfaces: [{
    surface: "outreach.reply",
    title: "Reply drafter",
    route: "api_call",
    freezes: [{
      freeze: "fz_miss_1", name: "venue question", kind: "miss", proven: true, input: "where is it?",
      base: { batch: "run_base", sha: "aaa", reps: Array.from({ length: 5 }, () => rep(false)), input: "where is it?" },
      branch: { batch: "run_branch", sha: "bbb", reps: Array.from({ length: 5 }, () => rep(branchPasses)) },
    }],
  }, { surface: "outreach.digest", title: "Digest", route: null, freezes: [], skipped: "no freeze exercises this prompt yet; prove makes them from its moments" }],
  gates_failed: gates,
  gate: gates.length ? { select: "core,venue", run_id: "er_1", exit: 1, failed: gates, note: "1 of 40 failed" } : null,
  cost_usd: 0.2,
});

function write(name: string, body: unknown): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
}

describe("cast line eval-result", () => {
  test("a proven miss fixed on the branch passes: exit 0, and the card's file is written", () => {
    const out = path.join(dir, "eval-result.json");
    const run = runEvalResult(write("reps.json", unionReps(true)), out);
    expect(run.code).toBe(0);
    const written = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(written).toMatchObject({ version: 1, ok: true, costUsd: 0.2, base: { sha: "aaa" } });
    expect(written.surfaces[0]).toMatchObject({ separation: "better", proven: [{ freeze: "fz_miss_1", basePasses: false, passes: true }] });
    expect(written.surfaces[0].flips[0]).toMatchObject({ direction: "fixed", after: "Thursday at 7, Barn Hall.", note: "names the venue" });
    expect(written.surfaces[1].skipped).toContain("no freeze");
  });

  test("the miss still failing, or a suite gate failing, exits 1", () => {
    expect(runEvalResult(write("reps.json", unionReps(false)), path.join(dir, "r.json")).code).toBe(1);
    const gated = runEvalResult(write("reps.json", unionReps(true, ["core/venue"])), path.join(dir, "r.json"));
    expect(gated.code).toBe(1);
    expect(gated.lines.at(-1)).toBe("FAIL suite gates failed: core/venue");
  });

  test("a side with no scored rep exits 2: the eval could not judge the change", () => {
    const reps = unionReps(true);
    reps.surfaces[0].freezes[0].branch.reps = reps.surfaces[0].freezes[0].branch.reps.map((r: any) => ({ ...r, passed: false, error: "API error 429" }));
    const run = runEvalResult(write("reps.json", reps), path.join(dir, "r.json"));
    expect(run.code).toBe(2);
    expect(run.lines.join("\n")).toContain("proven freeze fz_miss_ was not scored on the branch");
  });

  test("an unreadable or malformed reps file is an error, never a result", () => {
    expect(() => runEvalResult(path.join(dir, "missing.json"), path.join(dir, "r.json"))).toThrow(/cannot read/);
    expect(() => runEvalResult(write("bad.json", "{not json"), path.join(dir, "r.json"))).toThrow(/cannot read/);
    expect(() => runEvalResult(write("old.json", { ...unionReps(true), version: 0 }), path.join(dir, "r.json"))).toThrow(/version must be 1/);
    expect(fs.existsSync(path.join(dir, "r.json"))).toBe(false);
  });
});

// `cast line profile --publish` on Union's profile: one group per project the
// finders file into, the profile's default project marked, and a finder
// without a project goes to the default.
describe("publishGroups", () => {
  test("groups Union's finders by project", async () => {
    const { parseLineProfileText, resolveLineProfile } = await import("./lineProfile");
    const { publishGroups } = await import("./lineProfileCommand");
    const toml = `
[line]
project = "Agent Quality"
[[line.finders]]
id = "clusters"
source = "agentwatch"
kind = "prompt_miss or bug"
fingerprint = "union:cluster:<id>"
project = "Agent Quality"
[[line.finders]]
id = "invariants"
source = "union.invariant"
kind = "regression"
fingerprint = "union:invariant:<id>"
[[line.finders]]
id = "errors"
source = "union.error"
kind = "bug or regression"
fingerprint = "union:error:<fingerprint>"
runs = "daily"
project = "Infrastructure"
`;
    const { values, warnings } = parseLineProfileText(toml);
    const { groups, unprojected } = publishGroups(resolveLineProfile(values, { warnings }));
    expect(unprojected).toEqual([]);
    expect(groups.map((g) => [g.project, g.default, g.finders.map((f) => f.id)])).toEqual([
      ["Agent Quality", true, ["clusters", "invariants"]],
      ["Infrastructure", false, ["errors"]],
    ]);
    expect(groups[1].finders[0]).toEqual({ id: "errors", source: "union.error", kind: ["bug", "regression"], fingerprint: "union:error:<fingerprint>", runs: "daily" });
  });

  test("a finder with no project anywhere is held back", async () => {
    const { parseLineProfileText, resolveLineProfile } = await import("./lineProfile");
    const { publishGroups } = await import("./lineProfileCommand");
    const { values } = parseLineProfileText(`[[line.finders]]\nid = "p"\nsource = "person"\nkind = "any"\nfingerprint = "x"\n`.replace(/^/, "[line]\n"));
    expect(publishGroups(resolveLineProfile(values))).toEqual({ groups: [], unprojected: ["p"] });
  });
});
