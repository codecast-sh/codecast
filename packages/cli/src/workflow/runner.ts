import { FOREIGN_TEXT_CAPS, capForeignText, escapeForeignControlChars, inlineForeignText, fromConvexAgentType, toConvexAgentType, resolveAgentLaunch, type AgentDefinitionSpec } from "@codecast/shared/contracts";
import { definitionLaunchFlags } from "../agentLaunch.js";
import { countingSemaphore } from "../semaphore.js";
import { WorkflowGraph, WorkflowNode, WorkflowRunState, NodeOutcome } from "./types";
import { spawnSync } from "../proc.js";
import { applyUnattended } from "../unattended.js";
import { deviceId } from "../remote/device.js";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { c } from "../colors.js";

// ─── Condition evaluator ──────────────────────────────────

function evalCondition(condition: string, context: Record<string, string>): boolean {
  // Substitute context values
  const expanded = condition.replace(/\b([a-zA-Z_][a-zA-Z0-9_.]*)\b/g, (match) => {
    return context[match] !== undefined ? context[match] : match;
  });

  // Simple condition patterns
  const eqMatch = expanded.match(/^(\S+)\s*=\s*(\S+)$/);
  if (eqMatch) return eqMatch[1] === eqMatch[2];

  const neqMatch = expanded.match(/^(\S+)\s*!=\s*(\S+)$/);
  if (neqMatch) return neqMatch[1] !== neqMatch[2];

  const containsMatch = expanded.match(/^(\S+)\s+contains\s+(\S+)$/i);
  if (containsMatch) return containsMatch[1].includes(containsMatch[2]);

  return false;
}

function resolveNextNode(
  graph: WorkflowGraph,
  current: WorkflowNode,
  context: Record<string, string>
): WorkflowNode | null {
  const outEdges = graph.edges
    .filter(e => e.from === current.id)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0));

  // First pass: edges with conditions
  const conditional = outEdges.filter(e => e.condition);
  for (const edge of conditional) {
    if (evalCondition(edge.condition!, context)) {
      const node = graph.nodes.get(edge.to);
      if (node) return node;
    }
  }

  // Second pass: unconditional edges (if no condition matched)
  const unconditional = outEdges.filter(e => !e.condition);
  for (const edge of unconditional) {
    // If there were conditional edges and none matched, skip unconditional
    if (conditional.length > 0) continue;
    const node = graph.nodes.get(edge.to);
    if (node) return node;
  }

  // If all edges were conditional and none matched, fall through to unconditional
  if (conditional.length > 0) {
    for (const edge of unconditional) {
      const node = graph.nodes.get(edge.to);
      if (node) return node;
    }
  }

  return null;
}

// ─── Node handlers ────────────────────────────────────────

// $var in a script expands like $var in a prompt, but each value is
// single-quoted so a task title with shell metacharacters stays data. `$(`
// and `${` are left to the shell (no \w follows the `$`).
export function expandScriptVars(script: string, context: Record<string, string>): string {
  return script.replace(/\$(\w+)/g, (match, key) => {
    const value = context[key];
    if (value === undefined) return match;
    return `'${value.replace(/'/g, `'\\''`)}'`;
  });
}

async function executeCommand(
  node: WorkflowNode,
  context: Record<string, string>,
  cwd: string
): Promise<NodeOutcome> {
  const script = expandScriptVars(node.script!, context);
  console.log(`${c.dim}  $ ${script.split('\n')[0]}${script.includes('\n') ? '...' : ''}${c.reset}`);

  try {
    const result = spawnSync("bash", ["-c", script], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
      // A repo's check command (the line's verify station) outruns the old
      // two minute cap on most repos; a timeout read as a failed check and
      // burned an implement visit. Per node, in seconds.
      timeout: (node.timeout ?? 120) * 1000,
    });

    const output = (result.stdout || "") + (result.stderr || "");
    if (output.trim()) {
      console.log(c.dim + output.slice(0, 2000) + c.reset);
    }

    context[`${node.id}.output`] = output.trim().slice(0, 4000);
    context[`${node.id}.exit_code`] = String(result.status ?? 0);

    if (result.status === 0) {
      console.log(`  ${c.green}✓ success${c.reset}`);
      return "success";
    } else {
      console.log(`  ${c.red}✗ failed (exit ${result.status})${c.reset}`);
      context["last_error"] = output.trim().slice(0, 2000);
      return "failure";
    }
  } catch (err: any) {
    console.log(`  ${c.red}✗ error: ${err.message}${c.reset}`);
    context[`${node.id}.output`] = err.message;
    return "failure";
  }
}

function findNewestSessionId(cwd: string, afterMs: number): string | null {
  const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  const projectDirName = cwd.replace(/\//g, "-");
  const projectDir = path.join(claudeProjectsDir, projectDirName);
  if (!fs.existsSync(projectDir)) return null;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
  let newest: { id: string; mtime: number } | null = null;
  for (const f of fs.readdirSync(projectDir)) {
    if (!UUID_RE.test(f)) continue;
    const stat = fs.statSync(path.join(projectDir, f));
    if (stat.mtimeMs >= afterMs && (!newest || stat.mtimeMs > newest.mtime)) {
      newest = { id: f.replace(".jsonl", ""), mtime: stat.mtimeMs };
    }
  }
  return newest?.id ?? null;
}

async function executeAgent(
  node: WorkflowNode,
  graph: WorkflowGraph,
  context: Record<string, string>,
  cwd: string,
  options: RunOptions
): Promise<NodeOutcome> {
  const prompt = buildNodePrompt(node, graph, context);
  const definition = await loadNodeDefinition(node, options);
  const launch = resolveAgentLaunch(definition, { agent: "claude", model: resolveModel(node, graph), effort: node.reasoning_effort }, "claude");
  const model = launch.model;

  console.log(`${c.dim}  model: ${model || "default"}${definition ? `, definition: ${definition.name}` : ""}${c.reset}`);
  if (launch.effort) {
    console.log(`${c.dim}  reasoning: ${launch.effort}${c.reset}`);
  }

  // Write prompt to a temp file so we can pass it cleanly
  const promptFile = path.join(cwd, `.cast-workflow-prompt-${node.id}.md`);
  fs.writeFileSync(promptFile, prompt);

  try {
    // Build claude command
    const args = ["claude", "--print", `@${promptFile}`, "--output-format", "text"];

    if (model) {
      args.push("--model", model);
    }
    if (launch.effort) args.push("--effort", launch.effort);
    if (definition) {
      const flags = definitionLaunchFlags(launch, "claude");
      args.push(...flags.args);
      if (flags.systemPrompt) args.push("--system-prompt", flags.systemPrompt);
      else if (flags.appendSystemPrompt) args.push("--append-system-prompt", flags.appendSystemPrompt);
    }

    if (options.autoApprove) {
      args.push("--dangerously-skip-permissions");
    }

    const beforeMs = Date.now();
    const result = spawnSync(args[0], args.slice(1), {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: options.agentTimeout || 600_000,
    });

    const sessionId = findNewestSessionId(cwd, beforeMs);

    const output = (result.stdout || "").trim();
    const stderr = (result.stderr || "").trim();

    if (output) {
      // Show last ~500 chars of output
      const preview = output.length > 500 ? "..." + output.slice(-500) : output;
      console.log(c.dim + preview + c.reset);
    }
    if (stderr && !stderr.includes("API")) {
      console.log(`${c.dim}${stderr.slice(0, 200)}${c.reset}`);
    }

    context[`${node.id}.output`] = output.slice(0, 4000);
    if (sessionId) context[`${node.id}.session_id`] = sessionId;

    if (result.status === 0) {
      console.log(`  ${c.green}✓ done${c.reset}${sessionId ? c.dim + " [" + sessionId.slice(0, 8) + "]" + c.reset : ""}`);
      return "success";
    } else {
      console.log(`  ${c.red}✗ agent failed (exit ${result.status})${c.reset}`);
      context["last_error"] = (stderr || output).slice(0, 2000);
      return "failure";
    }
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
  }
}

async function executeCliAgent(
  node: WorkflowNode,
  graph: WorkflowGraph,
  context: Record<string, string>,
  cwd: string,
  options: RunOptions
): Promise<NodeOutcome> {
  const { detectRuntime } = await import("../agents/runtime.js");
  const prompt = buildNodePrompt(node, graph, context);
  const model = resolveModel(node, graph) || "opus";
  const backend = node.backend || "claude";

  console.log(`${c.dim}  backend: ${backend}, model: ${model}${c.reset}`);

  const runtime = detectRuntime();
  const sessionName = `wf-${node.id}-${Date.now().toString(36).slice(-4)}`;

  const handle = runtime.spawn({
    sessionName,
    prompt,
    model,
    workingDir: cwd,
    taskShortId: context["task_id"] || undefined,
  });

  console.log(`  ${c.green}spawned${c.reset} ${c.dim}${sessionName}${c.reset}`);

  if (options.runId) {
    await reportProgress(options, {
      current_node_id: node.id,
      node_id: node.id,
      node_status: "running",
      session_id: sessionName,
    });
  }

  const timeout = options.agentTimeout || 1800_000;
  const startMs = Date.now();
  const pollInterval = 10_000;

  while (Date.now() - startMs < timeout) {
    await new Promise(r => setTimeout(r, pollInterval));

    if (!runtime.isAlive(handle)) {
      const output = runtime.getOutput(handle, 500);
      context[`${node.id}.output`] = output.text.slice(0, 4000);
      context[`${node.id}.session_id`] = sessionName;

      if (output.markers.status === "blocked") {
        console.log(`  ${c.red}blocked${c.reset}: ${output.markers.detail}`);
        return "failure";
      }
      if (output.markers.status === "needs_context") {
        console.log(`  ${c.yellow}needs_context${c.reset}: ${output.markers.detail}`);
        return "failure";
      }
      if (output.markers.status === "done_with_concerns") {
        console.log(`  ${c.yellow}done*${c.reset}: ${output.markers.detail}`);
        context[`${node.id}.concerns`] = output.markers.detail;
        return "success";
      }

      const text = output.text.toLowerCase();
      if (text.includes("cast task done") || text.includes("task done") || text.includes("status: done")) {
        console.log(`  ${c.green}done${c.reset}`);
        return "success";
      }

      // No explicit completion markers — check for error signals
      if (text.includes("error") || text.includes("failed") || text.includes("exit code 1")) {
        console.log(`  ${c.yellow}agent exited (possible failure)${c.reset}`);
        context["last_error"] = output.text.slice(-2000);
        return "failure";
      }
      console.log(`  ${c.dim}agent exited${c.reset}`);
      return "success";
    }

    const elapsed = Math.round((Date.now() - startMs) / 60_000);
    if (elapsed > 0 && elapsed % 5 === 0) {
      console.log(`${c.dim}  ... ${elapsed}m elapsed${c.reset}`);
    }
  }

  console.log(`  ${c.red}timeout${c.reset} after ${Math.round(timeout / 60_000)}m`);
  runtime.kill(handle);
  return "failure";
}

// A node's `definition=<name>` resolved once per run through the CLI token.
const definitionCache = new Map<string, AgentDefinitionSpec | null>();
async function loadNodeDefinition(node: WorkflowNode, options: RunOptions): Promise<AgentDefinitionSpec | undefined> {
  if (!node.definition) return undefined;
  if (!definitionCache.has(node.definition)) {
    const def = await cliCall(options, "/cli/agents/resolve", { name: node.definition });
    definitionCache.set(node.definition, def ?? null);
    if (!def) console.log(`  ${c.yellow}definition "${node.definition}" not found; running without it${c.reset}`);
  }
  return definitionCache.get(node.definition) ?? undefined;
}

// One POST to a /cli route with the run's token; null on any failure so the
// runner degrades instead of throwing mid-graph.
async function cliCall(options: RunOptions, route: string, body: Record<string, any>): Promise<any | null> {
  if (!options.convexSiteUrl || !options.apiToken) return null;
  try {
    const resp = await fetch(`${options.convexSiteUrl}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: options.apiToken, ...body }),
    });
    const data = await resp.json() as any;
    if (!resp.ok || data?.error) return null;
    return data;
  } catch {
    return null;
  }
}

// A session node (backend=session) is a hand: a real codecast session started
// through /cli/spawn exactly as `cast spawn --unattended` starts one, so it is
// inbox visible, reachable with cast send/read, and bound by the unattended
// mandate (the-line.md L4). The runner then waits for it to settle: done or
// needs_input, killed, or its process gone. A hand that outlives the node
// timeout is killed and the node fails; runWorkflow's failure path returns the
// task to open with a comment.
async function executeSessionNode(
  node: WorkflowNode,
  graph: WorkflowGraph,
  context: Record<string, string>,
  cwd: string,
  options: RunOptions
): Promise<NodeOutcome> {
  if (!options.convexSiteUrl || !options.apiToken) {
    console.log(`  ${c.red}✗ session nodes need an authenticated CLI (cast auth)${c.reset}`);
    context["last_error"] = "not authenticated";
    return "failure";
  }
  const agent = toConvexAgentType(fromConvexAgentType(String(node.agent || "claude").toLowerCase()));
  const model = resolveModel(node, graph);
  let worktreeName: string | undefined;
  if (node.isolated) {
    // Deterministic: a second visit re-attaches to the same worktree and
    // branch, so the last round's work is what gets fixed, not redone.
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    worktreeName = `${slug(graph.name)}-${slug(context["task_id"] || `${node.id}-${Date.now().toString(36)}`)}`;
    context["worktree"] = worktreeName;
    context["branch"] = `codecast/${worktreeName}`;
  }
  const prompt = applyUnattended(buildNodePrompt(node, graph, context));
  console.log(`${c.dim}  session: ${agent}${model ? `, model ${model}` : ""}${worktreeName ? `, worktree ${worktreeName}` : ""}${c.reset}`);

  let gitRoot = cwd;
  try {
    const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    if (r.status === 0 && r.stdout.trim()) gitRoot = r.stdout.trim();
  } catch {}

  const spawned = await cliCall(options, "/cli/spawn", {
    prompt,
    project_path: cwd,
    git_root: gitRoot,
    // With a definition the server folds its client in unless the node names one.
    ...(node.definition && !node.agent ? {} : { agent_type: agent }),
    ...(node.definition ? { definition: node.definition } : {}),
    ...(model ? { model } : {}),
    // An isolated hand must run on this machine: the verify station reads
    // its worktree from here, and a hand placed elsewhere by device fallback
    // would leave verify checking nothing.
    ...(worktreeName ? { isolated: true, worktree_name: worktreeName, device: deviceId() } : {}),
    // The review station is the task's reviewer, not the running role's hand
    // (the-line.md L3): no spawner, so the server files it under no role, and
    // review_for_task so it counts against the role's caps and its approve is
    // the outside verdict the independence rule accepts.
    ...(node.reviewer && context["task_id"]
      ? { review_for_task: context["task_id"] }
      : options.spawnerSession ? { spawner_session: options.spawnerSession } : {}),
  });
  if (!spawned?.conversation_id) {
    console.log(`  ${c.red}✗ spawn failed${c.reset}`);
    context["last_error"] = "spawn failed";
    return "failure";
  }
  const conversationId: string = spawned.conversation_id;
  const shortId: string = spawned.short_id || conversationId.slice(0, 7);
  context[`${node.id}.session_id`] = shortId;
  console.log(`  ${c.green}spawned${c.reset} ${c.cyan}${shortId}${c.reset}`);

  if (options.runId) {
    await reportProgress(options, { current_node_id: node.id, node_id: node.id, node_status: "running", session_id: shortId });
  }

  const timeout = options.agentTimeout || 1800_000;
  const startMs = Date.now();
  const pollInterval = options.pollIntervalMs ?? 10_000;
  let wasLive = false;
  let lastState = "";
  while (Date.now() - startMs < timeout) {
    await new Promise(r => setTimeout(r, pollInterval));
    const inbox = await cliCall(options, "/cli/inbox", { session_ids: [conversationId], show_all: true, limit: 5 });
    const row = (inbox?.sessions || []).find((r: any) => r.id === conversationId);
    if (!row) continue;
    const state: string = row.work_state || "idle";
    if (row.is_live) wasLive = true;
    if (state !== lastState) {
      console.log(`${c.dim}  ${shortId}: ${state}${c.reset}`);
      lastState = state;
    }
    const settled = state === "done" || state === "needs_input" || row.is_killed || (wasLive && !row.is_live);
    if (!settled) continue;
    const pinned = await cliCall(options, "/cli/sessions/state/get", { session: conversationId });
    const pinnedText: string = typeof pinned?.text === "string" ? pinned.text : (typeof pinned?.state?.text === "string" ? pinned.state.text : "");
    context[`${node.id}.output`] = `work_state: ${state}${pinnedText ? `\n${pinnedText}` : ""}`.slice(0, 4000);
    const pinnedStatus: string = pinned?.status || pinned?.state?.status || "";
    if (pinnedStatus === "blocked") {
      console.log(`  ${c.yellow}blocked${c.reset}: ${pinnedText.split("\n")[0] || "(no detail)"}`);
      context["last_error"] = pinnedText.slice(0, 2000);
      return "failure";
    }
    console.log(`  ${c.green}✓ settled${c.reset} ${c.dim}(${state})${c.reset}`);
    return "success";
  }

  console.log(`  ${c.red}timeout${c.reset} after ${Math.round(timeout / 60_000)}m — killing ${shortId}`);
  await cliCall(options, "/cli/sessions/kill", { session: conversationId });
  context["last_error"] = `hand ${shortId} killed after ${Math.round(timeout / 60_000)}m at ${node.id}`;
  context["killed_hand"] = shortId;
  return "failure";
}

/** The fanin node a fanout's branches converge on, or null. */
function findFanin(node: WorkflowNode, graph: WorkflowGraph): WorkflowNode | null {
  const branches = graph.edges.filter(e => e.from === node.id).map(e => graph.nodes.get(e.to)).filter((n): n is WorkflowNode => !!n);
  for (const b of branches) {
    const to = graph.edges.find(e => e.from === b.id)?.to;
    const n = to ? graph.nodes.get(to) : undefined;
    if (n?.type === "parallel_fanin") return n;
  }
  return null;
}

// A fanout node (shape=component) runs every node its edges point at
// concurrently, at most four at once, then continues past the fanin node
// (shape=tripleoctagon) they converge on. Each branch's output lands under
// `<id>.output` as usual, and the fanin's `<fanin>.output` is the branches'
// outputs joined under headings so the next node can read them all with one
// `$<fanin>.output`. A failed branch fails the fanout.
async function executeFanout(
  node: WorkflowNode,
  graph: WorkflowGraph,
  state: WorkflowRunState,
  cwd: string,
  options: RunOptions
): Promise<NodeOutcome> {
  const branches = graph.edges.filter(e => e.from === node.id).map(e => graph.nodes.get(e.to)).filter((n): n is WorkflowNode => !!n);
  if (branches.length === 0) {
    console.log(`  ${c.yellow}fanout has no branches${c.reset}`);
    return "success";
  }
  const fanin = findFanin(node, graph);
  console.log(`${c.dim}  ${branches.length} branches: ${branches.map(b => b.label).join(", ")}${fanin ? ` → ${fanin.label}` : ""}${c.reset}`);
  const sem = countingSemaphore(4);
  const results = await Promise.all(branches.map(branch => sem.run(async () => {
    const ctx = { ...state.context };
    let outcome: NodeOutcome;
    if (options.dryRun) outcome = "success";
    else if (branch.type === "command") outcome = await executeCommand(branch, ctx, cwd);
    else if ((branch.type === "agent" || branch.type === "prompt") && branch.backend === "session") outcome = await executeSessionNode(branch, graph, ctx, cwd, options);
    else if ((branch.type === "agent" || branch.type === "prompt") && branch.backend && branch.backend !== "builtin") outcome = await executeCliAgent(branch, graph, ctx, cwd, options);
    else if (branch.type === "agent" || branch.type === "prompt") outcome = await executeAgent(branch, graph, ctx, cwd, options);
    else outcome = "success";
    // Only the branch's own keys flow back; a shared draft would let branches
    // overwrite each other's last_error.
    for (const [k, v] of Object.entries(ctx)) {
      if (k.startsWith(`${branch.id}.`)) state.context[k] = v;
    }
    state.visitCounts[branch.id] = (state.visitCounts[branch.id] || 0) + 1;
    state.completed.push(branch.id);
    state.context[`${branch.id}.outcome`] = outcome;
    console.log(`  ${outcome === "success" ? c.green + "✓" : c.red + "✗"} ${branch.label}${c.reset}`);
    return { branch, outcome, error: ctx["last_error"] };
  })));
  const failed = results.filter(r => r.outcome !== "success");
  if (fanin) {
    state.context[`${fanin.id}.output`] = results
      .map(r => `## ${r.branch.label}\n\n${state.context[`${r.branch.id}.output`] ?? ""}`)
      .join("\n\n")
      .slice(0, 12000);
  }
  if (failed.length) {
    state.context["last_error"] = failed.map(r => `${r.branch.label}: ${r.error ?? "failed"}`).join("\n").slice(0, 2000);
    return "failure";
  }
  return "success";
}

async function executeHumanGate(
  node: WorkflowNode,
  graph: WorkflowGraph,
  context: Record<string, string>
): Promise<NodeOutcome> {
  const outEdges = graph.edges.filter(e => e.from === node.id);
  const choices = outEdges
    .filter(e => e.label)
    .map((e, i) => ({ key: extractKey(e.label!), label: e.label!, target: e.to }));

  if (choices.length === 0) {
    // No labeled choices, just wait for enter
    await waitForEnter(node.label);
    return "success";
  }

  console.log(`\n${c.bold}${c.magenta}  Human gate: ${node.label}${c.reset}`);
  for (const choice of choices) {
    console.log(`  ${c.bold}${choice.key}${c.reset} → ${choice.label.replace(/^\[.\]\s*/, "")}`);
  }

  const answer = await promptUser("  Your choice: ");
  const answerUpper = answer.trim().toUpperCase();

  const match = choices.find(c => c.key.toUpperCase() === answerUpper);
  if (match) {
    context["human.gate.selected"] = match.key;
    context["human.gate.label"] = match.label;
    context["human.gate.target"] = match.target;
    return match.key.toLowerCase();
  }

  // Default to first choice
  const first = choices[0];
  context["human.gate.selected"] = first.key;
  context["human.gate.label"] = first.label;
  context["human.gate.target"] = first.target;
  return first.key.toLowerCase();
}

async function executeRemoteHumanGate(
  node: WorkflowNode,
  graph: WorkflowGraph,
  context: Record<string, string>,
  options: RunOptions
): Promise<NodeOutcome> {
  const outEdges = graph.edges.filter(e => e.from === node.id);
  const choices = outEdges
    .filter(e => e.label)
    .map((e) => ({ key: extractKey(e.label!), label: e.label!, target: e.to }));

  console.log(`\n${c.bold}${c.magenta}  Human gate: ${node.label} (waiting for web response)${c.reset}`);

  if (choices.length === 0) {
    const response = await reportGate(options, node.id, node.label, [
      { key: "ok", label: "Continue", target: "" },
    ]);
    return response ? "success" : "failure";
  }

  const response = await reportGate(options, node.id, node.label, choices);
  if (!response) return "failure";

  // Always store the human's message as context for the next agent
  context["human.message"] = response;

  // Match: exact key, OR message starts with "key:" / "key " / "[key]" prefix
  const trimmed = response.trim();
  const match = choices.find(ch => {
    const k = ch.key.toUpperCase();
    const r = trimmed.toUpperCase();
    return r === k
      || r.startsWith(k + ":")
      || r.startsWith(k + " ")
      || r.startsWith(`[${k}]`);
  });

  if (match) {
    // Strip the key prefix from the message so the agent gets clean instructions
    const stripped = trimmed.replace(new RegExp(`^\\[?${match.key}\\]?[:\\s]*`, "i"), "").trim();
    if (stripped) context["human.message"] = stripped;
    context["human.gate.selected"] = match.key;
    context["human.gate.label"] = match.label;
    context["human.gate.target"] = match.target;
    console.log(`  ${c.green}✓ received: ${match.label}${c.reset}`);
    return match.key.toLowerCase();
  }

  // Pure free-form — route via success path (unconditional edges)
  console.log(`  ${c.green}✓ received message (free-form)${c.reset}`);
  return "success";
}

// Extract key from label like "[A] Approve" → "A"
function extractKey(label: string): string {
  const m = label.match(/^\[(.)\]/);
  return m ? m[1] : label[0];
}

async function promptUser(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

async function waitForEnter(label: string): Promise<void> {
  await promptUser(`  ${label} — press Enter to continue`);
}

// ─── Prompt building ──────────────────────────────────────

function buildNodePrompt(
  node: WorkflowNode,
  graph: WorkflowGraph,
  context: Record<string, string>
): string {
  const goal = graph.goal || "";
  const parts: string[] = [];

  if (goal) {
    parts.push(`# Goal\n${goal}\n`);
  }

  if (node.prompt) {
    // Expand $goal and context variables. Unfilled vars are removed (not left as $var).
    // `$scout.output` names a prior node's result (the runner stores every
    // node's output under `<id>.output`), so a chain of nodes can hand work on.
    const expanded = node.prompt.replace(/\$(\w+(?:\.\w+)*)/g, (_, key) => {
      if (key === "goal") return goal;
      if (key === "human_message") return context["human.message"] || "";
      return context[key] ?? "";
    });
    parts.push(`# Task: ${node.label}\n${expanded}`);
  } else {
    parts.push(`# Task: ${node.label}\n${goal ? `Complete this step of the goal: ${goal}` : node.label}`);
  }

  // Surface human message prominently if present
  if (context["human.message"]) {
    parts.push(`\n# Human Instructions\n${context["human.message"]}`);
  }

  // A hand receives only what its prompt names (the-line.md L3: the reviewer
  // sees the branch, the title and the criteria, nothing else). Builtin and
  // cli agents keep the context and last error appendix.
  if (node.backend === "session") return parts.join("\n");

  // Add relevant context
  const contextEntries = Object.entries(context)
    .filter(([k, _v]) => !k.endsWith(".output") && !["outcome", "last_error", "human.message"].includes(k))
    .slice(0, 10);
  if (contextEntries.length > 0) {
    parts.push(`\n# Context\n${contextEntries.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`);
  }

  // Add last error if present
  if (context["last_error"]) {
    parts.push(`\n# Last Error\n\`\`\`\n${context["last_error"]}\n\`\`\``);
  }

  return parts.join("\n");
}

function resolveModel(node: WorkflowNode, graph: WorkflowGraph): string | undefined {
  // Node-level model takes priority
  if (node.model) return node.model;

  // Parse model_stylesheet
  if (graph.model_stylesheet) {
    const rules = parseStylesheet(graph.model_stylesheet);
    // ID selector
    const byId = rules.find(r => r.selector === `#${node.id}`);
    if (byId?.model) return byId.model;
    // Universal
    const universal = rules.find(r => r.selector === "*");
    if (universal?.model) return universal.model;
  }

  return undefined;
}

function parseStylesheet(css: string): Array<{ selector: string; model?: string; reasoning_effort?: string }> {
  const rules: Array<{ selector: string; model?: string; reasoning_effort?: string }> = [];
  const ruleRe = /([^{]+)\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(css)) !== null) {
    const selector = m[1].trim();
    const body = m[2];
    const props: Record<string, string> = {};
    for (const prop of body.split(";")) {
      const [k, v] = prop.split(":").map(s => s.trim());
      if (k && v) props[k] = v;
    }
    rules.push({ selector, model: props.model, reasoning_effort: props.reasoning_effort });
  }
  return rules;
}

// ─── Main runner ──────────────────────────────────────────

export interface RunOptions {
  autoApprove?: boolean;
  dryRun?: boolean;
  goalOverride?: string;
  agentTimeout?: number;
  cwd?: string;
  runId?: string;
  convexSiteUrl?: string;
  apiToken?: string;
  taskId?: string;
  planId?: string;
  /** The session running the workflow; stamped as spawned_by on session nodes. */
  spawnerSession?: string;
  /** Settle poll for session nodes (tests shorten it). */
  pollIntervalMs?: number;
}

// The task fields node prompts and edge conditions read. Loaded once at start
// and again after every node, so a handoff or a verdict written by a hand is
// visible to the next edge. A verdict older than `freshSince` reads as "none":
// a review round that ended without a verdict must not re-route on the last
// round's answer.
async function loadTaskContext(options: RunOptions, context: Record<string, string>, freshSince = 0): Promise<void> {
  if (!options.taskId) return;
  const task = await cliCall(options, "/cli/work/get", { short_id: options.taskId });
  if (!task) return;
  // Why: every value here is expanded into node prompts through $vars
  // and the `# Context` list, so it is escaped and capped as it enters
  // the context rather than at each of those sites (ct-49593).
  context["task_title"] = inlineForeignText(task.title);
  context["task_description"] = capForeignText(
    escapeForeignControlChars(task.description || ""),
    FOREIGN_TEXT_CAPS.descriptionChars,
  );
  const criteria: string[] = (task.acceptance_criteria?.length ? task.acceptance_criteria : (task.steps || []).map((s: any) => s.title))
    .map((c: string) => inlineForeignText(c));
  context["acceptance_criteria"] = criteria.join("\n- ");
  context["task_status"] = String(task.status || "");
  context["execution_status"] = String(task.execution_status || "");
  const verdict = task.review_verdict;
  context["review_verdict"] = verdict && (verdict.at ?? 0) >= freshSince ? String(verdict.verdict) : "none";
  context["review_note"] = verdict?.note ? capForeignText(escapeForeignControlChars(String(verdict.note)), FOREIGN_TEXT_CAPS.descriptionChars) : "";
  // One routable value for "how did the hand end": the execution status of a
  // handoff that placed the task in review, else none. A `changes` verdict
  // moves the task to in_progress without clearing execution_status, so
  // status = in_review is the freshness signal; a hand that ended without a
  // handoff (an inline question, a decision, a crash) reads as none and no
  // edge fires, which is the failure path.
  context["handoff"] = String(task.status || "") === "in_review" ? String(task.execution_status || "none") : "none";
}

// The repo's default branch, for prompts that diff a hand's branch against it.
function detectDefaultBranch(cwd: string): string {
  try {
    const r = spawnSync("git", ["-C", cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const ref = r.status === 0 ? r.stdout.trim() : "";
    if (ref) return ref.replace(/^origin\//, "");
  } catch {}
  return "main";
}

// A person decides what happens next (the-line.md L4): a review reject or
// retries exhausted queues a blocking decision from the session that started
// the run. Without one (a daemon run with no spawner) the comment says so.
export type TaskDecisionKind = "reject" | "exhausted";
async function queueTaskDecision(options: RunOptions, context: Record<string, string>, kind: TaskDecisionKind, note: string): Promise<boolean> {
  if (!options.taskId || !options.spawnerSession) return false;
  const title = context["task_title"] || options.taskId;
  const result = await cliCall(options, "/cli/decide", {
    session_id: options.spawnerSession,
    task: options.taskId,
    question: `${title}: ${kind === "reject" ? "review rejected" : "retries exhausted"}. What next?`,
    options: [
      { label: "Reopen for another implement round" },
      { label: "Drop the task" },
      { label: "I will take it myself" },
    ],
    context_md: note.slice(0, 4000),
    blocking: true,
  });
  return !!result;
}

// The failure path for a bound task (the-line.md L4). A hand that handed off
// blocked or needs_context already parked the task in review: keep it there.
// Retries exhausted parks it in review as blocked. Anything else (a killed
// hand, a hand that ended without a handoff) returns it to open. Either way
// a blocker comment says what happened, and a parked task gets a decision.
async function returnTaskOnFailure(options: RunOptions, state: WorkflowRunState): Promise<void> {
  if (!options.taskId) return;
  const reason = state.failReason || "workflow failed";
  const exhausted = /max_visits/.test(reason);
  const handoff = state.context["handoff"];
  const parkedByHand = handoff === "blocked" || handoff === "needs_context";
  const detail = state.context["last_error"] ? `\n\n${state.context["last_error"].slice(0, 1500)}` : "";
  let text: string;
  if (parkedByHand) {
    text = `Workflow stopped: the hand handed off ${handoff} (${reason}); task left in review.${detail}`;
  } else if (exhausted) {
    await cliCall(options, "/cli/work/update", { short_id: options.taskId, status: "in_review", execution_status: "blocked" });
    text = `Workflow stopped: retries exhausted (${reason}); task left in review as blocked.${detail}`;
  } else {
    await cliCall(options, "/cli/work/update", { short_id: options.taskId, status: "open" });
    text = `Workflow failed (${reason}); task returned to open.${detail}`;
  }
  if (parkedByHand || exhausted) {
    const queued = await queueTaskDecision(options, state.context, "exhausted", text);
    if (!queued) text += "\n\nNo decision queued: the run has no owning session.";
  }
  await cliCall(options, "/cli/work/comment", { short_id: options.taskId, comment_type: "blocker", text });
}

// ─── Goal gate check (runs when exit node is reached) ────
// Mirrors Fabro: iterates all completed node outcomes, returns first failed gate node id.
function checkGoalGates(
  graph: WorkflowGraph,
  nodeOutcomes: Record<string, NodeOutcome>
): string | null {
  for (const [nodeId, outcome] of Object.entries(nodeOutcomes)) {
    const node = graph.nodes.get(nodeId);
    if (node?.goal_gate && outcome !== "success") {
      return nodeId;
    }
  }
  return null;
}

// ─── retry_target resolution ──────────────────────────────
// Node-level takes priority over graph-level (matching Fabro's 4-level priority).
function getRetryTarget(nodeId: string, graph: WorkflowGraph): WorkflowNode | null {
  const node = graph.nodes.get(nodeId);
  const targetId = node?.retry_target;
  if (targetId && graph.nodes.has(targetId)) return graph.nodes.get(targetId)!;
  return null;
}

async function reportProgress(options: RunOptions, payload: Record<string, any>): Promise<void> {
  if (!options.runId || !options.convexSiteUrl || !options.apiToken) return;
  const body = { api_token: options.apiToken, run_id: options.runId, ...payload };
  try {
    await fetch(`${options.convexSiteUrl}/cli/workflow-runs/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {}
}

async function reportGate(
  options: RunOptions,
  nodeId: string,
  prompt: string,
  choices: Array<{ key: string; label: string; target: string }>
): Promise<string | null> {
  if (!options.runId || !options.convexSiteUrl || !options.apiToken) return null;
  try {
    await fetch(`${options.convexSiteUrl}/cli/workflow-runs/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: options.apiToken,
        run_id: options.runId,
        node_id: nodeId,
        prompt,
        choices,
      }),
    });
  } catch {
    return null;
  }

  for (let i = 0; i < 3600; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const resp = await fetch(`${options.convexSiteUrl}/cli/workflow-runs/poll-gate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_token: options.apiToken, run_id: options.runId }),
      });
      const data = await resp.json() as { status?: string; gate_response?: string | null };
      if (data.gate_response) return data.gate_response;
      if (data.status !== "paused") return null;
    } catch {}
  }
  return null;
}

// Library entry point — returns the run's terminal outcome instead of touching
// process exit state. Setting process.exitCode here poisoned every consumer
// process that legitimately drives a workflow to failure: the test suite's
// failure-routing tests passed 100% yet bun exited 1 (0 fail), which tripped
// the CLI deploy gate. The CLI command wrappers translate the outcome to an
// exit code at the process boundary (src/index.ts).
export type WorkflowRunOutcome = "completed" | "failed" | "invalid";

export async function runWorkflow(graph: WorkflowGraph, options: RunOptions = {}): Promise<WorkflowRunOutcome> {
  const cwd = options.cwd || process.cwd();

  if (options.goalOverride) {
    graph.goal = options.goalOverride;
  }

  const errors = (await import("./parser")).validateWorkflow(graph);
  if (errors.length > 0) {
    console.error(`${c.red}Workflow validation errors:${c.reset}`);
    errors.forEach(e => console.error(`  ${c.red}✗ ${e}${c.reset}`));
    return "invalid";
  }

  const startNode = [...graph.nodes.values()].find(n => n.type === "start")!;

  const initialContext: Record<string, string> = {};
  initialContext["project_path"] = cwd;
  initialContext["default_branch"] = detectDefaultBranch(cwd);

  if (options.taskId) {
    initialContext["task_id"] = options.taskId;
    await loadTaskContext(options, initialContext);
  }

  if (options.planId) {
    initialContext["plan_id"] = options.planId;
    if (options.apiToken && options.convexSiteUrl) {
      try {
        const resp = await fetch(`${options.convexSiteUrl}/cli/plans/get`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_token: options.apiToken, short_id: options.planId }),
        });
        const plan = await resp.json() as any;
        if (plan && !plan.error) {
          initialContext["plan_title"] = inlineForeignText(plan.title);
          initialContext["plan_goal"] = capForeignText(
            escapeForeignControlChars(plan.goal || ""),
            FOREIGN_TEXT_CAPS.descriptionChars,
          );
          initialContext["plan_acceptance_criteria"] = (plan.acceptance_criteria || [])
            .map((c: string) => inlineForeignText(c)).join("\n- ");
        }
      } catch {}
    }
  }

  // Expand $variables in the graph goal
  if (graph.goal) {
    graph.goal = graph.goal.replace(/\$(\w+)/g, (_, key) => initialContext[key] || `$${key}`);
  }

  const state: WorkflowRunState = {
    currentNodeId: startNode.id,
    visitCounts: {},
    context: initialContext,
    completed: [],
    failed: false,
  };

  // Per-run outcome record for goal gate checking (all completed nodes)
  const nodeOutcomes: Record<string, NodeOutcome> = {};

  if (options.runId) {
    await reportProgress(options, {
      current_node_id: startNode.id,
      node_id: startNode.id,
      node_status: "running",
      run_status: "running",
    });
  }

  console.log(`\n${c.bold}${c.cyan}━━━ Workflow: ${graph.name} ━━━${c.reset}`);
  if (graph.goal) console.log(`${c.dim}Goal: ${graph.goal}${c.reset}`);
  console.log();

  let current: WorkflowNode = await runNodeLoop(startNode, graph, state, nodeOutcomes, cwd, options);

  // ── Stage 6: Exit node reached — check goal gates ─────────────────────────
  // Fabro: goal gates are only checked when reaching the exit node.
  // Any goal_gate node whose outcome is not "success" triggers retry_target on that node.
  if (current.type === "exit" && !state.failed) {
    const failedGateId = checkGoalGates(graph, nodeOutcomes);
    if (failedGateId) {
      const failedGate = graph.nodes.get(failedGateId)!;
      const retryNode = getRetryTarget(failedGateId, graph);
      if (retryNode) {
        console.log(`\n${c.yellow}  goal gate '${failedGate.label}' failed → retry_target '${retryNode.label}'${c.reset}\n`);
        // Re-enter the loop from the retry target. The initial run_status
        // "running" seed is NOT re-emitted here — it fires once per run.
        current = await runNodeLoop(retryNode, graph, state, nodeOutcomes, cwd, options);

        // Re-check goal gates after retry loop
        if (current.type === "exit") {
          const failedGate2 = checkGoalGates(graph, nodeOutcomes);
          if (failedGate2) {
            state.failed = true;
            state.failReason = `goal_gate failed on ${failedGate2} after retry`;
          }
        }
      } else {
        state.failed = true;
        state.failReason = `goal_gate failed on ${failedGateId} (no retry_target)`;
      }
    }
  }

  if (current.type === "exit" && !state.failed) {
    console.log(`\n${c.bold}${c.green}━━━ Workflow complete ━━━${c.reset}`);
    console.log(`${c.dim}Nodes: ${state.completed.join(" → ")}${c.reset}`);
    // A reject verdict ends the run but not the task: it sits at open as
    // blocked until a person decides (the-line.md L4).
    if (options.taskId && state.context["review_verdict"] === "reject") {
      const note = state.context["review_note"] ? `Reviewer note:\n${state.context["review_note"]}` : "The reviewer rejected the branch.";
      const queued = await queueTaskDecision(options, state.context, "reject", note);
      await cliCall(options, "/cli/work/comment", {
        short_id: options.taskId,
        comment_type: "blocker",
        text: `Review rejected; task left open as blocked.${queued ? " Decision queued to the run's owner." : " No decision queued: the run has no owning session."}`,
      });
    }
    if (options.runId) {
      await reportProgress(options, {
        current_node_id: current.id,
        node_id: current.id,
        node_status: "completed",
        run_status: "completed",
      });
    }

    // Log completion to bound plan
    if (options.planId && options.apiToken && options.convexSiteUrl) {
      try {
        await fetch(`${options.convexSiteUrl}/cli/plans/log`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: options.apiToken,
            short_id: options.planId,
            entry: `Workflow "${graph.name}" completed: ${state.completed.join(" → ")}`,
          }),
        });
      } catch {}
    }
  } else if (state.failed) {
    console.log(`\n${c.bold}${c.red}━━━ Workflow failed: ${state.failReason} ━━━${c.reset}`);
    await returnTaskOnFailure(options, state);
    if (options.runId) {
      await reportProgress(options, {
        current_node_id: current.id,
        node_id: current.id,
        node_status: "failed",
        run_status: "failed",
        fail_reason: state.failReason,
      });
    }
    return "failed";
  }
  return "completed";
}

// Core node-execution loop, shared by the initial pass and goal-gate retries.
// Runs from startNode until an exit node or a dead end, mutating state and
// nodeOutcomes, and returns the terminal node.
async function runNodeLoop(
  startNode: WorkflowNode,
  graph: WorkflowGraph,
  state: WorkflowRunState,
  nodeOutcomes: Record<string, NodeOutcome>,
  cwd: string,
  options: RunOptions,
): Promise<WorkflowNode> {
  let current: WorkflowNode = startNode;

  while (current.type !== "exit") {
    // ── Stage 1: Increment visit count, enforce max_visits ───────────────────
    // Fabro: checked first, before anything else. Exceeding limit = hard abort.
    // Visit counts are NEVER reset (even after retry_target jumps).
    const visits = (state.visitCounts[current.id] || 0) + 1;
    state.visitCounts[current.id] = visits;

    if (current.max_visits !== undefined && visits > current.max_visits) {
      console.log(`\n${c.red}${c.bold}  ✗ max_visits=${current.max_visits} exceeded on '${current.label}' — aborting${c.reset}`);
      state.failed = true;
      state.failReason = `max_visits=${current.max_visits} exceeded on ${current.id}`;
      break;
    }

    // ── Stage 2: Print node header ────────────────────────────────────────────
    const icon = nodeIcon(current);
    console.log(`${c.bold}${icon} ${current.label}${c.reset}${visits > 1 ? c.dim + ` (visit ${visits})` + c.reset : ""}`);

    // ── Stage 3: Execute node ─────────────────────────────────────────────────
    if (options.runId) {
      await reportProgress(options, {
        current_node_id: current.id,
        node_id: current.id,
        node_status: "running",
      });
    }

    let outcome: NodeOutcome;
    const nodeStartedAt = Date.now();

    if (options.dryRun) {
      console.log(`${c.dim}  [dry-run]${c.reset}`);
      outcome = "success";
    } else if (current.type === "start") {
      outcome = "success";
    } else if (current.type === "command") {
      outcome = await executeCommand(current, state.context, cwd);
    } else if (current.type === "human" && options.runId) {
      outcome = await executeRemoteHumanGate(current, graph, state.context, options);
    } else if (current.type === "human") {
      outcome = await executeHumanGate(current, graph, state.context);
    } else if (current.type === "parallel_fanout") {
      outcome = await executeFanout(current, graph, state, cwd, options);
    } else if (current.type === "parallel_fanin") {
      outcome = "success";
    } else if ((current.type === "agent" || current.type === "prompt") && current.backend === "session") {
      outcome = await executeSessionNode(current, graph, state.context, cwd, options);
    } else if (current.type === "agent" || current.type === "prompt") {
      const backend = current.backend || "builtin";
      if (backend !== "builtin") {
        outcome = await executeCliAgent(current, graph, state.context, cwd, options);
      } else {
        outcome = await executeAgent(current, graph, state.context, cwd, options);
      }
    } else {
      outcome = "success";
    }

    if (options.runId) {
      await reportProgress(options, {
        current_node_id: current.id,
        node_id: current.id,
        node_status: outcome === "success" ? "completed" : "failed",
        outcome,
        session_id: state.context[`${current.id}.session_id`],
      });
    }

    // A hand may have moved the task (handoff, verdict); the next edge routes
    // on the task as it is now. Verdicts older than this node read as none.
    if (options.taskId && current.type !== "start" && !options.dryRun) {
      await loadTaskContext(options, state.context, nodeStartedAt);
    }

    // ── Stage 4: Record outcome in context and per-node map ───────────────────
    state.context["outcome"] = outcome;
    state.context[`${current.id}.outcome`] = outcome;
    nodeOutcomes[current.id] = outcome;
    state.completed.push(current.id);

    // A hand killed for outliving its node is a stall, not a routable outcome
    // (the-line.md L4): the run ends here and the bound task returns to open.
    if (state.context["killed_hand"]) {
      state.failed = true;
      state.failReason = state.context["last_error"] || `hand killed at ${current.id}`;
      break;
    }

    // Log node completion to bound plan
    if (options.planId && options.apiToken && options.convexSiteUrl && current.type !== "start") {
      try {
        await fetch(`${options.convexSiteUrl}/cli/plans/log`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: options.apiToken,
            short_id: options.planId,
            entry: `Workflow node "${current.label}" ${outcome === "success" ? "completed" : "failed"}`,
          }),
        });
      } catch {}
    }

    // ── Stage 5: Select next node ─────────────────────────────────────────────
    // Priority: human gate target > conditional edges > unconditional edges >
    //           retry_target on failure with no edge > abort
    // A fanout's branches already ran inside executeFanout; the run continues
    // at the fanin they converge on, never down one branch again.
    const next = current.type === "parallel_fanout" && outcome === "success"
      ? findFanin(current, graph)
      : resolveHumanGateTarget(current, graph, state.context)
        || resolveNextNode(graph, current, state.context);

    if (!next) {
      if (outcome === "failure") {
        // Fabro: node failed with no matching outgoing edge → check retry_target
        const retryNode = getRetryTarget(current.id, graph);
        if (retryNode) {
          console.log(`${c.yellow}  no fail edge → retry_target '${retryNode.label}'${c.reset}\n`);
          current = retryNode;
          continue;
        }
      }
      console.log(`\n${c.yellow}  No outgoing edge from '${current.label}', workflow ends${c.reset}`);
      // A dead end short of exit is not a completion: nothing routed, so the
      // run (and any bound task) must not read as delivered.
      state.failed = true;
      state.failReason = `no outgoing edge from ${current.id} (outcome ${outcome}${state.context["review_verdict"] ? `, review_verdict ${state.context["review_verdict"]}` : ""})`;
      break;
    }

    console.log();
    current = next;
  }

  return current;
}

// Human gate edges use the selected key to find the right target
function resolveHumanGateTarget(
  node: WorkflowNode,
  graph: WorkflowGraph,
  context: Record<string, string>
): WorkflowNode | null {
  if (node.type !== "human") return null;
  const target = context["human.gate.target"];
  if (target && graph.nodes.has(target)) {
    // Clear for next gate
    delete context["human.gate.target"];
    return graph.nodes.get(target)!;
  }
  return null;
}

function nodeIcon(node: WorkflowNode): string {
  switch (node.type) {
    case "start": return "◆";
    case "exit": return "■";
    case "human": return "◇";
    case "command": return "▶";
    case "agent": return "◉";
    case "prompt": return "○";
    default: return "·";
  }
}
