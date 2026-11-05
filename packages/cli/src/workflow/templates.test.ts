// line.cast (docs/architecture/the-line.md L1, the-line-end-to-end.md LE1 to
// LE12) ships inside the binary and resolves by name. These tests parse it,
// check its stations, edges, gates and node prompts, and run its station
// scripts against a scratch repo. The offline run through the runner's session
// path lives in templates.offline.test.ts.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { proofSummary } from "@codecast/shared/contracts/changeCard";
import { conditionError, evalCondition, extractJsonOutput } from "./condition";
import { graphHash, parseWorkflowFile, parseWorkflowSource, validateWorkflow } from "./parser";
import { expandPromptVars, expandScriptVars, gatePayload, lineRunDir, parseGateEdgeLabel, runWorkflow } from "./runner";
import { lineCommandEnv, lineProfileVars, parseLineProfileText, resolveLineProfile } from "../lineProfile";
import { BUILTIN_WORKFLOW_TEMPLATES, LINE_TEMPLATE_FILES, inlineTemplateFiles, resolveWorkflowSource } from "./templates";
import { JUDGE_REVIEW_GRAPH } from "@codecast/shared/contracts/judgeReview";
import type { WorkflowGraph } from "./types";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";
import { UNION_PROFILE } from "../test-helpers/unionLineProfile";
isolateCodecastDirEachTest("cast-wf-state-");

const TEMPLATE_DIR = path.join(import.meta.dir, "templates");
const AGENT_NODES = ["ground", "plan", "analyze", "prove", "prove_line", "implement", "implement_line", "review", "card_write"];
const from = (graph: WorkflowGraph, id: string) => graph.edges.filter((e) => e.from === id).map((e) => `${e.to}:${e.condition ?? ""}`);

// Union's profile and a repo with none: the template must run on both.
const profileVars = (toml: string) => lineProfileVars(resolveLineProfile(parseLineProfileText(toml).values).profile);
const UNION_VARS = profileVars(UNION_PROFILE);
const EMPTY_VARS = profileVars("");

describe("line.cast template", () => {
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line);

  test("resolves by bare name, with .cast, and never for a path", () => {
    expect(resolveWorkflowSource("line")?.label).toBe("builtin:line");
    expect(resolveWorkflowSource("line.cast")?.source).toBe(BUILTIN_WORKFLOW_TEMPLATES.line);
    expect(resolveWorkflowSource("./nope/line.cast")).toBeNull();
    expect(resolveWorkflowSource("feature")?.label).toBe("builtin:feature");
  });

  test("parses and validates with every station of LE1 to LE12", () => {
    expect(graph.name).toBe("line");
    expect(validateWorkflow(graph)).toEqual([]);
    expect([...graph.nodes.keys()]).toEqual([
      "start", "exit", "stopped", "rejected", "ground", "park", "plan", "analyze", "prove", "prove_line", "red", "dissolve",
      "unproven", "implement", "implement_line", "verify", "green", "eval", "unscored", "review", "card_draft", "card_write", "card",
      "decide", "reopen", "drop", "rebase", "ship", "watch",
    ]);
    expect(graph.nodes.get("verify")?.type).toBe("command");
    expect(graph.nodes.get("verify")?.script).toContain("bash -c $line.commands.check");
    expect(graph.nodes.get("card_write")?.type).toBe("prompt");
  });

  test("the builtin inlines every line/ file, and reads the same as the template run from disk", () => {
    expect([...graph.nodes.values()].filter((n) => n.prompt?.startsWith("@") || n.script?.startsWith("@")).map((n) => n.id)).toEqual([]);
    const onDisk = parseWorkflowFile(path.join(TEMPLATE_DIR, "line.cast"));
    expect(graphHash(onDisk)).toBe(graphHash(graph));
    for (const [ref, text] of Object.entries(LINE_TEMPLATE_FILES)) {
      expect(fs.readFileSync(path.join(TEMPLATE_DIR, ref), "utf-8")).toBe(text);
    }
    // Every file under line/ and change/ is shipped, and every shipped file is used.
    for (const dir of ["line", "change"]) {
      expect(fs.readdirSync(path.join(TEMPLATE_DIR, dir)).sort()).toEqual(Object.keys(LINE_TEMPLATE_FILES).filter((r) => r.startsWith(`${dir}/`)).map((r) => r.slice(dir.length + 1)).sort());
    }
    // The line's own files, the diagnosis graph it runs beside its causes (LL11), and the change flows' briefs (flows.md FL4).
    const shipped = [graph, ...[JUDGE_REVIEW_GRAPH, "change", "quick-change"].map((t) => parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES[t]))];
    const used = new Set(shipped.flatMap((g) => [...g.nodes.values()].flatMap((n) => [n.prompt, n.script])));
    for (const text of Object.values(LINE_TEMPLATE_FILES)) expect(used.has(text)).toBe(true);
  });

  test("inlineTemplateFiles writes a DOT string the parser reads back exactly", () => {
    const text = 'a "quoted" \\path\\ and\nlines\twith a tab';
    const src = inlineTemplateFiles('digraph g { n [prompt="@x/y.md", script="@missing.sh"] }', { "x/y.md": text });
    const n = parseWorkflowSource(src).nodes.get("n")!;
    expect(n.prompt).toBe(text);
    expect(n.script).toBe("@missing.sh");
  });

  test("each agent node is an unattended session whose prompt lives in its own file", () => {
    for (const id of AGENT_NODES) {
      const node = graph.nodes.get(id)!;
      expect(node.backend).toBe("session");
      expect(node.agent).toBe("claude");
      expect(node.prompt).toBe(LINE_TEMPLATE_FILES[`line/${id}.md`]);
    }
    for (const id of ["prove", "prove_line", "implement", "implement_line"]) expect(graph.nodes.get(id)?.isolated).toBe(true);
    expect(graph.nodes.get("implement")?.max_visits).toBe(3);
    expect(graph.nodes.get("implement_line")?.max_visits).toBe(3);
    for (const id of ["ground", "plan", "analyze", "review", "card_write"]) expect(graph.nodes.get(id)?.isolated).toBeUndefined();
  });

  test("node prompts follow the prompting standard: intent first, a facts block, untrusted text named as data", () => {
    for (const id of AGENT_NODES) {
      const prompt = graph.nodes.get(id)!.prompt!;
      // P1: the reader's job comes before any command.
      expect(prompt.indexOf("`")).toBeGreaterThan(prompt.indexOf(". "));
      // P6: facts in a labeled block, and text from others named as data.
      expect(prompt).toContain("\nFacts\n");
      expect(prompt).toMatch(/data|not instructions/);
      // P4: no history.
      expect(prompt).not.toMatch(/no longer|used to|previously/i);
      // A hand that routes the run says how it ends.
      expect(prompt).toMatch(/cast state --status done|cast task handoff|cast task verdict/);
      expect(prompt).not.toContain("—");
    }
  });

  test("every $var a prompt, script, doc or card names is one the run provides", () => {
    // Context the runner sets (runWorkflow, loadTaskContext, session nodes,
    // gates); <node>.output|json|outcome for nodes in this graph.
    const known = new Set([
      "task_id", "task_title", "task_description", "acceptance_criteria", "task_status", "execution_status",
      "review_verdict", "review_note", "handoff", "handoff_note", "goal_ref", "category", "risk", "readiness", "readiness_note",
      "assignee", "project_path", "default_branch", "run_id", "run_date", "worktree", "branch", "human_message", "goal", "outcome",
      "run_dir", "cause_history", "last_error", "sent_back", ...Object.keys(EMPTY_VARS),
      // A change frozen from a session (frozenChangeContext): empty on a run with none.
      "change_session",
      // The station running, as the graph names it (runNodeLoop).
      "station_id",
    ]);
    const nodeVar = /^(\w+)\.(output|outcome|json(\.\w+)*)$/;
    const texts = [graph.stack!, ...[...graph.nodes.values()].flatMap((n) => [n.prompt, n.script, n.doc, n.card])].filter(Boolean) as string[];
    const unknown = new Set<string>();
    for (const text of texts) {
      for (const [, name] of text.matchAll(/\$(\w+(?:\.\w+)*)/g)) {
        const m = name.match(nodeVar);
        if (known.has(name) || (m && graph.nodes.has(m[1]))) continue;
        // Shell locals and positionals in the station scripts.
        if (/^([a-z]+|\d)$/.test(name) && texts.some((t) => t.includes(`${name}=`) || /^\d$/.test(name) || t.includes(`read -r ${name}`) || t.includes(`for ${name} in `))) continue;
        unknown.add(name);
      }
    }
    expect([...unknown]).toEqual([]);
  });

  test("every edge condition parses with the condition language", () => {
    const conditions = graph.edges.filter((e) => e.condition);
    expect(conditions.length).toBeGreaterThan(20);
    for (const e of conditions) expect(conditionError(e.condition!)).toBeNull();
  });

  test("every station reachable from start can reach exit, and every node is reachable", () => {
    const next = (id: string) => graph.edges.filter((e) => e.from === id).map((e) => e.to);
    const reach = (seed: string, step: (id: string) => string[]) => {
      const seen = new Set([seed]);
      const queue = [seed];
      while (queue.length) for (const n of step(queue.shift()!)) if (!seen.has(n)) { seen.add(n); queue.push(n); }
      return seen;
    };
    const fromStart = reach("start", next);
    expect([...graph.nodes.keys()].filter((id) => !fromStart.has(id))).toEqual([]);
    const toExit = reach("exit", (id) => graph.edges.filter((e) => e.to === id).map((e) => e.from));
    // The two exits that end a run on purpose are ends too.
    const stops = ["stopped", "rejected"];
    expect([...fromStart].filter((id) => !toExit.has(id))).toEqual(stops);
    expect(stops.map((id) => [graph.nodes.get(id)?.type, graph.nodes.get(id)?.stop])).toEqual([
      ["exit", "$handoff_note"],
      ["exit", "The reviewer rejected the change. $review_note"],
    ]);
    // Only the exits are dead ends.
    expect([...graph.nodes.keys()].filter((id) => next(id).length === 0)).toEqual(["exit", ...stops]);
  });

  test("one gate, the presenter's, at the end; every other way a run ends asks nobody", () => {
    const gates = [...graph.nodes.values()].filter((n) => n.type === "human");
    expect(gates.map((g) => [g.id, g.asker])).toEqual([["decide", "card_write"]]);
    expect(graph.on_failure).toBe("stop");
    // The plan goes straight on; a planner that pinned blocked ends the run.
    expect(from(graph, "plan")).toEqual(["analyze:", "stopped:handoff = blocked and station_blocked = plan"]);
    const options = (id: string) => graph.edges.filter((e) => e.from === id).map((e) => ({ ...parseGateEdgeLabel(e.label ?? ""), to: e.to, condition: e.condition }));
    for (const gate of gates) {
      // An answer that opens with none of the decide gate's verbs reaches the run as a note (the fallback edge).
      const opts = options(gate.id).filter((o) => !(gate.id === "decide" && o.condition === "outcome = success"));
      expect(opts.every((o) => o.condition === undefined && /^\[[A-Z]\] \w+$/.test(o.label) && !!o.description)).toBe(true);
      expect(new Set(opts.map((o) => o.key)).size).toBe(opts.length);
      expect(gate.prompt).toBeTruthy();
      expect(gate.category).toBeTruthy();
    }
    // Ship goes through the rebase station first: a card waits while the default branch moves.
    expect(options("decide").map((o) => `${o.key ?? ""}:${o.to}`)).toEqual(["S:rebase", "R:reopen", "D:drop", ":reopen"]);
    expect(options("decide").at(-1)?.condition).toBe("outcome = success");
    expect(graph.nodes.get("decide")?.card).toBe("$run_dir/card.json");
    expect(from(graph, "reopen")).toEqual(["implement:category != line", "implement_line:category = line"]);
    expect(from(graph, "drop")).toEqual(["exit:"]);
  });

  test("the decide gate adopts the presenting station's own decision and files no stack of its own (LE11)", () => {
    const payload = gatePayload(graph.nodes.get("decide")!, graph, {
      assignee: "Infra lead", run_date: "2026-10-02", task_title: "Titles copy the opener",
      "card_write.json": JSON.stringify({ question: "Should a session's title say what it worked on?", recommend: "ship", why: "Every title the change wrote named the work.", page: "/r/present/page.html" }),
      "card_write.session_id": "sess-present",
      run_dir: "/nonexistent/cast-line",
    });
    expect("stack" in payload).toBe(false);
    expect(payload.asker_session_id).toBe("sess-present");
    expect(payload.prompt).toBe("Should a session's title say what it worked on?");
    expect(payload.doc_md).toBe("Every title the change wrote named the work.");
    expect(payload.category).toBe("review");
    expect("card" in payload).toBe(false);
  });

  // The routing table: for a context, which edges out of a node fire.
  const fired = (id: string, context: Record<string, string>) =>
    graph.edges.filter((e) => e.from === id && e.condition && evalCondition(e.condition, context)).map((e) => e.to);

  test("ground routes on goal and readiness: anything not ready or serving no goal parks; plan risk goes to the plan gate", () => {
    const ready = { readiness: "ready", goal_ref: "in-3:activation", risk: "low", outcome: "success" };
    expect(fired("ground", ready)).toEqual(["analyze"]);
    expect(fired("ground", { ...ready, risk: "review" })).toEqual(["analyze"]);
    expect(fired("ground", { ...ready, risk: "plan" })).toEqual(["plan"]);
    expect(fired("ground", { ...ready, goal_ref: "none" })).toEqual(["park"]);
    expect(fired("ground", { ...ready, goal_ref: "" })).toEqual(["park"]);
    expect(fired("ground", { ...ready, readiness: "not_actionable" })).toEqual(["park"]);
    expect(fired("ground", { ...ready, readiness: "needs_context" })).toEqual(["park"]);
    // Ground wrote nothing: park, never build.
    expect(fired("ground", { outcome: "success" })).toEqual(["park"]);
  });

  test("prove and red route on node JSON: no reproduction dissolves, no proof parks, no red check goes back to prove", () => {
    expect(fired("prove", { "prove.json": '{"reproduced":true}' })).toEqual(["red"]);
    expect(fired("prove", { "prove.json": '{"reproduced":false}' })).toEqual(["dissolve"]);
    // Prove ended without its proof, whether it failed or settled: never a dead end (ct-57659).
    expect(fired("prove", {})).toEqual(["unproven"]);
    expect(fired("prove", { outcome: "failure" })).toEqual(["unproven"]);
    expect(fired("prove", { "prove.json": '{"tried":"x"}' })).toEqual(["unproven"]);
    expect(fired("red", { "red.json": '{"red":true,"dir":"/d"}' })).toEqual(["implement"]);
    expect(fired("red", { "red.json": '{"red":false,"dir":"/d"}' })).toEqual(["prove"]);
    expect(fired("red", {})).toEqual(["prove"]);
  });

  test("a change to the line itself takes its own prove and build stations, and every way back to the builder finds implement_line", () => {
    const line = { category: "line" };
    expect(fired("analyze", { category: "code" })).toEqual(["prove"]);
    expect(fired("analyze", line)).toEqual(["prove_line"]);
    expect(fired("prove_line", { ...line, "prove_line.json": '{"reproduced":true}' })).toEqual(["red"]);
    expect(fired("prove_line", { ...line, "prove_line.json": '{"reproduced":false}' })).toEqual(["dissolve"]);
    expect(fired("red", { ...line, "red.json": '{"red":true}' })).toEqual(["implement_line"]);
    expect(fired("red", { ...line, "red.json": '{"red":false}' })).toEqual(["prove_line"]);
    expect(from(graph, "implement_line")).toEqual(["verify:handoff = done", "stopped:handoff = needs_context or handoff = blocked"]);
    expect(fired("verify", { ...line, outcome: "failure" })).toEqual(["implement_line"]);
    expect(fired("green", { ...line, outcome: "failure" })).toEqual(["implement_line"]);
    expect(fired("eval", { ...line, outcome: "failure", "eval.exit_code": "1" })).toEqual(["implement_line"]);
    expect(fired("review", { ...line, review_verdict: "changes" })).toEqual(["implement_line"]);
    expect(fired("reopen", line)).toEqual(["implement_line"]);
    expect(fired("rebase", { ...line, outcome: "failure", "rebase.exit_code": "1" })).toEqual(["implement_line"]);
  });

  test("after verify: code proves green, then every change meets the eval station, which owns its scope", () => {
    expect(fired("verify", { outcome: "success", category: "code" })).toEqual(["green"]);
    expect(fired("verify", { outcome: "success", category: "prompt" })).toEqual(["eval"]);
    // A change to the line itself proves green when prove left a check to rerun, then meets eval (line-map.md LX6).
    expect(fired("verify", { outcome: "success", category: "line" })).toEqual(["green"]);
    expect(fired("verify", { outcome: "failure", category: "code" })).toEqual(["implement"]);
    expect(fired("green", { outcome: "failure" })).toEqual(["implement"]);
    expect(fired("green", { outcome: "success" })).toEqual(["eval"]);
    expect(fired("eval", { outcome: "failure", "eval.exit_code": "1" })).toEqual(["implement"]);
    // No verdict on the change (no reps, nothing scored) is not the builder's to fix.
    expect(fired("eval", { outcome: "failure", "eval.exit_code": "2" })).toEqual(["unscored"]);
    expect(fired("eval", { outcome: "success" })).toEqual(["review"]);
  });

  test("review keeps its verdict routing; approve goes to the card; a refused card goes back to its writer", () => {
    expect(from(graph, "implement")).toEqual(["verify:handoff = done", "stopped:handoff = needs_context or handoff = blocked"]);
    expect(from(graph, "review")).toEqual(["card_draft:review_verdict = approve", "implement:review_verdict = changes and category != line", "implement_line:review_verdict = changes and category = line", "rejected:review_verdict = reject"]);
    expect(graph.nodes.get("review")?.reviewer).toBe(true);
    expect(graph.nodes.get("implement")?.reviewer).toBeUndefined();
    expect(from(graph, "card_draft")).toEqual(["card_write:"]);
    expect(from(graph, "card")).toEqual(["decide:outcome = success", "card_write:outcome = failure"]);
    expect(from(graph, "watch")).toEqual(["exit:"]);
    expect(graph.nodes.get("watch")?.script).toBe("cast task update $task_id --watch-days $line.watch_days");
  });

  test("ship: a landed ship watches the cause, with or without a ship command; a refused ship ends the run", () => {
    expect(fired("ship", { outcome: "success", ...EMPTY_VARS })).toEqual(["watch"]);
    expect(fired("ship", { outcome: "success", ...UNION_VARS })).toEqual(["watch"]);
    expect(fired("ship", { outcome: "failure", "ship.exit_code": "1", ...UNION_VARS })).toEqual(["exit"]);
    expect(fired("ship", { outcome: "failure", "ship.exit_code": "1", ...EMPTY_VARS })).toEqual(["exit"]);
  });

  test("the template names no path or tool of one project: everything per project comes from the profile", () => {
    const sources = [fs.readFileSync(path.join(TEMPLATE_DIR, "line.cast"), "utf-8"), ...Object.values(LINE_TEMPLATE_FILES)]
      .map((t) => t.replace(/^\s*(\/\/|#).*$/gm, ""));
    for (const text of sources) {
      expect(text).not.toContain("./evals");
      expect(text).not.toContain("docs/principles.md");
      expect(text).not.toContain("docs/prompting.md");
      expect(text).not.toContain("cast ws check");
      expect(text).not.toMatch(/\b400\b/);
      expect(text).not.toMatch(/watch-days \d|for a week/);
    }
  });

  // Every prompt, script, doc and card with the run's context laid over a profile.
  const rendered = (vars: Record<string, string>) => {
    const ctx: Record<string, string> = { task_id: "ct-1", task_title: "T", worktree: "line-ct-1", branch: "codecast/line-ct-1", default_branch: "main", run_id: "run_1", run_dir: "/r/cast-line/line-ct-1", category: "prompt", ...vars };
    const nodes = [...graph.nodes.values()];
    return {
      prompts: nodes.flatMap((n) => [n.prompt, n.doc, n.card]).filter(Boolean).map((t) => expandPromptVars(t!, graph, ctx)),
      scripts: Object.fromEntries(nodes.filter((n) => n.script).map((n) => [n.id, expandScriptVars(n.script!, ctx)])),
    };
  };

  test("renders with Union's profile: its commands, principles, prompting, budget and watch days, and no $line left", () => {
    const { prompts, scripts } = rendered(UNION_VARS);
    for (const t of [...prompts, ...Object.values(scripts)]) expect(t).not.toMatch(/\$line\./);
    expect(scripts.verify).toContain("bash -c 'bun outreach/backend/scripts/line.ts check --base $default_branch'");
    expect(scripts.red).toContain("cmd='bun outreach/backend/scripts/line.ts prove --task $task_id --dir $run_dir'");
    expect(scripts.eval).toContain("cmd='bun outreach/backend/scripts/line.ts eval --base $default_branch --dir $run_dir --out $run_dir/reps.json'");
    expect(scripts.eval).toContain("cast line eval-result --reps \"$dir/reps.json\" --out \"$dir/eval-result.json\"");
    expect(scripts.ship).toContain("--run $run_id --dir $run_dir --into $default_branch'");
    expect(scripts.watch).toBe("cast task update 'ct-1' --watch-days '7'");
    const all = prompts.join("\n");
    expect(all).toContain("outreach/docs/line/principles.md");
    expect(all).toContain("outreach/docs/line/prompting.md");
    expect(all).toContain("about 400 changed lines");
  });

  test("renders with an empty profile: the defaults, and stations that pass with a note", () => {
    const { prompts, scripts } = rendered(EMPTY_VARS);
    for (const t of [...prompts, ...Object.values(scripts)]) expect(t).not.toMatch(/\$line\./);
    expect(scripts.verify).toContain("bash -c 'cast ws check'");
    expect(scripts.red).toContain("cmd=''");
    expect(scripts.eval).toContain("cmd=''");
    expect(scripts.ship).toContain("cmd=''");
    const all = prompts.join("\n");
    expect(all).toContain("principles, each with a stable id: https://github.com/codecast-sh/codecast/blob/main/docs/principles.md (the shared set)\n");
    expect(all).toContain("github.com/codecast-sh/codecast/blob/main/docs/prompting.md");
  });

  test("the runner's run dir sits in the repo's git directory, shared by every worktree, and is stable per task", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "line-rundir-"));
    try {
      spawnSync("git", ["init", "-q", repo]);
      const gitDir = fs.realpathSync(path.join(repo, ".git"));
      expect(fs.realpathSync(path.dirname(path.dirname(lineRunDir(repo, "line-ct-1"))))).toBe(gitDir);
      expect(lineRunDir(repo, "line-ct-1")).toEndWith("/cast-line/line-ct-1");
      expect(lineRunDir(path.join(os.tmpdir(), "no-such-repo-dir"), "x")).toBe(path.join(os.tmpdir(), "cast-line", "x"));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the review hand sees only branch, title and criteria", () => {
    const review = graph.nodes.get("review")!.prompt!;
    expect(review).toContain("$branch");
    expect(review).toContain("$task_title");
    expect(review).toContain("$acceptance_criteria");
    expect(review).toContain("$default_branch...$branch");
    expect(review).not.toContain("$task_description");
    expect(review).toContain("cast task verdict $task_id approve|changes|reject --note -");
    expect(graph.nodes.get("analyze")?.prompt).toContain("cast task update $task_id --steps -");
    expect(graph.nodes.get("implement")?.prompt).toContain("cast task handoff $task_id");
    // A line cause (LX6) has its own prompts: the builder knows the line's own files are the change, and prove leaves a proof the line checks.
    for (const f of [".codecast/line.toml", ".codecast/line/line.cast", "cast expectations propose", "line-proof.json"]) expect(graph.nodes.get("implement_line")?.prompt).toContain(f);
    expect(graph.nodes.get("prove_line")?.prompt).toContain("$run_dir/line-proof.json");
    for (const id of ["prove", "implement"]) expect(graph.nodes.get(id)?.prompt).not.toMatch(/category `line`|For line:|line-proof/);
    expect(graph.nodes.get("prove")?.prompt).toContain("$run_dir/judge-defects.json");
  });

  test("script variables expand shell-quoted and leave $( alone; $human_message is empty when there is no note", () => {
    expect(expandScriptVars("cd \"$(cast ws path $worktree)\" && echo $task_title", { worktree: "line-ct-1", task_title: "it's; rm -rf" }))
      .toBe("cd \"$(cast ws path 'line-ct-1')\" && echo 'it'\\''s; rm -rf'");
    const drop = graph.nodes.get("drop")!.script!;
    expect(expandScriptVars(drop, { task_id: "ct-1" })).toBe(`note=''; cast task drop 'ct-1' -m "Dropped at the gate.\${note:+ $note}"`);
    expect(expandScriptVars(drop, { task_id: "ct-1", "human.message": "not worth it" })).toContain("note='not worth it';");
  });
});

// ── Station scripts, run for real against a scratch repo ─────────────────────
// A fake `cast` on PATH answers `ws path` with the repo and logs every other
// call, so the scripts run as the runner runs them: expanded, under bash.
describe("line.cast station scripts", () => {
  // Every script spawns bash, git and the fake cast; slow on a loaded machine.
  setDefaultTimeout(60_000);
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line);
  let tmp: string;
  let repo: string;
  let log: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "line-scripts-"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    spawnSync("git", ["init", "-q", repo]);
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    log = path.join(tmp, "cast.log");
    fs.writeFileSync(path.join(bin, "cast"), `#!/bin/bash\nif [ "$1 $2" = "ws path" ]; then echo "${repo}"; exit 0; fi\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "${log}"\necho --- >> "${log}"\n`, { mode: 0o755 });
    env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const runDir = () => path.join(tmp, "run-files");
  // As the runner runs a station: the profile's values in the context, the
  // script expanded, and the run values a profile command names in its env.
  const run = (id: string, context: Record<string, string>) => {
    const ctx = { worktree: "line-ct-1", task_id: "ct-1", default_branch: "main", run_dir: runDir(), ...EMPTY_VARS, ...context };
    const r = spawnSync("bash", ["-c", expandScriptVars(graph.nodes.get(id)!.script!, ctx)], { cwd: tmp, env: { ...env, ...lineCommandEnv(ctx) }, encoding: "utf-8" });
    return { code: r.status, out: r.stdout, json: extractJsonOutput(r.stdout) as any };
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf-8").split("---\n").filter(Boolean).map((c) => c.trimEnd().split("\n")) : []);

  test("red: no reproduction, a passing one, and a failing one", () => {
    const none = run("red", { category: "code" });
    expect(none.code).toBe(0);
    expect(none.json).toEqual({ red: false, dir: runDir(), why: "no repro.sh" });
    fs.writeFileSync(path.join(runDir(), "repro.sh"), "exit 0\n");
    expect(run("red", { category: "code" }).json.red).toBe(false);
    fs.writeFileSync(path.join(runDir(), "repro.sh"), "echo 'expected 2, got 3'; exit 1\n");
    expect(run("red", { category: "code" }).json).toEqual({ red: true, dir: runDir(), why: "repro.sh fails" });
    expect(fs.readFileSync(path.join(runDir(), "red.log"), "utf-8")).toBe("expected 2, got 3\n");
    expect(calls()).toEqual([]);
  });

  test("red for a line cause: the recorded runs prove_line names must hold against the records, and a rerunnable check must fail", () => {
    // `cast line proof-check` holds when the proof file exists here; the real check is lineProof.test.ts.
    fs.writeFileSync(path.join(tmp, "bin", "cast"), `#!/bin/bash\nif [ "$1 $2" = "ws path" ]; then echo "${repo}"; exit 0; fi\nif [ "$1 $2" = "line proof-check" ]; then [ -f "$3" ] && { echo "holds: 1 recorded run shows it"; exit 0; }; echo "no $3"; exit 1; fi\n`, { mode: 0o755 });
    const missing = run("red", { category: "line" });
    expect(missing.code).toBe(0);
    expect(missing.json.red).toBe(false);
    expect(missing.json.why).toStartWith("the flow proof does not hold: no ");
    fs.mkdirSync(runDir(), { recursive: true });
    fs.writeFileSync(path.join(runDir(), "line-proof.json"), '{"runs":[]}');
    expect(run("red", { category: "line" }).json).toEqual({ red: true, dir: runDir(), why: "holds: 1 recorded run shows it" });
    fs.writeFileSync(path.join(runDir(), "repro.sh"), "exit 0\n");
    expect(run("red", { category: "line" }).json.red).toBe(false);
    fs.writeFileSync(path.join(runDir(), "repro.sh"), "echo 'prove has no failure edge'; exit 1\n");
    expect(run("red", { category: "line" }).json).toEqual({ red: true, dir: runDir(), why: "repro.sh fails" });
  });

  test("red for a prompt: the project's prove command shows the miss, run with the run's values; without one it passes with a note", () => {
    const prove = { category: "prompt", "line.commands.prove": 'test -s "$run_dir/freezes.txt" || { echo "no freezes for $task_id"; exit 1; }' };
    const missing = run("red", prove);
    expect(missing.code).toBe(0);
    expect(missing.json.red).toBe(false);
    expect(missing.json.why).toBe("the prove command did not show the miss on the base: no freezes for ct-1");
    fs.writeFileSync(path.join(runDir(), "freezes.txt"), "fz-1\n");
    expect(run("red", prove).json).toEqual({ red: true, dir: runDir(), why: "the prove command shows the miss on the base" });
    expect(calls()).toEqual([]);
    const none = run("red", { category: "prompt" });
    expect(none.json).toEqual({ red: true, dir: runDir(), why: "no prove command; passed with a note" });
    expect(calls()).toEqual([["task", "comment", "ct-1", "This project's flow profile names no prove command, so the prove station passed without showing the miss.", "-t", "progress"]]);
  });

  test("red for a prompt on a rerun: the branch carries the last round's fix, so the miss is shown on the merge base and the branch comes back", () => {
    const git = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf-8" }).stdout.trim();
    fs.writeFileSync(path.join(repo, "prompt.txt"), "old\n");
    git("add", "."); git("commit", "-qm", "base"); git("branch", "-M", "main");
    git("checkout", "-qb", "codecast/line-ct-1");
    fs.writeFileSync(path.join(repo, "prompt.txt"), "fixed\n");
    git("commit", "-qam", "fix");
    // The miss shows only while the prompt is the old one.
    const prove = { category: "prompt", branch: "codecast/line-ct-1", "line.commands.prove": 'grep -q old prompt.txt' };
    expect(run("red", prove).json).toEqual({ red: true, dir: runDir(), why: "the prove command shows the miss on the base" });
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("codecast/line-ct-1");
    expect(fs.readFileSync(path.join(repo, "prompt.txt"), "utf-8")).toBe("fixed\n");
    // A worktree an earlier station left detached on the base still ends on the run's branch.
    git("checkout", "-q", "--detach", "main");
    expect(run("red", prove).json.red).toBe(true);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("codecast/line-ct-1");
    // Uncommitted work is never carried to the base.
    fs.writeFileSync(path.join(repo, "prompt.txt"), "edited\n");
    expect(run("red", prove).json.why).toBe("the worktree has uncommitted changes, so it cannot go to the base to show the miss");
  });

  test("red for code on a rerun: the test prove added comes along to the base, the fix does not, and the branch comes back whole", () => {
    const git = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf-8" }).stdout.trim();
    fs.writeFileSync(path.join(repo, "sum.sh"), "echo 3\n");
    git("add", "."); git("commit", "-qm", "base"); git("branch", "-M", "main");
    git("checkout", "-qb", "codecast/line-ct-1");
    // Round one: prove commits a new test; the builder fixes the code it checks.
    fs.writeFileSync(path.join(repo, "sum.test.sh"), '[ "$(bash sum.sh)" = 4 ] || { echo "expected 4, got $(bash sum.sh)"; exit 1; }\n');
    git("add", "."); git("commit", "-qm", "test");
    fs.writeFileSync(path.join(repo, "sum.sh"), "echo 4\n");
    git("commit", "-qam", "fix");
    fs.mkdirSync(runDir(), { recursive: true });
    fs.writeFileSync(path.join(runDir(), "repro.sh"), "bash sum.test.sh\n");
    // Run on the branch, the test passes; on the base with the test, it fails as the cause describes.
    expect(run("red", { category: "code", branch: "codecast/line-ct-1" }).json).toEqual({ red: true, dir: runDir(), why: "repro.sh fails" });
    expect(fs.readFileSync(path.join(runDir(), "red.log"), "utf-8")).toBe("expected 4, got 3\n");
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("codecast/line-ct-1");
    expect(git("status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(repo, "sum.sh"), "utf-8")).toBe("echo 4\n");
  });

  test("green: writes proof.json red then green for the card, and fails while the reproduction still fails", () => {
    const dir = runDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "red.log"), 'expected "2", got 3\n');
    fs.writeFileSync(path.join(dir, "repro.name"), "sum adds two numbers\n");
    fs.writeFileSync(path.join(dir, "repro.sh"), "echo still broken; exit 1\n");
    const ctx = {};
    expect(run("green", ctx).code).toBe(1);
    expect(proofSummary(JSON.parse(fs.readFileSync(path.join(dir, "proof.json"), "utf-8"))).stillRed).toEqual(["sum adds two numbers"]);
    fs.writeFileSync(path.join(dir, "repro.sh"), "echo ok; exit 0\n");
    expect(run("green", ctx).code).toBe(0);
    const proof = JSON.parse(fs.readFileSync(path.join(dir, "proof.json"), "utf-8"));
    expect(proof).toEqual({
      before: [{ name: "sum adds two numbers", ok: false, detail: "expected 2, got 3" }],
      after: [{ name: "sum adds two numbers", ok: true, detail: "ok" }],
    });
    expect(proofSummary(proof)).toMatchObject({ red: 1, fixed: 1, stillRed: [], broke: [] });
  });

  test("green for a line cause: its red names the recorded runs the line checked; with no check to rerun it writes no proof", () => {
    const dir = runDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "line-proof.log"), "holds: 2 recorded runs show it: ct-9 run th7abcd: prove failed\n");
    const none = run("green", { category: "line" });
    expect(none.code).toBe(0);
    expect(none.out).toContain("recorded runs only");
    expect(fs.existsSync(path.join(dir, "proof.json"))).toBe(false);
    fs.writeFileSync(path.join(dir, "repro.name"), "prove has a failure edge\n");
    fs.writeFileSync(path.join(dir, "repro.sh"), "exit 0\n");
    expect(run("green", { category: "line" }).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "proof.json"), "utf-8")).before).toEqual([
      { name: "prove has a failure edge", ok: false, detail: "holds: 2 recorded runs show it: ct-9 run th7abcd: prove failed" },
    ]);
  });

  test("eval runs the project's eval command in the worktree, then cast line eval-result over the reps it wrote", () => {
    const dir = runDir();
    // A failing exit with reps written still goes to the verdict: the eval command does no statistics (LP4).
    const evalCmd = { "line.commands.eval": 'pwd > "$run_dir/where"; echo "{}" > "$run_dir/reps.json"; exit 1' };
    expect(run("eval", evalCmd).code).toBe(0);
    expect(fs.realpathSync(fs.readFileSync(path.join(dir, "where"), "utf-8").trim())).toBe(fs.realpathSync(repo));
    expect(calls()).toEqual([["line", "eval-result", "--reps", `${dir}/reps.json`, "--out", `${dir}/eval-result.json`]]);
  });

  test("eval fails when the command wrote no reps, never reading a stale file, and passes with a note when the project has none", () => {
    const dir = runDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "reps.json"), "{}\n");
    const crashed = run("eval", { "line.commands.eval": "echo boom; exit 2" });
    expect(crashed.code).toBe(2);
    expect(crashed.out).toContain(`the eval command exited 2 and wrote no ${dir}/reps.json`);
    expect(calls()).toEqual([]);
    expect(run("eval", {}).code).toBe(0);
    expect(calls()).toEqual([["task", "comment", "ct-1", "This project's flow profile names no eval command, so the eval station passed without evals and the change is unscored.", "-t", "progress"]]);
  });

  test("ship runs the project's ship command and puts the one line it prints on the task; without one it runs Ship, which never merges on its own", () => {
    const none = run("ship", {});
    expect(none.code).toBe(0);
    expect(calls()).toEqual([
      ["ship", "run", "--task", "ct-1"],
      ["task", "comment", "ct-1", "Shipping: cast ship run exited 0 and said nothing", "-t", "progress"],
    ]);
    fs.rmSync(log);
    const ok = run("ship", { branch: "codecast/line-ct-1", run_id: "run_1", "line.commands.ship": 'echo "squashing" >&2; echo; echo "merged $branch for $task_id ($run_id); deploy pending"' });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("squashing");
    const refused = run("ship", { "line.commands.ship": 'echo "not merged: no green eval gate"; exit 1' });
    expect(refused.code).toBe(1);
    expect(calls()).toEqual([
      ["task", "comment", "ct-1", "Shipped: merged codecast/line-ct-1 for ct-1 (run_1); deploy pending", "-t", "progress"],
      ["task", "comment", "ct-1", "Not shipped: not merged: no green eval gate", "-t", "blocker"],
    ]);
  });

  test("dissolve: a miss that did not reproduce, and findings that were the judge's own mistake", () => {
    expect(run("dissolve", {}).json).toEqual({ dissolved: "no_repro" });
    fs.mkdirSync(runDir(), { recursive: true });
    const moments = [
      { judge: "comms", finding: "f-1", sentence: "The reply reports no problem about a call that reached voicemail.", name: "voicemail" },
      { judge: "comms", finding: "f-2", sentence: "The reply reports no problem about a contact who went quiet.", name: "went quiet" },
    ];
    fs.writeFileSync(path.join(runDir(), "judge-defects.json"), JSON.stringify(moments, null, 1));
    const judged = run("dissolve", { run_id: "run_1" });
    expect(judged.code).toBe(0);
    expect(judged.json).toEqual({ dissolved: "judge_defect", moments: 2 });
    expect(calls()).toEqual([
      ["task", "done", "ct-1", "-m", "Dissolved: the miss did not reproduce. The evidence is in the prove comment."],
      // Each finding is marked wrong for its diagnosis (learning-loop.md LL11).
      ["signal", "judge-defects", path.join(runDir(), "judge-defects.json"), "--run=run_1"],
      ["task", "done", "ct-1", "-m", "Dissolved: the findings were the judge's own mistake. 2 moments are recorded for that judge's evals; the prove comment has the evidence."],
    ]);
  });

  test("unproven parks the cause at open with what Prove tried, leaving a hand's own handoff in review", () => {
    expect(run("unproven", { handoff: "none", "prove.output": "No test could reach the daemon's socket." }).code).toBe(0);
    expect(run("unproven", { handoff: "needs_context", "prove.output": "" }).code).toBe(0);
    // A hand that never spawned leaves no output: the run's last error stands in.
    expect(run("unproven", { handoff: "none", last_error: "spawn failed" }).code).toBe(0);
    const parked = "Parked at prove: Prove wrote no proof, so the miss was neither shown nor ruled out. Rerun the flow once it can be shown.";
    expect(calls()).toEqual([
      ["task", "update", "ct-1", "-s", "open"],
      ["task", "comment", "ct-1", `${parked} What Prove tried: No test could reach the daemon's socket.`, "-t", "blocker"],
      ["task", "comment", "ct-1", parked, "-t", "blocker"],
      ["task", "update", "ct-1", "-s", "open"],
      ["task", "comment", "ct-1", `${parked} What Prove tried: spawn failed`, "-t", "blocker"],
    ]);
  });

  test("park, drop, reopen, dissolve, watch and the card nodes call cast with the run's values", () => {
    run("park", { readiness: "needs_context", goal_ref: "in-3:activation", readiness_note: "which account?" });
    run("park", { readiness: "ready", goal_ref: "none", readiness_note: "" });
    run("drop", {});
    run("drop", { "human.message": "not worth it" });
    run("reopen", {});
    run("dissolve", {});
    run("watch", {});
    const dir = "/run/cast-line";
    expect(run("card_draft", { run_dir: dir }).code).toBe(0);
    const words = JSON.stringify({ question: "Should a title name the work?", recommend: "ship", why: "All checks are green.", page: "/run/present/page.html" });
    run("card", { run_dir: dir, "card_write.json": words });
    expect(calls()).toEqual([
      ["task", "comment", "ct-1", "Parked at ground: readiness needs_context, goal in-3:activation. which account?", "-t", "blocker"],
      ["task", "comment", "ct-1", "Parked at ground: readiness ready, goal none. ", "-t", "progress"],
      ["task", "drop", "ct-1", "-m", "Dropped at the gate."],
      ["task", "drop", "ct-1", "-m", "Dropped at the gate. not worth it"],
      ["task", "update", "ct-1", "-s", "in_progress"],
      ["task", "done", "ct-1", "-m", "Dissolved: the miss did not reproduce. The evidence is in the prove comment."],
      ["task", "update", "ct-1", "--watch-days", "7"],
      ["card", "build", "--task", "ct-1", "--dir", dir, "--base", "main", "--json"],
      ["card", "build", "--task", "ct-1", "--dir", dir, "--base", "main", "--publish", "--words", words],
    ]);
  });
});
