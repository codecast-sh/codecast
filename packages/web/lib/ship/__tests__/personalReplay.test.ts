import { describe, expect, test } from "bun:test";
import { journeyOf } from "../journey";
import { journeyWhy, journeyWords, sentBackWords, stageNote, wholeWhy } from "../journeyWords";
import { stationRun } from "../../line/stationRun";
import { appPool, flowBySlug, pushedFlow } from "../../line/flowPool";
import { journeyStages } from "../journey";
import { PERSONAL_FLOW } from "../journeyFixtures";
import { flowDiagram, runReached, stepStates } from "../../line/flowDiagram";
import { runOutcome, runPath } from "../../line/runReport";
import { landingOf, readsAsPath } from "../../line/personalReport";
import { roundsOnOwnResults } from "../ownRound";
import { buildLineModel } from "../../line/lineModel";
import { causeHistory } from "../../line/causeHistory";
import { graphKeyOf } from "../../line/lineGraphs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { workflowNodeValidator } from "@codecast/convex/convex/lib/workflowGraphValidators";
import { runNodeRows } from "../../workflowRun";
import { at, end, replay, scenarios, stoppedAt, type ReplayedRun } from "./replayReports";
import { resumeOf, resumeRefusal, resumeWords } from "../resumeAt";

// The personal Ship as a person's screen draws it while it runs: every run here is the real runner's progress reports
// (cli personalFlow.e2e.test.ts, recorded into personalReports.json) merged as the server merges them (replayReports.ts),
// never hand-made node states. A fan-out's script branch (Check) is reported only when it ends; Review's report is its
// pinned JSON; Verdicts prints a line.
const personal = flowBySlug(appPool(), "personal") as any;
const diagram = flowDiagram(personal);
const journey = (run: ReplayedRun) => journeyOf(personal, run as any);
const states = (run: ReplayedRun) => journey(run).stages.map((s) => `${s.label}:${s.state}`);
const branches = (run: ReplayedRun) => journey(run).stages[0].branches!.map((b) => `${b.label}:${b.state}`);
const drawn = (run: ReplayedRun, ...ids: string[]) => { const ss = stepStates(diagram, run as any); return ids.map((id) => `${id}:${ss.get(id) ?? "idle"}`); };
const said = (run: ReplayedRun, stage: number, id: string) => journey(run).stages[stage].steps!.find((s) => s.id === id)?.said ?? null;

const PASS = replay("a passing check and a ship verdict land on origin's main");
const RED = replay("a red check goes back to the session as one brief");
const DEPLOY_FIX = replay("a failed deploy goes back to the session to fix the script");
const REJECTED = replay("a rejection ends the run at Rejected");
const UNVERIFIED = replay("the rest end Deployed, unverified or Landed (run 1)");
/** The graph as the run page reads it (useRunWorkflow): the workflows row, whose nodes keep only what the stored node
 *  shape holds (no fold, stop, machine), and the source it was pushed from. */
const STORED_KEYS = Object.keys((workflowNodeValidator as any).fields);
const storedRow = {
  slug: "personal", name: "personal",
  source: readFileSync(new URL("../../../../cli/src/workflow/templates/personal.cast", import.meta.url), "utf8"),
  nodes: personal.nodes.map((n: any) => Object.fromEntries(Object.entries(n).filter(([k]) => STORED_KEYS.includes(k)))),
  edges: personal.edges.map((e: any) => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}), ...(e.condition ? { condition: e.condition } : {}) })),
};

describe("the personal journey, as its reports arrive", () => {
  test("Check runs until it reports, beside a Review that finished; the round is in at the join; Land lands; Deploy deploys", () => {
    expect(branches(at(PASS, { node: "review", status: "completed" }))).toEqual(["Check:active", "Review:done"]);
    expect(journeyWords(journey(at(PASS, { node: "round", status: "running" })))).toEqual({ words: "In check and review", tone: "agent" });
    expect(states(at(PASS, { node: "joined", status: "running" }))[0]).toBe("Check + Review:active");
    expect(states(at(PASS, { node: "verdicts", status: "running" }))[0]).toBe("Check + Review:active");
    const landing = at(PASS, { node: "land", status: "running" });
    expect([states(landing), journeyWords(journey(landing)).words]).toEqual([["Check + Review:done", "Land:active", "Deploy:idle", "Live:idle"], "Landing"]);
    const deploying = journey(at(PASS, { node: "deploy", status: "running" }));
    expect([deploying.stages[2].state, deploying.stages[2].who, deploying.now.kind]).toEqual(["active", "agent", "deploying"]);
    const live = end(PASS);
    expect([states(live), journeyWords(journey(live)).words]).toEqual([["Check + Review:done", "Land:done", "Deploy:done", "Live:done"], "Live"]);
    // The detail says what each step found: Review's pin as its verdict, Round's and Landed's bookkeeping as nothing.
    expect([said(live, 0, "review"), said(live, 0, "round"), said(live, 1, "landed")]).toEqual(["Ship", null, null]);
  });

  test("a red Check waits for the round before the stage goes back; round 2 never shows round 1's red Check as this round's", () => {
    const red = at(RED, { node: "check", status: "completed" });
    // Red, it stopped this round's Check: it goes back to the session once Verdicts sends it there.
    expect([states(red)[0], branches(red)]).toEqual(["Check + Review:active", ["Check:stopped", "Review:done"]]);
    expect(journey(red).stages[0].branches![0].note).toBe("./check.sh exited 1 (README.md:3)");
    expect(journey(red).stages[0].steps!.find((x) => x.id === "check")!.status).toBe("failed");
    const brief = at(RED, { node: "brief", status: "running" });
    expect([states(brief)[0], journeyWords(journey(brief)).words]).toEqual(["Check + Review:back", "Fixing"]);
    const round2 = at(RED, { node: "round", status: "running" }, 1);
    expect([branches(round2), journey(round2).stages[0].branches!.map((b) => b.note ?? null)]).toEqual([["Check:idle", "Review:idle"], [null, null]]);
    // In the fan-out again, Check's last report is round 1's: it runs now.
    expect(branches(at(RED, { node: "review", status: "completed" }, 1))).toEqual(["Check:active", "Review:done"]);
    expect((journey(at(RED, { node: "review", status: "completed" }, 1)).now as any).waits.map((w: any) => w.on)).toEqual(["Check"]);
    expect(branches(at(RED, { node: "check", status: "completed" }, 1))).toEqual(["Check:done", "Review:done"]);
    expect(states(end(RED))).toEqual(["Check + Review:done", "Land:done", "Deploy:done", "Live:done"]);
  });

  test("a rejection is the end it is: never sent back, and its findings whole", () => {
    expect([states(at(REJECTED, { node: "review", status: "completed" }))[0], branches(at(REJECTED, { node: "review", status: "completed" }))]).toEqual(["Check + Review:active", ["Check:active", "Review:stopped"]]);
    const j = journey(end(REJECTED));
    expect(j.stages[0].state).toBe("stopped");
    expect(j.now).toMatchObject({ kind: "stopped", end: "Rejected", why: "The reviewer rejected the change: blocker a.txt:1 the task should not be done at all" });
    expect(journeyWords(j).words).toBe("Stopped: rejected");
    expect(said(end(REJECTED), 0, "review")).toBe("Rejected · 1 finding");
  });

  test("while the session fixes the deploy it is back with it; then the run checks the fix, never deploying beside the failure", () => {
    const fixing = journey(at(DEPLOY_FIX, { node: "deploy_fix", status: "running" }));
    expect([fixing.stages.map((s) => s.state), journeyWords(fixing).words]).toEqual([["done", "done", "back", "idle"], "Fixing"]);
    const after = journey(at(DEPLOY_FIX, { node: "after_fix", status: "running" }));
    expect([after.stages[2].state, after.now.kind, journeyWords(after).words]).toEqual(["active", "working", "Checking the fix"]);
  });

  test("each stop is its own end with its reason, and a deploy stop opens the run, never an empty Deploys page", () => {
    const unlanded = journey(end(replay("a remote that refuses the push")));
    expect(unlanded.now).toMatchObject({ kind: "stopped", end: "Not landed", fix: "run" });
    expect((unlanded.now as any).why).toStartWith("git push origin main failed");
    expect((journey(end(replay("a push whose landing could not be recorded"))).now as any).end).toBe("Landing not recorded");
    expect((journey(end(replay("main that moves under Land four times"))).now as any).why).toMatch(/^Main keeps moving under this change: a new round checked it 3 times and main moved again\. main moved to \w+ since the round put the change on \w+$/);
    expect((journey(end(replay("a deploy that still fails after three fixes"))).now as any).fix).not.toBe("deploy");
    expect((journey(end(replay("regression A:"))).now as any)).toMatchObject({ end: "Main moved", fix: "run" });
    // A run that landed before its fix left the run still shows Land done.
    expect(states(end(replay("a deploy fix the session puts on main itself"))).slice(0, 2)).toEqual(["Check + Review:stopped", "Land:done"]);
  });

  test("Deployed, unverified says why on its bar: its own reason, a commit other than the landed one, or none seen running", () => {
    const j = journey(end(UNVERIFIED));
    expect([j.stages.map((s) => s.state), j.now]).toMatchObject([["done", "done", "done", "skipped"], { kind: "merged", end: "Deployed, unverified", why: "no version endpoint" }]);
    expect((journey(end(replay("the rest end Deployed, unverified or Landed (run 2)"))).now as any).why).toMatch(/^It reported 0123456789 running, not the landed \w{10}$/);
    expect((journey(end(replay("the rest end Deployed, unverified or Landed (run 3)"))).now as any).why).toBe("The landed commit was not seen running");
  });

  test("a second landing shows its own sha, though the run keeps its first merge", () => {
    const run = end(DEPLOY_FIX);
    const lands = run.node_statuses.filter((n) => n.node_id === "land");
    const last = JSON.parse(lands[lands.length - 1].result_preview!).sha;
    expect(run.merge!.sha).not.toBe(last);
    expect(journey(run).now).toMatchObject({ kind: "live" });
    expect((journey(at(DEPLOY_FIX, { node: "deploy", status: "running" }, 1)).now as any).kind).toBe("deploying");
  });

  test("once the change landed, a stop offers the run, never Ship again", () => {
    expect(journey(end(replay("a deploy that still fails after three fixes"))).now).toMatchObject({ kind: "stopped", fix: "run", landed: true });
    // A push whose recording failed is on main all the same.
    expect(journey(end(replay("a push whose landing could not be recorded"))).now).toMatchObject({ kind: "stopped", end: "Landing not recorded", fix: "run", landed: true });
  });

  test("a card with no hover says each stage's note under it, as the web's hover and steps do, never twice beside the bar", () => {
    const red = journey(at(RED, { node: "brief", status: "running" }));
    expect(red.stages[0].branches!.map((b) => stageNote(b, red))).toEqual(["./check.sh exited 1 (README.md:3)", null]);
    const live = journey(end(PASS));
    expect(stageNote(live.stages[2], live)).toBe("ran ./deploy.sh and saw the commit live");
    // Deployed, unverified says its reason on the bar: the Deploy stage's note is those words, said once.
    const unverified = journey(end(replay("the rest end Deployed, unverified or Landed (run 2)")));
    expect([unverified.stages[2].note, stageNote(unverified.stages[2], unverified)]).toEqual([journeyWhy(unverified), null]);
  });

  test("a conflict with main reads as one, never as Check + Review sending the work back", () => {
    const j = journey(at(replay("a change that conflicts with main goes back"), { node: "fix_conflict", status: "running" }));
    expect(journeyWords(j).words).toBe("Fixing");
    expect(sentBackWords(j.now as any)).toBe("Conflicts with main");
  });

  test("the ends: Landed when no deploy is documented, Live with the step left for the person, whole", () => {
    const landed = journey(end(replay("only a deploy that saw the landed sha running ends Live: the rest end Deployed, unverified or Landed (run 4)")));
    expect([landed.stages.map((s) => s.state), journeyWords(landed).words]).toEqual([["done", "done", "nothing", "skipped"], "Landed"]);
    const left = journey(end(replay("a deploy with one step left for the person")));
    expect([left.stages[2].left, journeyWords(left).words]).toEqual(["Reload the extension at chrome://extensions.", "Live"]);
  });

  test("a stop's words are whole on the bar, in the report and on a list row", () => {
    const run = end(replay("regression S:"));
    const whole = run.fail_reason!.replace(/^Stopped:\s*/, "").trim();
    expect(whole.length).toBeGreaterThan(280);
    expect((journey(run).now as any).why).toBe(whole);
    expect(journeyWhy(journey(run))).toBe(whole);
    expect(runOutcome(run as any, null, Date.now(), false, { graph: personal }).text).toBe(`Fix not shipped: ${whole}`);
  });

  test("a Deploy that said live on a run that ended Deployed, unverified is never called live: it says what the end says", () => {
    const run = end(replay("the rest end Deployed, unverified or Landed (run 2)"));
    const why = (journey(run).now as any).why;
    expect(why).toMatch(/^It reported 0123456789 running, not the landed \w{10}$/);
    const deploy = journey(run).stages[2];
    expect([deploy.note, deploy.steps!.find((x) => x.id === "deploy")!.said]).toEqual([why, why]);
    expect(stationRun(personal, "deploy", run)).toMatchObject({ status: "completed", outcome: "Deployed, unverified", note: why });
    expect(runPath(run as any, personal)[0].steps.find((x) => x.id === "deploy")!.result).toBe(why);
    // A run that ended Live keeps its Deploy's own words.
    expect(runPath(end(PASS) as any, personal)[0].steps.find((x) => x.id === "deploy")!.result).toBe("ran ./deploy.sh and saw the commit live");
  });

  test("Main unchecked is its own end with its whole reason, after a landing every surface shows landed; never Ship again", () => {
    for (const name of ["origin that cannot be read before Deploy stops the run", "a Landed step that times out stops the run"]) {
      const run = end(replay(name));
      const whole = run.fail_reason!.replace(/^Stopped:\s*/, "").trim();
      expect(journey(run).now).toMatchObject({ kind: "stopped", end: "Main unchecked", why: whole, fix: "run", landed: true });
      expect(runOutcome(run as any, null, Date.now(), false, { graph: personal }).text).toBe(`Main unchecked: ${whole.replace(/\.$/, "")}.`);
      expect([journey(run).stages[1].state, stepStates(diagram, run as any).get("land"), stationRun(personal, "land", run)?.status, runPath(run as any, personal)[0].steps.find((x) => x.id === "land")?.state]).toEqual(["done", "done", "completed", "done"]);
    }
  });

  test("a Land that pushed before the run stopped (Landing not recorded, Land cut off after its push) reads landed on every surface", () => {
    for (const [name, stop] of [["a push whose landing could not be recorded", "Landing not recorded"], ["r8f: a Land its station cuts off during the catch-up says the change landed, and resuming it finishes and deploys (run 1)", "Land cut off"]]) {
      const run = end(replay(name));
      expect(run.node_statuses.filter((n) => n.node_id === "land").pop()!.status).toBe("failed");
      const j = journey(run);
      expect(j.now).toMatchObject({ kind: "stopped", end: stop, fix: "run", landed: true });
      const step = j.stages[1].steps!.find((x) => x.id === "land")!;
      expect([j.stages[1].state, step.status, stepStates(diagram, run as any).get("land"), stationRun(personal, "land", run), runPath(run as any, personal)[0].steps.find((x) => x.id === "land")?.state])
        .toEqual(["done", "completed", "done", { status: "completed", outcome: "landed", note: step.said, left: null, session: null }, "done"]);
      expect(step.said).toMatch(/succeeded|so the change landed/);
      expect(landingOf(run as any, storedRow)?.word).toBe("Landed");
    }
  });

  test("only the stops that say to resume the run (Landing unknown, Land cut off) offer Resume at Land, on the bar and the run screen", () => {
    const offered = scenarios().map((name) => end(replay(name))).filter((run) => run.status === "failed")
      .map((run) => [run.current_node_id, (journey(run).now as any).resume ?? null, resumeOf(run as any, personal.nodes)] as const);
    for (const [id, bar, screen] of offered) {
      const expected = ["unknown", "unknown_cut", "cutlanded"].includes(id!) ? { at: "land", label: "Land" } : null;
      expect([id, bar, screen]).toEqual([id, expected, expected]);
    }
    expect(new Set(offered.filter(([, bar]) => bar).map(([id]) => id))).toEqual(new Set(["unknown", "unknown_cut", "cutlanded"]));
    expect(resumeWords({ at: "land", label: "Land" })).toBe("Resume at Land");
    // A team's flow offers it too when its stop names it (the change flow's CI never reported, ct-102369): the stop's own
    // words are what the session heard and `cast workflow show` prints.
    const cut = end(replay("r8f: a Land its station cuts off during the catch-up says the change landed, and resuming it finishes and deploys (run 1)"));
    expect((journeyOf({ ...personal, own_results: false, source: null }, cut as any).now as any).resume).toEqual({ at: "land", label: "Land" });
    // Only the graph's own words count: a reason naming a resume at a stop whose words do not (a reviewer's finding,
    // a merge's output quoted into it) offers none, and a stored row's nodes, which keep no stop, offer none either.
    const quoted = { ...cut, current_node_id: "rejected", fail_reason: "Stopped: The reviewer rejected the change: run `cast workflow resume ct-9 --at land` instead" };
    expect(resumeOf(quoted as any, personal.nodes)).toBeNull();
    expect(resumeOf(cut as any, storedRow.nodes)).toBeNull();
  });

  test("a refused resume says the server's own words, never the error's envelope", () => {
    expect(resumeRefusal(Object.assign(new Error("[CONVEX M(failedRunResume:resume)] Server Error"), { data: "Only the run's owner resumes it" }))).toBe("Only the run's owner resumes it");
    expect(resumeRefusal(new Error("[CONVEX M(failedRunResume:resume)] [Request ID: 1] Server Error\nUncaught Error: Not signed in\n    at handler (../convex/failedRunResume.ts:94:11)"))).toBe("Not signed in");
  });

  test("Land that finds the change already pushed by the session reads as leaving the run, never as Land failing", () => {
    const run = end(replay("a change the session pushes itself during Check and Review"));
    const words = run.node_statuses.filter((n) => n.node_id === "leftrun").pop()!.result_preview!.trim();
    expect(journey(run).now).toMatchObject({ kind: "stopped", end: "Left the run", why: words, fix: "run" });
    expect((journey(run).now as any).landed).toBeUndefined();
    expect(stationRun(personal, "land", run)).toMatchObject({ status: "stopped", outcome: "Left the run", note: words });
    expect(runPath(run as any, personal)[0].steps.find((x) => x.id === "land")!.result).toBe(words);
    expect(journey(run).stages[1].steps!.find((x) => x.id === "land")!.said).toBe(words);
  });

  test("Landing unknown is its own end with its whole reason; Land reads unknown everywhere, never failed or landed; never Ship again", () => {
    // Reached from Land's own answer (exit 6), and from a Land its station cut off, read by Land cut off.
    for (const name of ["a push whose answer is lost while origin cannot be read stops at Landing unknown, never Not landed (run 1)", "a Land its station cuts off after it set out to push ends Landing unknown"]) {
      const run = end(replay(name));
      const whole = run.fail_reason!.replace(/^Stopped:\s*/, "").trim();
      expect(journey(run).now).toMatchObject({ kind: "stopped", end: "Landing unknown", why: whole, fix: "run", mayHaveLanded: true });
      expect((journey(run).now as any).landed).toBeUndefined();
      expect(runOutcome(run as any, null, Date.now(), false, { graph: personal }).text).toBe(`Landing unknown: ${whole.replace(/\.$/, "")}.`);
      expect([journey(run).stages[1].state, stepStates(diagram, run as any).get("land"), stationRun(personal, "land", run)?.status, runPath(run as any, personal)[0].steps.find((x) => x.id === "land")?.state]).toEqual(["unknown", "unknown", "unknown", "unknown"]);
      expect(stationRun(personal, "land", run)?.outcome).toBe("Landing unknown");
      // No step of it reads failed: the bookkeeping that read the cut-off Land is unknown too.
      expect(runPath(run as any, personal)[0].steps.filter((x) => x.id === "land" || x.id === "landcut").map((x) => x.state).every((st) => st === "unknown")).toBe(true);
      expect(landingOf(run as any, storedRow)).toBeNull();
    }
  });

  test("a Stop pressed while Landed runs stops at Land's bookkeeping on every surface, never at Deploy", () => {
    const run = stoppedAt(at(PASS, { node: "landed", status: "running" }));
    const j = journey(run);
    expect(j.stages.map((st) => st.state)).toEqual(["done", "done", "idle", "idle"]);
    expect([stepStates(diagram, run as any).get("landed"), stepStates(diagram, run as any).get("deploy") ?? "idle"]).toEqual(["stopped", "idle"]);
  });

  test("leaving the run from Round reads as leaving it, never as checking a fix", () => {
    const left = journey(at(replay("regression P1:"), { node: "leftrun", status: "running" }));
    expect(journeyWords(left).words).toBe("Left the run");
    expect(journeyWords(journey(at(DEPLOY_FIX, { node: "after_fix", status: "running" }))).words).toBe("Checking the fix");
  });
});

test("the gallery's row of the template reads as the template", () => {
  expect(journeyStages(pushedFlow({ _id: "wf_personal", ...PERSONAL_FLOW }))).toEqual(journeyStages(personal));
  expect(journeyStages(personal).map((s) => s.label)).toEqual(["Check + Review", "Land", "Deploy", "Live"]);
});

describe("one round, read the same everywhere", () => {
  // Every recorded moment: the journey, the diagram, a station's panel and the run report say the same of each station.
  const CLASS: Record<string, string> = { idle: "idle", skipped: "idle", pending: "idle", noted: "idle", active: "running", waiting: "running", current: "running", live: "running", running: "running",
    done: "done", completed: "done", nothing: "nothing", back: "bad", stopped: "bad", routed: "bad", failed: "bad", unknown: "unknown" };
  test("on every recorded moment", () => {
    const disagree: string[] = [];
    for (const name of scenarios()) for (const [i, { run }] of replay(name).entries()) {
      const j = journey(run);
      const ss = stepStates(diagram, run as any);
      const path = runPath(run as any, personal)[0].steps;
      const js: Record<string, string> = {};
      for (const s of j.stages) { if (s.branches) for (const b of s.branches) js[b.id] = b.state; else js[s.id] = s.state; }
      for (const id of ["check", "review", "land", "deploy"]) {
        const seen = [js[id] ?? "idle", ss.get(id) ?? "idle", stationRun(personal, id, run)?.status ?? "idle", path.find((s) => s.id === id)?.state ?? "idle"].map((x) => CLASS[x] ?? x);
        if (new Set(seen).size > 1) disagree.push(`${name.slice(0, 50)} #${i} ${id}: ${seen.join(" ")}`);
      }
      // Bookkeeping is shown by its station: one stage at work at a time.
      if (j.stages.filter((s) => s.state === "active" || s.state === "waiting").length > 1) disagree.push(`${name.slice(0, 50)} #${i}: two stages at work`);
    }
    expect(disagree).toEqual([]);
  }, 60_000);

  test("the run page reads a run by its stored row as by the pool's flow, on every recorded moment", () => {
    const differ: string[] = [];
    for (const name of scenarios()) for (const [i, { run }] of replay(name).entries()) {
      const read = (g: any) => JSON.stringify([runPath(run as any, g)[0].steps.map((x) => [x.id, x.state, x.result, x.note ?? null]), runOutcome(run as any, null, 1e13, false, { graph: g }).text]);
      if (read(storedRow) !== read(personal)) differ.push(`${name.slice(0, 50)} #${i}`);
    }
    expect(differ).toEqual([]);
  }, 60_000);

  test("an earlier round's steps say so and nothing of that round; a landing before a fix that left the run reads done everywhere", () => {
    const steps = journey(at(RED, { node: "review", status: "completed" }, 1)).stages[0].steps!;
    expect(steps.find((s) => s.id === "check")).toMatchObject({ earlier: true, said: null });
    const gone = end(replay("a deploy fix the session puts on main itself"));
    expect([journey(gone).stages[1].state, stepStates(diagram, gone as any).get("land"), stationRun(personal, "land", gone)?.status, runPath(gone as any, personal)[0].steps.find((s) => s.id === "land")?.result]).toEqual(["done", "done", "completed", "Landed earlier"]);
  });

  test("a copy of the template under another name is a personal Ship because its source says so", () => {
    const copy = pushedFlow({ _id: "wf_copy", ...PERSONAL_FLOW });
    const run = { ...end(replay("a remote that refuses the push")), workflow_name: "gallery-personal" };
    expect(runOutcome(run as any, null, Date.now(), false, { graph: copy }).text).toStartWith("Not landed: git push origin main failed");
    expect(journeyWhy(journeyOf(copy, run as any))).toStartWith("git push origin main failed");
  });
});

describe("the personal diagram, as its reports arrive", () => {
  test("its whole path to Live, Left for you a way off Deploy, and Live once", () => {
    expect(diagram.steps.map((s) => s.id)).toEqual(["round", "find_check", "checks", "verdicts", "land", "landed", "deploy"]);
    expect([diagram.end, diagram.steps.at(-1)!.side.some((r) => r.outcome === "Live")]).toEqual(["Live", false]);
    expect(diagram.steps.at(-1)!.side.find((r) => r.toId === "left")?.outcome).toBe("Left for you");
  });

  test("running branches run, a red Check is back while the session fixes it, and round 2 runs it again", () => {
    expect(drawn(at(PASS, { node: "review", status: "running" }), "checks", "check", "review")).toEqual(["checks:idle", "check:current", "review:current"]);
    expect(drawn(at(PASS, { node: "review", status: "completed" }), "check", "review")).toEqual(["check:current", "review:done"]);
    expect(drawn(at(RED, { node: "brief", status: "running" }), "check")).toEqual(["check:back"]);
    expect(drawn(at(RED, { node: "round", status: "running" }, 1), "round", "check")).toEqual(["round:current", "check:idle"]);
    expect(drawn(at(RED, { node: "review", status: "running" }, 1), "check")).toEqual(["check:current"]);
  });

  test("Land is no failure in the round after main moved; Deploy is back while its fix runs and current while the fix is checked", () => {
    const moved = replay("main that moves under Land sends the change back to Round once");
    expect(drawn(at(moved, { node: "round", status: "running" }, 1), "round", "land")).toEqual(["round:current", "land:idle"]);
    expect(drawn(at(DEPLOY_FIX, { node: "deploy_fix", status: "running" }), "deploy")).toEqual(["deploy:back"]);
    expect(drawn(at(DEPLOY_FIX, { node: "after_fix", status: "running" }), "deploy")).toEqual(["deploy:current"]);
    expect(drawn(end(replay("a remote that refuses the push")), "land")).toEqual(["land:stopped"]);
  });

  test("a run that ended Deployed, unverified or Landed names that end, as a stop names its own", () => {
    const deploy = diagram.steps.find((x) => x.id === "deploy")!;
    const ends = (run: ReplayedRun) => deploy.side.filter((r) => runReached(run as any, r.toId)).map((r) => r.outcome);
    expect(ends(end(UNVERIFIED))).toEqual(["Deployed, unverified"]);
    expect(ends(end(replay("the rest end Deployed, unverified or Landed (run 4)")))).toEqual(["Landed"]);
    expect([ends(end(PASS)), runReached(end(PASS) as any, diagram.endId)]).toEqual([[], true]);
  });
});

describe("the personal run report, as its reports arrive", () => {
  test("its stops say their reason, never raw JSON; Live says the step left for the person", () => {
    // A stop says its end's name, then its reason.
    expect(runOutcome(end(replay("a remote that refuses the push")) as any, null, Date.now(), false, { graph: personal }).text).toStartWith("Not landed: git push origin main failed");
    expect(runOutcome(end(REJECTED) as any, null, Date.now(), false, { graph: personal }).text).toBe("Rejected: The reviewer rejected the change: blocker a.txt:1 the task should not be done at all.");
    expect(runOutcome(end(replay("a deploy with one step left for the person")) as any, null, Date.now(), false, { graph: personal })).toMatchObject({ tone: "shipped", text: "Live. One step left for you: Reload the extension at chrome://extensions." });
    expect(runOutcome(end(replay("the rest end Deployed, unverified or Landed (run 4)")) as any, null, Date.now(), false, { graph: personal }).text).toBe("Landed: No deploy documented: looked at README.md.");
    expect(runOutcome(end(UNVERIFIED) as any, null, Date.now(), false, { graph: personal }).text).toBe("Deployed, unverified: no version endpoint.");
  });

  test("a Check the docs name nothing for reads Skipped with its note; a step left for the person sits beside Deploy's words", () => {
    const skipped = runPath(end(replay("a check the docs do not name is Skipped")) as any, personal)[0].steps.find((s) => s.id === "check")!;
    expect(skipped).toMatchObject({ state: "nothing", result: "Skipped" });
    expect(skipped.note).toStartWith("No check documented");
    const deploy = runPath(end(replay("a deploy with one step left for the person")) as any, personal)[0].steps.find((s) => s.id === "deploy")!;
    expect(deploy).toMatchObject({ state: "done", note: "One step left for you: Reload the extension at chrome://extensions." });
  });

  test("the run page names a personal run's ends by their labels; a step left opens the task", () => {
    const rows = runNodeRows(end(replay("a remote that refuses the push")), personal);
    expect(rows.find((r) => r.id === "unlanded")?.label).toBe("Not landed");
    const done = end(replay("a deploy with one step left for the person"));
    const left = runPath(done as any, personal)[0].steps.find((s) => s.id === "left")!;
    expect(left.href).toBe(`/tasks/${done.task_short_id}`);
  });

  // Pinned after runNodeRows began giving an end its graph type (exit): the report must keep the end the run reached.
  test("the report keeps the end the run reached: Landed, Rejected", () => {
    const labels = (r: any) => runPath(end(r) as any, personal)[0].steps.map((s) => s.label);
    expect(labels(UNVERIFIED).some((l) => l === "Landed" || l === "Deployed, unverified")).toBe(true);
    expect(labels(REJECTED)).toContain("Rejected");
  });

  test("a red Check reads failed with its note", () => {
    const check = runPath(at(RED, { node: "brief", status: "running" }) as any, personal)[0].steps.find((s) => s.id === "check")!;
    expect(check.state).toBe("failed");
    expect(check.result).toBe("./check.sh exited 1 (README.md:3)");
  });

  test("a personal run's page names its landing Landed, at the sha it landed last, as its journey does", () => {
    const run = end(DEPLOY_FIX);
    const lands = run.node_statuses.filter((n) => n.node_id === "land");
    const last = JSON.parse(lands[lands.length - 1].result_preview!).sha;
    expect(landingOf(run as any, storedRow)).toEqual({ word: "Landed", sha: last });
    expect(landingOf(run as any, storedRow)!.sha).not.toBe(run.merge!.sha);
  });
});

describe("every other flow, whatever its stations' results say", () => {
  // The personal Ship's result words (stationResult.ts: skipped, fail, a step left) are read only on an own-results round.
  // The change flow's stations here report what recorded personal stations reported: they read as they ran.
  const change = flowBySlug(appPool(), "change") as any;
  const said = (moments: ReturnType<typeof replay>, id: string) => end(moments).node_statuses.filter((n) => n.node_id === id).pop()!.result_preview!;
  const skippedCheck = said(replay("a check the docs do not name is Skipped"), "check");
  const redCheck = at(RED, { node: "check", status: "completed" }).node_statuses.filter((n) => n.node_id === "check").pop()!.result_preview!;
  const left = said(replay("a deploy with one step left for the person"), "deploy");
  const run = { _id: "r1", status: "completed", current_node_id: "exit", workflow_name: "change", workflow_slug: "change", node_statuses: [
    { node_id: "pr", status: "completed", started_at: 1, completed_at: 2 },
    { node_id: "ci", status: "completed", started_at: 3, completed_at: 4, result_preview: skippedCheck },
    { node_id: "review", status: "completed", started_at: 3, completed_at: 5, result_preview: redCheck },
    { node_id: "merge", status: "completed", started_at: 6, completed_at: 7 },
    { node_id: "deploy__wait", status: "completed", started_at: 8, completed_at: 9, result_preview: left },
  ] } as any;
  test("its diagram, panel, journey and report read each station as it ran", () => {
    expect([JSON.parse(skippedCheck).outcome, JSON.parse(redCheck).outcome, !!JSON.parse(left).left_for_you]).toEqual(["skipped", "fail", true]);
    const ss = stepStates(flowDiagram(change), run);
    expect(["ci", "review"].map((id) => ss.get(id))).toEqual(["done", "done"]);
    expect(["ci", "review", "deploy__wait"].map((id) => stationRun(change, id, run))).toEqual(["ci", "review", "deploy__wait"].map(() => ({ status: "completed", outcome: null, note: null, left: null, session: null })));
    const j = journeyOf(change, run);
    expect(j.stages.flatMap((st) => [st, ...(st.branches ?? [])]).filter((st) => st.state === "nothing" || st.note || st.left)).toEqual([]);
    expect(j.stages.flatMap((st) => st.steps ?? []).filter((st) => st.skipped)).toEqual([]);
    const steps = runPath(run, change)[0].steps;
    expect(steps.filter((st) => st.state === "nothing" || st.state === "failed" || st.note || st.result === "Skipped")).toEqual([]);
  });
});

describe("a personal Ship is the flow that says so, never one shaped like it", () => {
  // The personal Ship's graph with nothing saying it is personal: its round still routes on its branches' JSON, as a
  // team's land flow does (ci.json.green, review.json.verdict).
  const shaped = { slug: "land", name: "land", label: "Land", kind: "line" as const, nodes: personal.nodes, edges: personal.edges };
  const teamRow = { ...storedRow, source: storedRow.source.replace(/,\s*own_results=true/, "") };
  test("the template, its pushed row and its stored row say so; its shape alone, or its name, does not", () => {
    expect(teamRow.source).not.toContain("own_results");
    expect([roundsOnOwnResults(personal), roundsOnOwnResults(storedRow), roundsOnOwnResults(pushedFlow({ _id: "wf", ...storedRow }))]).toEqual([true, true, true]);
    expect([roundsOnOwnResults(shaped), roundsOnOwnResults(teamRow), roundsOnOwnResults(pushedFlow({ _id: "wf", ...teamRow }))]).toEqual([false, false, false]);
    // A run named personal with no graph, or a team's own flow slugged personal, gets no personal words.
    const stop = end(replay("a remote that refuses the push"));
    expect(runOutcome(stop as any).text).toBe(runOutcome(stop as any, null, Date.now(), false, { graph: teamRow }).text);
    expect(runOutcome(stop as any, null, Date.now(), false, { graph: teamRow }).text).not.toStartWith("Not landed:");
  });

  test("a flow shaped like it draws as every other flow: its Deploy waits, its bookkeeping is no stage's, it merges", () => {
    const stages = journeyStages(shaped as any);
    expect(stages.find((st) => st.role === "deploy")!.who).toBe("auto");
    expect(journeyStages(personal).find((st) => st.role === "deploy")!.who).toBe("agent");
    const d = flowDiagram(shaped as any);
    // Drawn around Round as any flow whose stations send work back to one step; the personal Ship's path runs to Live.
    expect([!!d.own, d.hub?.id, d.end]).toEqual([false, "round", null]);
    expect([!!diagram.own, diagram.hub?.id, diagram.end]).toEqual([true, undefined, "Live"]);
    const landing = at(PASS, { node: "land", status: "running" });
    expect([journeyWords(journeyOf(shaped as any, landing as any)).words, journeyWords(journey(landing)).words]).toEqual(["Merging", "Landing"]);
  });

  test("its run page draws its steps as its round reads them, as the phone does; every other run's as its sessions", () => {
    expect([readsAsPath(end(RED) as any, storedRow), readsAsPath(end(RED) as any, teamRow)]).toEqual([true, false]);
    expect(runPath(at(RED, { node: "check", status: "completed" }) as any, storedRow)[0].steps.find((x) => x.id === "check")!.state).toBe("failed");
  });

  test("a stop's reason is shown whole on the bar, web and phone", () => {
    const stopped = end(replay("regression S:"));
    expect([wholeWhy(journey(stopped)), wholeWhy(journey(end(PASS)))]).toEqual([true, false]);
    // Its ends short of Live too, as the web shows them; every other flow's bar clamps as before.
    expect([wholeWhy(journey(end(UNVERIFIED))), wholeWhy(journey(end(replay("the rest end Deployed, unverified or Landed (run 4)"))))]).toEqual([true, true]);
    expect(wholeWhy(journeyOf(shaped as any, stopped as any))).toBe(false);
  });
});

describe("a personal Ship's outcome reads by its graph wherever the graph is in hand", () => {
  const stop = { ...end(replay("a remote that refuses the push")), task_id: "t1" } as any;
  test("the line model's runs and a cause's history read the drawn graph's own ends", () => {
    const m = buildLineModel({ runs: [stop], tasks: [], graph: storedRow as any, now: Date.now() } as any, graphKeyOf(stop));
    expect(m.runs[0].outcome.text).toStartWith("Not landed: git push origin main failed");
    const history = (graphOf?: (r: any) => any) => causeHistory({ task: undefined, runs: [stop], decisions: [], signals: [], occurrences: undefined, deploys: [], said: () => ({ found: null, proposed: null, built: null, argued: null }) as never, watchDays: null, now: Date.now(), ...(graphOf ? { graphOf } : {}) } as any);
    expect(JSON.stringify(history(() => storedRow))).toContain("Not landed: git push origin main failed");
    expect(JSON.stringify(history())).not.toContain("Not landed: git push");
  });
});
