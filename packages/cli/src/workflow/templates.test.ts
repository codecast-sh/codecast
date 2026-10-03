// line.cast (docs/architecture/the-line.md L1, the-line-end-to-end.md LE1 to
// LE12) ships inside the binary and resolves by name. These tests parse it,
// check its stations, edges, gates and node prompts, run its station scripts
// against a scratch repo, and drive it offline through the runner's session
// path with a fake API, so the routing on the task's ground fields, handoff,
// verdict and node JSON is exercised without a daemon.
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
import type { WorkflowGraph } from "./types";

const TEMPLATE_DIR = path.join(import.meta.dir, "templates");
const AGENT_NODES = ["ground", "plan", "analyze", "prove", "implement", "review", "card_write"];
const from = (graph: WorkflowGraph, id: string) => graph.edges.filter((e) => e.from === id).map((e) => `${e.to}:${e.condition ?? ""}`);

// Union's profile as it is committed in its repo (line-profile.md LP2), and a
// repo with none: the template must run on both.
const UNION_PROFILE = `
[line]
team = "Union"
project = "Agent Quality"
principles = ["outreach/docs/line/principles.md"]
prompting = "outreach/docs/line/prompting.md"
size_budget = 400
watch_days = 7

[line.commands]
check = "bun outreach/backend/scripts/line.ts check --base $default_branch"
prove = "bun outreach/backend/scripts/line.ts prove --task $task_id --dir $run_dir"
eval  = "bun outreach/backend/scripts/line.ts eval --base $default_branch --dir $run_dir --out $run_dir/reps.json"
ship  = "bun outreach/backend/scripts/line.ts ship --task $task_id --branch $branch --run $run_id --dir $run_dir --into $default_branch"
`;
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
      "start", "exit", "ground", "park", "plan", "plan_gate", "analyze", "prove", "red", "dissolve",
      "implement", "verify", "green", "eval", "unscored", "review", "card_draft", "card_write", "card",
      "decide", "reopen", "drop", "ship", "merge", "watch",
    ]);
    // The merge step (the-line.md L12) is a script node that reports to the
    // server about this run; it exits 0 whether it merged or left it.
    expect(graph.nodes.get("merge")?.type).toBe("command");
    expect(graph.nodes.get("merge")?.script).toBe("cast line merge --run $run_id --branch $branch --into $default_branch --cwd $project_path --task $task_id");
    expect(graph.nodes.get("merge")?.timeout).toBe(600);
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
    // Every file under line/ is shipped, and every shipped file is used.
    expect(fs.readdirSync(path.join(TEMPLATE_DIR, "line")).sort()).toEqual(Object.keys(LINE_TEMPLATE_FILES).map((r) => r.slice("line/".length)).sort());
    const used = new Set([...graph.nodes.values()].flatMap((n) => [n.prompt, n.script]));
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
    expect(graph.nodes.get("prove")?.isolated).toBe(true);
    expect(graph.nodes.get("implement")?.isolated).toBe(true);
    expect(graph.nodes.get("implement")?.max_visits).toBe(3);
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
      "review_verdict", "review_note", "handoff", "goal_ref", "category", "risk", "readiness", "readiness_note",
      "assignee", "project_path", "default_branch", "run_id", "run_date", "worktree", "branch", "human_message", "goal", "outcome",
      "run_dir", ...Object.keys(EMPTY_VARS),
    ]);
    const nodeVar = /^(\w+)\.(output|outcome|json(\.\w+)*)$/;
    const texts = [graph.stack!, ...[...graph.nodes.values()].flatMap((n) => [n.prompt, n.script, n.doc, n.card])].filter(Boolean) as string[];
    const unknown = new Set<string>();
    for (const text of texts) {
      for (const [, name] of text.matchAll(/\$(\w+(?:\.\w+)*)/g)) {
        const m = name.match(nodeVar);
        if (known.has(name) || (m && graph.nodes.has(m[1]))) continue;
        // Shell locals and positionals in the station scripts.
        if (/^([a-z]+|\d)$/.test(name) && texts.some((t) => t.includes(`${name}=`) || /^\d$/.test(name) || t.includes(`read -r ${name}`))) continue;
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
    expect([...fromStart].filter((id) => !toExit.has(id))).toEqual([]);
    // Only exit is a dead end.
    expect([...graph.nodes.keys()].filter((id) => id !== "exit" && next(id).length === 0)).toEqual([]);
  });

  test("the gates offer valid options: every edge labeled, unique keys, each with what happens", () => {
    const gates = [...graph.nodes.values()].filter((n) => n.type === "human");
    expect(gates.map((g) => g.id)).toEqual(["plan_gate", "decide"]);
    const options = (id: string) => graph.edges.filter((e) => e.from === id).map((e) => ({ ...parseGateEdgeLabel(e.label ?? ""), to: e.to, condition: e.condition }));
    for (const gate of gates) {
      const opts = options(gate.id);
      expect(opts.every((o) => o.condition === undefined && /^\[[A-Z]\] \w+$/.test(o.label) && !!o.description)).toBe(true);
      expect(new Set(opts.map((o) => o.key)).size).toBe(opts.length);
      expect(gate.prompt).toBeTruthy();
      expect(gate.category).toBeTruthy();
    }
    expect(options("plan_gate").map((o) => `${o.key}:${o.to}`)).toEqual(["A:analyze", "R:plan", "D:drop"]);
    expect(options("decide").map((o) => `${o.key}:${o.to}`)).toEqual(["S:ship", "R:reopen", "D:drop"]);
    expect(graph.nodes.get("decide")?.card).toBe("$run_dir/card.json");
    expect(from(graph, "reopen")).toEqual(["implement:"]);
    expect(from(graph, "drop")).toEqual(["exit:"]);
  });

  test("the decision stack groups one line's gates by day (LE11)", () => {
    const payload = gatePayload(graph.nodes.get("decide")!, graph, {
      assignee: "Infra lead", run_date: "2026-10-02", task_title: "Titles copy the opener",
      "card_write.json": JSON.stringify({ wrong: "W.", change: "C.", recommend: "ship", why: "Y." }),
      run_dir: "/nonexistent/cast-line",
    });
    expect(payload.stack).toBe("Line · Infra lead · 2026-10-02");
    expect(payload.prompt).toBe("Ship this change? Titles copy the opener");
    expect(payload.doc_md).toBe("What is wrong: W.\n\nWhat this changes: C.\n\nRecommends ship: Y.");
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

  test("prove and red route on node JSON: no reproduction dissolves, no red check goes back to prove", () => {
    expect(fired("prove", { "prove.json": '{"reproduced":true}' })).toEqual(["red"]);
    expect(fired("prove", { "prove.json": '{"reproduced":false}' })).toEqual(["dissolve"]);
    expect(fired("prove", {})).toEqual([]);
    expect(fired("red", { "red.json": '{"red":true,"dir":"/d"}' })).toEqual(["implement"]);
    expect(fired("red", { "red.json": '{"red":false,"dir":"/d"}' })).toEqual(["prove"]);
    expect(fired("red", {})).toEqual(["prove"]);
  });

  test("after verify: code proves green, then every change meets the eval station, which owns its scope", () => {
    expect(fired("verify", { outcome: "success", category: "code" })).toEqual(["green"]);
    expect(fired("verify", { outcome: "success", category: "prompt" })).toEqual(["eval"]);
    expect(fired("verify", { outcome: "failure", category: "code" })).toEqual(["implement"]);
    expect(fired("green", { outcome: "failure" })).toEqual(["implement"]);
    expect(fired("green", { outcome: "success" })).toEqual(["eval"]);
    expect(fired("eval", { outcome: "failure", "eval.exit_code": "1" })).toEqual(["implement"]);
    // No verdict on the change (no reps, nothing scored) is not the builder's to fix.
    expect(fired("eval", { outcome: "failure", "eval.exit_code": "2" })).toEqual(["unscored"]);
    expect(fired("eval", { outcome: "success" })).toEqual(["review"]);
  });

  test("review keeps its verdict routing; approve goes to the card; a refused card goes back to its writer", () => {
    expect(from(graph, "implement")).toEqual(["verify:handoff = done"]);
    expect(from(graph, "review")).toEqual(["card_draft:review_verdict = approve", "implement:review_verdict = changes", "exit:review_verdict = reject"]);
    expect(graph.nodes.get("review")?.reviewer).toBe(true);
    expect(graph.nodes.get("implement")?.reviewer).toBeUndefined();
    expect(from(graph, "card_draft")).toEqual(["card_write:"]);
    expect(from(graph, "card")).toEqual(["decide:outcome = success", "card_write:outcome = failure"]);
    // A merge left to a person exits 0 and goes on to watch (the task carries
    // the blocker); a merge step that crashed ends the run as failed.
    expect(from(graph, "merge")).toEqual(["watch:outcome = success"]);
    expect(from(graph, "watch")).toEqual(["exit:"]);
    expect(graph.nodes.get("watch")?.script).toBe("cast task update $task_id --watch-days $line.watch_days");
  });

  test("ship: a project's ship command lands it and the run watches; without one the merge step lands it; a refused ship ends the run", () => {
    expect(fired("ship", { outcome: "success", ...EMPTY_VARS })).toEqual(["merge"]);
    expect(fired("ship", { outcome: "success", ...UNION_VARS })).toEqual(["watch"]);
    expect(fired("ship", { outcome: "failure", ...UNION_VARS })).toEqual(["exit"]);
    expect(fired("ship", { outcome: "failure", ...EMPTY_VARS })).toEqual(["exit"]);
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
    expect(calls()).toEqual([["task", "comment", "ct-1", "This project's line profile names no prove command, so the prove station passed without showing the miss.", "-t", "progress"]]);
  });

  test("red for a prompt on a rerun: the branch carries the last round's fix, so the miss is shown on the merge base and the branch comes back", () => {
    const git = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf-8" }).stdout.trim();
    fs.writeFileSync(path.join(repo, "prompt.txt"), "old\n");
    git("add", "."); git("commit", "-qm", "base"); git("branch", "-M", "main");
    git("checkout", "-qb", "codecast/line-ct-1");
    fs.writeFileSync(path.join(repo, "prompt.txt"), "fixed\n");
    git("commit", "-qam", "fix");
    // The miss shows only while the prompt is the old one.
    const prove = { category: "prompt", "line.commands.prove": 'grep -q old prompt.txt' };
    expect(run("red", prove).json).toEqual({ red: true, dir: runDir(), why: "the prove command shows the miss on the base" });
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("codecast/line-ct-1");
    expect(fs.readFileSync(path.join(repo, "prompt.txt"), "utf-8")).toBe("fixed\n");
    // Uncommitted work is never carried to the base.
    fs.writeFileSync(path.join(repo, "prompt.txt"), "edited\n");
    expect(run("red", prove).json.why).toBe("the worktree has uncommitted changes, so it cannot go to the base to show the miss");
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
    expect(calls()).toEqual([["task", "comment", "ct-1", "This project's line profile names no eval command, so the eval station passed without evals.", "-t", "progress"]]);
  });

  test("ship runs the project's ship command and puts the one line it prints on the task; without one the merge step lands it", () => {
    const none = run("ship", {});
    expect(none.code).toBe(0);
    expect(none.out).toContain("no ship command");
    expect(calls()).toEqual([]);
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
    run("card", { run_dir: dir, "card_write.json": JSON.stringify({ wrong: "Titles copy the greeting.", change: "Titles name the work.", recommend: "ship", why: "All checks are green." }) });
    expect(calls()).toEqual([
      ["task", "comment", "ct-1", "Parked at ground: readiness needs_context, goal in-3:activation. which account?", "-t", "blocker"],
      ["task", "comment", "ct-1", "Parked at ground: readiness ready, goal none. ", "-t", "progress"],
      ["task", "drop", "ct-1", "-m", "Dropped at the gate."],
      ["task", "drop", "ct-1", "-m", "Dropped at the gate. not worth it"],
      ["task", "update", "ct-1", "-s", "in_progress"],
      ["task", "done", "ct-1", "-m", "Dissolved: the miss did not reproduce. The evidence is in the prove comment."],
      ["task", "update", "ct-1", "--watch-days", "7"],
      ["card", "build", "--task", "ct-1", "--dir", dir, "--base", "main", "--json"],
      ["card", "build", "--task", "ct-1", "--dir", dir, "--base", "main", "--publish",
        "--wrong", "Titles copy the greeting.", "--change", "Titles name the work.", "--recommend", "ship", "--why", "All checks are green."],
    ]);
  });
});

// ── Offline runs through the session path ────────────────────────────────────
// Every hand settles at once and writes what the real hand would through the
// CLI; command nodes that reach git, evals or the server are stubbed with the
// output their scripts print (their own behavior is tested above).
const offlineLine = (dir: string) => {
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line);
  const stub = (id: string, script: string) => { graph.nodes.get(id)!.script = script; };
  stub("red", `echo '{"red": true, "dir": "${dir}"}'`);
  stub("green", "true");
  stub("eval", "true");
  stub("card_draft", `echo '{"card": {"wrong": ""}}'`);
  for (const id of ["card", "ship", "merge", "watch", "park", "dissolve", "reopen", "drop"]) stub(id, "true");
  graph.nodes.get("verify")!.script = "true";
  return graph;
};

type Station = "ground" | "plan" | "analyze" | "prove" | "implement" | "review" | "card_write";
const STATION_OF: Array<[RegExp, Station]> = [
  [/^You ground one cause/m, "ground"],
  [/^You write the plan/m, "plan"],
  [/acceptance criteria an independent reviewer/, "analyze"],
  [/^You show the miss/m, "prove"],
  [/Implement task/, "implement"],
  [/You are the independent reviewer/, "review"],
  [/^You write the words/m, "card_write"],
];

describe("line.cast offline run through the session path", () => {
  let tmpDir: string;
  let origFetch: typeof fetch;
  let origLog: typeof console.log;
  let calls: Array<{ route: string; body: any }>;
  let task: any;
  let spawnCount: number;
  let stationOf: Record<string, Station>;
  // What each station's hand pins as its state (the runner reads node JSON from it).
  let pinned: Partial<Record<Station, string>>;
  let gateAnswers: string[];
  let effects: Partial<Record<Station, () => void>>;

  const grounded = { readiness: "ready", goal_ref: "in-3:activation", category: "code", risk: "low" };
  const opts = (extra: Record<string, any> = {}) => ({ cwd: tmpDir, taskId: "ct-7", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1, ...extra });
  const spawns = () => calls.filter((c) => c.route === "/cli/spawn").map((c, i) => ({ station: stationOf[`conv_${i + 1}`], ...c.body }));
  const stations = () => spawns().map((s) => s.station);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "line-"));
    origFetch = globalThis.fetch;
    origLog = console.log;
    console.log = () => {};
    calls = [];
    spawnCount = 0;
    stationOf = {};
    gateAnswers = [];
    task = { short_id: "ct-7", title: "Add the thing", status: "open", steps: [], assignee: "infra-lead" };
    pinned = {
      prove: 'Showed it failing.\n```json\n{"reproduced": true}\n```',
      card_write: 'Card words.\n```json\n{"wrong": "W.", "change": "C.", "recommend": "ship", "why": "Y."}\n```',
    };
    effects = {
      ground: () => { task = { ...task, ...grounded }; },
      analyze: () => { task = { ...task, steps: [{ title: "A works" }, { title: "B works" }] }; },
      implement: () => { task = { ...task, status: "in_review", execution_status: "done" }; },
      review: () => { task = { ...task, status: "done", review_verdict: { verdict: "approve", at: Date.now() + 1 } }; },
    };
    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      const body = JSON.parse(init?.body || "{}");
      calls.push({ route, body });
      let out: any = {};
      if (route === "/cli/work/get") out = task;
      else if (route === "/cli/spawn") {
        spawnCount++;
        const id = `conv_${spawnCount}`;
        stationOf[id] = STATION_OF.find(([re]) => re.test(body.prompt))?.[1] ?? ("unknown" as Station);
        out = { conversation_id: id, short_id: `s${spawnCount}` };
      } else if (route === "/cli/inbox") {
        const id = body.session_ids[0];
        effects[stationOf[id]]?.();
        out = { sessions: [{ id, work_state: "done", is_live: false }] };
      } else if (route === "/cli/sessions/state/get") {
        out = { ok: true, status: "done", state: pinned[stationOf[body.session]] ?? null };
      } else if (route === "/cli/workflow-runs/poll-gate") {
        out = { status: "paused", gate_response: gateAnswers.shift() ?? null };
      } else if (route === "/cli/work/update" || route === "/cli/work/comment" || route === "/cli/decide") out = { success: true, id: "sd-1" };
      return new Response(JSON.stringify(out), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    fs.rmSync(tmpDir, { recursive: true });
  });

  test("a grounded code cause runs every hand in order, asks Ship on the card, merges and watches", async () => {
    gateAnswers = ["S"];
    const graph = offlineLine(tmpDir);
    const outcome = await runWorkflow(graph, opts({ runId: "run_1", spawnerSession: "owner-sess" }));
    expect(outcome).toBe("completed");
    expect(stations()).toEqual(["ground", "analyze", "prove", "implement", "review", "card_write"]);
    const s = spawns();
    expect(s[0].prompt).toContain("UNATTENDED run");
    expect(s[0].prompt).toContain("cast goals --brief");
    expect(s[1].prompt).toContain("cast task update ct-7 --steps -");
    // prove and implement share the line's worktree and branch.
    for (const hand of [s[2], s[3]]) {
      expect(hand.isolated).toBe(true);
      expect(hand.worktree_name).toBe("line-ct-7");
      expect(typeof hand.device).toBe("string");
    }
    // $run_dir is set by the runner before the first node, the same for every station.
    expect(s[3].prompt).toContain(`${lineRunDir(tmpDir, "line-ct-7")}/repro.sh`);
    // The review station is the task's reviewer, never the running role's
    // hand: review_for_task instead of spawner_session (the-line.md L3).
    expect(s[4].review_for_task).toBe("ct-7");
    expect(s[4].spawner_session).toBeUndefined();
    expect(s[3].spawner_session).toBe("owner-sess");
    expect(s[4].prompt).toContain("Branch: codecast/line-ct-7");
    expect(s[4].prompt).toContain("- A works\n- B works");
    expect(s[4].prompt).toContain("Add the thing");
    expect(s[5].prompt).toContain('{"wrong":""}');
    expect(s.every((x) => x.agent_type === "claude_code")).toBe(true);
    const gate = calls.find((c) => c.route === "/cli/workflow-runs/gate")!.body;
    expect(gate).toMatchObject({ node_id: "decide", prompt: "Ship this change? Add the thing", category: "review" });
    expect(gate.stack).toMatch(/^Line · infra-lead · \d{4}-\d{2}-\d{2}$/);
    expect(gate.doc_md).toBe("What is wrong: W.\n\nWhat this changes: C.\n\nRecommends ship: Y.");
    expect(gate.choices.map((c: any) => [c.key, c.target])).toEqual([["S", "ship"], ["R", "reopen"], ["D", "drop"]]);
    const ran = calls.filter((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_status === "completed").map((c) => c.body.node_id);
    expect(ran.slice(-4)).toEqual(["ship", "merge", "watch", "exit"]);
  }, 30000);

  test("the runner loads the repo's profile once: a project with a ship command ships and watches without the merge step", async () => {
    spawnSync("git", ["init", "-q", tmpDir]);
    fs.mkdirSync(path.join(tmpDir, ".codecast"));
    fs.writeFileSync(path.join(tmpDir, ".codecast", "line.toml"), UNION_PROFILE);
    gateAnswers = ["S"];
    const outcome = await runWorkflow(offlineLine(tmpDir), opts({ runId: "run_1" }));
    expect(outcome).toBe("completed");
    const s = spawns();
    expect(s.find((x) => x.station === "implement")!.prompt).toContain("outreach/docs/line/principles.md");
    const ran = calls.filter((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_status === "completed").map((c) => c.body.node_id);
    expect(ran.slice(-3)).toEqual(["ship", "watch", "exit"]);
    expect(ran).not.toContain("merge");
  }, 30000);

  test("a malformed profile stops the run before any hand starts", async () => {
    spawnSync("git", ["init", "-q", tmpDir]);
    fs.mkdirSync(path.join(tmpDir, ".codecast"));
    fs.writeFileSync(path.join(tmpDir, ".codecast", "line.toml"), "[line]\nsize_budjet = 400\n");
    const origErr = console.error;
    console.error = () => {};
    try {
      expect(await runWorkflow(offlineLine(tmpDir), opts())).toBe("invalid");
    } finally {
      console.error = origErr;
    }
    expect(spawns()).toEqual([]);
  }, 30000);

  test("a Revise note reaches the builder once, and no later hand sees it", async () => {
    gateAnswers = ["R: keep the old flag", "S"];
    const outcome = await runWorkflow(offlineLine(tmpDir), opts({ runId: "run_1" }));
    expect(outcome).toBe("completed");
    expect(stations()).toEqual(["ground", "analyze", "prove", "implement", "review", "card_write", "implement", "review", "card_write"]);
    const s = spawns();
    expect(s[6].prompt).toContain("# Human Instructions\nkeep the old flag");
    expect(s.filter((x) => x.prompt.includes("keep the old flag"))).toHaveLength(1);
  }, 30000);

  test("a cause ground parks never builds", async () => {
    effects.ground = () => { task = { ...task, ...grounded, goal_ref: "none" }; };
    const outcome = await runWorkflow(offlineLine(tmpDir), opts());
    expect(outcome).toBe("completed");
    expect(stations()).toEqual(["ground"]);
  });

  test("plan risk stops at the plan gate; Drop closes the cause without building", async () => {
    effects.ground = () => { task = { ...task, ...grounded, risk: "plan" }; };
    pinned.plan = "Approach: one table.";
    gateAnswers = ["D"];
    const outcome = await runWorkflow(offlineLine(tmpDir), opts({ runId: "run_1" }));
    expect(outcome).toBe("completed");
    expect(stations()).toEqual(["ground", "plan"]);
    const gate = calls.find((c) => c.route === "/cli/workflow-runs/gate")!.body;
    expect(gate).toMatchObject({ node_id: "plan_gate", category: "approach", doc_md: "work_state: done\nApproach: one table." });
    expect(gate.choices.map((c: any) => c.key)).toEqual(["A", "R", "D"]);
  }, 30000);

  test("a miss that does not reproduce dissolves the cause", async () => {
    pinned.prove = 'Could not reproduce.\n```json\n{"reproduced": false}\n```';
    const outcome = await runWorkflow(offlineLine(tmpDir), opts());
    expect(outcome).toBe("completed");
    expect(stations()).toEqual(["ground", "analyze", "prove"]);
  });

  test("a review round with no fresh verdict fails the run and returns the task to open with a comment", async () => {
    effects.review = () => { task = { ...task, review_verdict: undefined }; };
    const outcome = await runWorkflow(offlineLine(tmpDir), opts());
    expect(outcome).toBe("failed");
    expect(calls.find((c) => c.route === "/cli/work/update")?.body).toMatchObject({ short_id: "ct-7", status: "open" });
    const comment = calls.find((c) => c.route === "/cli/work/comment")?.body;
    expect(comment?.comment_type).toBe("blocker");
    expect(comment?.text).toContain("no outgoing edge from review");
  });

  test("a hand that never settles is killed and the task returns to open", async () => {
    const settle = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith("/cli/inbox")) {
        calls.push({ route: "/cli/inbox", body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ sessions: [{ id: "conv_1", work_state: "working", is_live: true }] }), { status: 200 });
      }
      return settle(url, init);
    }) as typeof fetch;
    const outcome = await runWorkflow(offlineLine(tmpDir), opts({ agentTimeout: 30 }));
    expect(outcome).toBe("failed");
    expect(calls.some((c) => c.route === "/cli/sessions/kill" && c.body.session === "conv_1")).toBe(true);
    expect(calls.find((c) => c.route === "/cli/work/update")?.body).toMatchObject({ short_id: "ct-7", status: "open" });
    expect(calls.find((c) => c.route === "/cli/work/comment")?.body.text).toContain("killed");
    expect(calls.filter((c) => c.route === "/cli/spawn")).toHaveLength(1);
  }, 30000);

  test("a hand parked on a usage limit is waited out, not read as settled", async () => {
    const settle = globalThis.fetch;
    let parkedPolls = 0;
    globalThis.fetch = (async (url: any, init: any) => {
      const body = JSON.parse(init?.body || "{}");
      if (String(url).endsWith("/cli/inbox") && stationOf[body.session_ids?.[0]] === "prove" && parkedPolls < 3) {
        parkedPolls++;
        calls.push({ route: "/cli/inbox", body });
        return new Response(JSON.stringify({ sessions: [{ id: body.session_ids[0], work_state: "needs_input", is_live: true, blocked_on: "limit" }] }), { status: 200 });
      }
      return settle(url, init);
    }) as typeof fetch;
    gateAnswers = ["S"];
    const outcome = await runWorkflow(offlineLine(tmpDir), opts({ runId: "run_1" }));
    expect(parkedPolls).toBe(3);
    expect(outcome).toBe("completed");
    expect(stations()).toContain("implement");
  });

  test("the review hand receives only the branch, title and criteria: no context or error appendix", async () => {
    const graph = offlineLine(tmpDir);
    // verify fails once so a last_error exists when review runs
    graph.nodes.get("verify")!.script = "test -f ok && exit 0; touch ok; echo boom; exit 1";
    task.description = "SECRET DESCRIPTION";
    effects.review = () => { task = { ...task, status: "open", review_verdict: { verdict: "reject", at: Date.now() + 1 } }; };
    const outcome = await runWorkflow(graph, opts());
    expect(outcome).toBe("completed");
    const review = spawns().find((s) => s.station === "review")!.prompt as string;
    expect(review).toContain("Branch: codecast/line-ct-7");
    expect(review).toContain("Add the thing");
    expect(review).toContain("- A works\n- B works");
    expect(review).not.toContain("SECRET DESCRIPTION");
    expect(review).not.toContain("# Context");
    expect(review).not.toContain("# Last Error");
    expect(review).not.toContain("boom");
    expect(review).not.toContain("session_id");
  }, 30000);

  test("a blocked handoff stops the run, keeps the task in review, and queues a decision to the run's owner", async () => {
    effects.implement = () => { task = { ...task, status: "in_review", execution_status: "blocked" }; };
    const outcome = await runWorkflow(offlineLine(tmpDir), opts({ spawnerSession: "owner-sess" }));
    expect(outcome).toBe("failed");
    expect(stations()).toEqual(["ground", "analyze", "prove", "implement"]);
    expect(calls.some((c) => c.route === "/cli/work/update")).toBe(false); // left where the hand parked it
    const decision = calls.find((c) => c.route === "/cli/decide")?.body;
    expect(decision).toMatchObject({ session_id: "owner-sess", task: "ct-7", blocking: true });
    expect(decision.question).toContain("Add the thing");
    expect(calls.find((c) => c.route === "/cli/work/comment")?.body.text).toContain("handed off blocked");
  }, 30000);

  test("a hand that ends with no handoff returns the task to open", async () => {
    effects.implement = () => { task = { ...task, status: "in_progress", execution_status: undefined }; };
    const outcome = await runWorkflow(offlineLine(tmpDir), opts());
    expect(outcome).toBe("failed");
    expect(stations()).toEqual(["ground", "analyze", "prove", "implement"]);
    expect(calls.find((c) => c.route === "/cli/work/update")?.body).toMatchObject({ short_id: "ct-7", status: "open" });
  }, 30000);

  test("a reject verdict completes the run and queues a decision with the reviewer's note", async () => {
    effects.review = () => { task = { ...task, status: "open", execution_status: "blocked", review_verdict: { verdict: "reject", note: "criterion B unmet", at: Date.now() + 1 } }; };
    const outcome = await runWorkflow(offlineLine(tmpDir), opts({ spawnerSession: "owner-sess" }));
    expect(outcome).toBe("completed");
    const decision = calls.find((c) => c.route === "/cli/decide")?.body;
    expect(decision?.question).toContain("review rejected");
    expect(decision?.context_md).toContain("criterion B unmet");
    expect(calls.find((c) => c.route === "/cli/work/comment")?.body.text).toContain("Decision queued");
  }, 30000);

  test("without an owning session the reject comment says no decision was queued", async () => {
    effects.review = () => { task = { ...task, status: "open", execution_status: "blocked", review_verdict: { verdict: "reject", at: Date.now() + 1 } }; };
    await runWorkflow(offlineLine(tmpDir), opts());
    expect(calls.some((c) => c.route === "/cli/decide")).toBe(false);
    expect(calls.find((c) => c.route === "/cli/work/comment")?.body.text).toContain("No decision queued");
  }, 30000);

  test("retries exhausted parks the task in review as blocked", async () => {
    const graph = offlineLine(tmpDir);
    graph.nodes.get("verify")!.script = "false";
    const outcome = await runWorkflow(graph, opts({ spawnerSession: "owner-sess" }));
    expect(outcome).toBe("failed");
    expect(stations()).toEqual(["ground", "analyze", "prove", "implement", "implement", "implement"]);
    expect(calls.find((c) => c.route === "/cli/work/update")?.body).toMatchObject({ short_id: "ct-7", status: "in_review", execution_status: "blocked" });
    expect(calls.find((c) => c.route === "/cli/work/comment")?.body.text).toContain("retries exhausted");
    expect(calls.find((c) => c.route === "/cli/decide")?.body.question).toContain("retries exhausted");
  }, 30000);
});
