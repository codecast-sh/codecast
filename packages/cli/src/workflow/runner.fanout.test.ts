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

  test("a failed branch never takes a loop's edge on another branch's json: the run stops (flowImport's rounds)", async () => {
    taskServer();
    const graph = parseWorkflowSource(`digraph rounds {
      graph [label="Rounds"]
      start [shape=Mdiamond]
      split [shape=component]
      a [label="A", shape=parallelogram, script="echo 'error: a broke'; exit 1"]
      b [label="B", shape=parallelogram, script="echo '{\\"again\\": false}'"]
      join [label="Join", shape=tripleoctagon]
      ship [label="Ship", shape=parallelogram, script="touch ${dir}/shipped"]
      exit [shape=Msquare]
      start -> split
      split -> a
      split -> b
      a -> join
      b -> join
      join -> split [condition="b.json.again = true", label="another round"]
      join -> ship [condition="b.json.again != true", label="rounds done"]
      ship -> exit
    }`, dir);
    expect(await runWorkflow(graph, options())).toBe("failed");
    expect(fs.existsSync(path.join(dir, "shipped"))).toBe(false);
  }, 60_000);

  test("a review that passes never ships a red CI: the run takes the fanout's retry_target", async () => {
    taskServer();
    const graph = parseWorkflowSource(`digraph pass {
      graph [label="Pass"]
      start [shape=Mdiamond]
      split [shape=component, retry_target=fix]
      ci [label="CI", shape=parallelogram, script="if [ -f ${dir}/round2 ]; then echo ci ok; else echo 'error: lint failed in a.ts'; exit 1; fi"]
      review [label="Review", shape=parallelogram, script="echo '{\\"verdict\\": \\"pass\\"}'"]
      join [label="CI and Review", shape=tripleoctagon]
      fix [label="Fix", shape=parallelogram, max_visits=2, script="touch ${dir}/round2"]
      ship [label="Ship", shape=parallelogram, script="if [ -f ${dir}/round2 ]; then touch ${dir}/shipped-green; else touch ${dir}/shipped-red; fi"]
      exit [shape=Msquare]
      start -> split
      split -> ci
      split -> review
      ci -> join
      review -> join
      join -> ship [condition="review.json.verdict = pass"]
      join -> fix [condition="review.json.verdict = changes"]
      fix -> split
      ship -> exit
    }`, dir);
    expect(await runWorkflow(graph, options())).toBe("completed");
    expect(fs.existsSync(path.join(dir, "shipped-red"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "shipped-green"))).toBe(true);
  }, 60_000);

  test("a branch the fanout retries on its own reaches the fanin as itself: the spent failure does not loop it", async () => {
    taskServer();
    const graph = parseWorkflowSource(`digraph again {
      graph [label="Again"]
      start [shape=Mdiamond]
      split [shape=component, retry_target=review]
      ci [label="CI", shape=parallelogram, script="echo ci ok"]
      review [label="Review", shape=parallelogram, max_visits=3, script="echo r >> ${dir}/reviews; [ -f ${dir}/died ] || { touch ${dir}/died; exit 1; }"]
      join [label="Both done", shape=tripleoctagon]
      gone [shape=Msquare, label="Review never finished", stop="review never finished"]
      ship [label="Ship", shape=parallelogram, script="touch ${dir}/shipped"]
      exit [shape=Msquare]
      start -> split
      split -> ci
      split -> review
      ci -> join [condition="outcome = success"]
      review -> join [condition="outcome = success"]
      review -> gone [condition="outcome = failure"]
      join -> ship
      ship -> exit
    }`, dir);
    expect(await runWorkflow(graph, options())).toBe("completed");
    expect(fs.readFileSync(path.join(dir, "reviews"), "utf-8")).toBe("r\nr\n");
    expect(fs.existsSync(path.join(dir, "shipped"))).toBe(true);
  }, 60_000);

  test("a fanout's retry_target is not taken for another branch's failure: CI red and the review fine ends failed", async () => {
    taskServer();
    const graph = parseWorkflowSource(`digraph red {
      graph [label="Red"]
      start [shape=Mdiamond]
      split [shape=component, retry_target=review]
      ci [label="CI", shape=parallelogram, script="echo 'error: lint failed'; exit 1"]
      review [label="Review", shape=parallelogram, max_visits=3, script="echo r >> ${dir}/reviewed"]
      join [label="Both done", shape=tripleoctagon]
      ship [label="Ship", shape=parallelogram, script="touch ${dir}/shipped"]
      exit [shape=Msquare]
      start -> split
      split -> ci
      split -> review
      ci -> join [condition="outcome = success"]
      review -> join [condition="outcome = success"]
      join -> ship
      ship -> exit
    }`, dir);
    // The retry runs only the review, which cannot fix CI: it is not taken, and the run ends failed at once.
    expect(await runWorkflow(graph, options())).toBe("failed");
    expect(fs.existsSync(path.join(dir, "shipped"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "reviewed"), "utf-8")).toBe("r\n");
  }, 60_000);

  test("both branches failing: retrying one leaves the other's failure, so the run does not ship", async () => {
    taskServer();
    const graph = parseWorkflowSource(`digraph both {
      graph [label="Both"]
      start [shape=Mdiamond]
      split [shape=component, retry_target=review]
      ci [label="CI", shape=parallelogram, script="echo 'error: lint failed'; exit 1"]
      review [label="Review", shape=parallelogram, max_visits=3, script="echo r >> ${dir}/reviews; [ -f ${dir}/died ] || { touch ${dir}/died; exit 1; }"]
      join [label="Both done", shape=tripleoctagon]
      ship [label="Ship", shape=parallelogram, script="touch ${dir}/shipped"]
      exit [shape=Msquare]
      start -> split
      split -> ci
      split -> review
      ci -> join [condition="outcome = success"]
      review -> join [condition="outcome = success"]
      join -> ship
      ship -> exit
    }`, dir);
    expect(await runWorkflow(graph, options())).toBe("failed");
    expect(fs.existsSync(path.join(dir, "shipped"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "reviews"), "utf-8")).toBe("r\n");
  }, 60_000);

  test("a round that finds nothing leaves no stop: the station after reads none of the last round's", async () => {
    taskServer();
    const graph = parseWorkflowSource(`digraph stale {
      graph [label="Stale"]
      start [shape=Mdiamond]
      split [shape=component]
      ci [label="CI", shape=parallelogram, script="if [ -f ${dir}/round2 ]; then echo ci ok; else echo 'error: lint failed in a.ts'; exit 1; fi"]
      review [label="Review", shape=parallelogram, script="echo reviewed"]
      join [label="CI and Review", shape=tripleoctagon]
      fix [label="Fix", shape=parallelogram, max_visits=2, script="touch ${dir}/round2"]
      report [label="Report", shape=parallelogram, script="printf '%s' \\"$stop_reason\\" > ${dir}/report"]
      exit [shape=Msquare]
      start -> split
      split -> ci
      split -> review
      ci -> join
      review -> join
      join -> fix [condition="outcome = failure"]
      join -> report [condition="outcome = success"]
      fix -> split
      report -> exit
    }`, dir);
    expect(await runWorkflow(graph, options())).toBe("completed");
    expect(fs.readFileSync(path.join(dir, "report"), "utf-8")).not.toContain("lint failed");
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

  test("a branch whose edge has a condition runs only in the rounds it holds, and keeps what it last said", async () => {
    taskServer();
    // Round 1 reviews; later rounds (once Next has run) pass Review over, and Next still reads its last word.
    const graph = parseWorkflowSource(`digraph gated {
      graph [label="Gated"]
      start [shape=Mdiamond]
      mark [label="Mark", shape=parallelogram, script="if [ -f ${dir}/round2 ]; then echo '{\\"again\\": true}'; else echo '{\\"again\\": false}'; fi"]
      split [shape=component]
      ci [label="CI", shape=parallelogram, script="echo ci >> ${dir}/ran"]
      review [label="Review", shape=parallelogram, script="echo review >> ${dir}/ran; echo '{\\"verdict\\": \\"ship\\"}'"]
      join [label="CI and Review", shape=tripleoctagon]
      next [label="Next", shape=parallelogram, script="echo $review.json.verdict >> ${dir}/said; touch ${dir}/round2"]
      exit [shape=Msquare]
      start -> mark
      mark -> split
      split -> ci
      split -> review [condition="mark.json.again != true"]
      ci -> join
      review -> join
      join -> exit [condition="next.visits >= 2"]
      join -> next
      next -> mark
    }`, dir);
    expect(await runWorkflow(graph, options())).toBe("completed");
    expect(fs.readFileSync(path.join(dir, "ran"), "utf-8").trim().split("\n").sort()).toEqual(["ci", "ci", "ci", "review"]);
    expect(fs.readFileSync(path.join(dir, "said"), "utf-8").trim().split("\n")).toEqual(["ship", "ship"]);
  }, 60_000);
});
