// A fanout's branches converge on its fanin (ct-98549): a failed branch goes on to the fanin, which routes on it;
// the fanin reads a verdict written during the fanout; everything the branches found is one stop for one brief;
// and a branch's keys from an earlier round do not outlive it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseWorkflowSource } from "./parser.js";
import { runWorkflow } from "./runner.js";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";

isolateCodecastDirEachTest();

let dir = "";
let origFetch: typeof fetch;
let origLog: typeof console.log;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fanout-")));
  origFetch = globalThis.fetch;
  origLog = console.log;
  console.log = () => {};
});
afterEach(() => {
  globalThis.fetch = origFetch;
  console.log = origLog;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The task as the server holds it: Review's verdict is the one it wrote in round 1 (the file `review1`), never again. */
function taskServer() {
  globalThis.fetch = (async (url: any) => {
    const route = String(url).replace(/^https?:\/\/[^/]+/, "");
    const reviewed = path.join(dir, "review1");
    if (route === "/cli/work/get") {
      return new Response(JSON.stringify({
        title: "Make it good",
        status: "in_progress",
        ...(fs.existsSync(reviewed) ? { review_verdict: { verdict: "changes", note: "rename x to width", at: fs.statSync(reviewed).mtimeMs } } : {}),
      }));
    }
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;
}
const options = () => ({ cwd: dir, taskId: "ct-9", apiToken: "tok", convexSiteUrl: "https://convex.test" });
const briefs = () => fs.readdirSync(dir).filter((f) => f.startsWith("brief-")).sort().map((f) => fs.readFileSync(path.join(dir, f), "utf-8"));

describe("a fanout goes on to its fanin", () => {
  test("CI fails and Review asks for changes in round 1: one brief holds both; round 2 reads neither and ends", async () => {
    taskServer();
    const graph = parseWorkflowSource(`digraph loop {
      graph [label="Loop"]
      start [shape=Mdiamond]
      split [shape=component]
      ci [label="CI", shape=parallelogram, script="if [ -f ${dir}/round2 ]; then echo ci ok; else echo 'error: lint failed in a.ts'; exit 1; fi"]
      review [label="Review", shape=parallelogram, script="[ -f ${dir}/round2 ] || { sleep 0.05; touch ${dir}/review1; }; echo reviewed"]
      join [label="CI and Review", shape=tripleoctagon]
      fix [label="Fix", shape=parallelogram, max_visits=2, script="n=$(ls ${dir} | grep -c brief-); printf '%s' \\"$stop_reason\\" > ${dir}/brief-$n; touch ${dir}/round2"]
      exit [shape=Msquare]
      start -> split
      split -> ci
      split -> review
      ci -> join
      review -> join
      join -> fix [condition="outcome = failure or review_verdict = changes"]
      join -> exit [condition="outcome = success"]
      fix -> split
    }`, dir);
    expect(await runWorkflow(graph, options())).toBe("completed");
    const [brief, ...more] = briefs();
    expect(more).toEqual([]);
    expect(brief).toContain("## CI");
    expect(brief).toContain("error: lint failed in a.ts");
    expect(brief).toContain("## Review asked for changes");
    expect(brief).toContain("rename x to width");
  }, 60_000);

  test("a branch's json from round 1 does not route round 2 (jx7389x)", async () => {
    taskServer();
    const graph = parseWorkflowSource(`digraph loop {
      graph [label="Loop"]
      start [shape=Mdiamond]
      split [shape=component]
      ci [label="CI", shape=parallelogram, script="echo ci ok"]
      review [label="Review", shape=parallelogram, script="if [ -f ${dir}/round2 ]; then echo 'looks fine'; else echo '{\\"verdict\\": \\"changes\\"}'; fi"]
      join [label="CI and Review", shape=tripleoctagon]
      fix [label="Fix", shape=parallelogram, max_visits=2, script="n=$(ls ${dir} | grep -c brief-); echo fixed > ${dir}/brief-$n; touch ${dir}/round2"]
      exit [shape=Msquare]
      start -> split
      split -> ci
      split -> review
      ci -> join
      review -> join
      join -> fix [condition="review.json.verdict = changes"]
      join -> exit [condition="outcome = success"]
      fix -> split
    }`, dir);
    expect(await runWorkflow(graph, options())).toBe("completed");
    expect(briefs()).toHaveLength(1);
  }, 60_000);

  test("a review branch that died routes to the fanin's No review edge", async () => {
    taskServer();
    const graph = parseWorkflowSource(`digraph dead {
      graph [label="Dead"]
      start [shape=Mdiamond]
      split [shape=component]
      ci [label="CI", shape=parallelogram, script="echo ci ok"]
      review [label="Review", shape=parallelogram, timeout=1, script="sleep 5"]
      join [label="CI and Review", shape=tripleoctagon]
      no_review [label="No review", shape=parallelogram, script="touch ${dir}/no-review"]
      exit [shape=Msquare]
      start -> split
      split -> ci
      split -> review
      ci -> join
      review -> join
      join -> no_review [label="No review", condition="outcome = failure"]
      join -> exit [condition="outcome = success"]
      no_review -> exit
    }`, dir);
    expect(await runWorkflow(graph, options())).toBe("completed");
    expect(fs.existsSync(path.join(dir, "no-review"))).toBe(true);
  }, 60_000);
});
