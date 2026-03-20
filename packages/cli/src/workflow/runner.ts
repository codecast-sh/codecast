import { WorkflowGraph, WorkflowNode, WorkflowRunState, NodeOutcome } from "./types";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// ─── ANSI colors ──────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

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

async function executeCommand(
  node: WorkflowNode,
  context: Record<string, string>,
  cwd: string
): Promise<NodeOutcome> {
  const script = node.script!;
  console.log(`${c.dim}  $ ${script.split('\n')[0]}${script.includes('\n') ? '...' : ''}${c.reset}`);

  try {
    const result = spawnSync("bash", ["-c", script], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 120_000,
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
  const model = resolveModel(node, graph);

  console.log(`${c.dim}  model: ${model || "default"}${c.reset}`);
  if (node.reasoning_effort) {
    console.log(`${c.dim}  reasoning: ${node.reasoning_effort}${c.reset}`);
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
    const expanded = node.prompt.replace(/\$(\w+)/g, (_, key) => {
      if (key === "goal") return goal;
      if (key === "human_message") return context["human.message"] || "";
      return context[key] || "";
    });
    parts.push(`# Task: ${node.label}\n${expanded}`);
  } else {
    parts.push(`# Task: ${node.label}\n${goal ? `Complete this step of the goal: ${goal}` : node.label}`);
  }

  // Surface human message prominently if present
  if (context["human.message"]) {
    parts.push(`\n# Human Instructions\n${context["human.message"]}`);
  }

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

export async function runWorkflow(graph: WorkflowGraph, options: RunOptions = {}): Promise<void> {
  const cwd = options.cwd || process.cwd();

  if (options.goalOverride) {
    graph.goal = options.goalOverride;
  }

  const errors = (await import("./parser")).validateWorkflow(graph);
  if (errors.length > 0) {
    console.error(`${c.red}Workflow validation errors:${c.reset}`);
    errors.forEach(e => console.error(`  ${c.red}✗ ${e}${c.reset}`));
    process.exit(1);
  }

  const startNode = [...graph.nodes.values()].find(n => n.type === "start")!;

  const initialContext: Record<string, string> = {};
  initialContext["project_path"] = cwd;

  if (options.taskId) {
    initialContext["task_id"] = options.taskId;
    if (options.apiToken && options.convexSiteUrl) {
      try {
        const resp = await fetch(`${options.convexSiteUrl}/cli/work/get`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_token: options.apiToken, short_id: options.taskId }),
        });
        const task = await resp.json() as any;
        if (task && !task.error) {
          initialContext["task_title"] = task.title || "";
          initialContext["task_description"] = task.description || "";
          initialContext["acceptance_criteria"] = (task.acceptance_criteria || []).join("\n- ");
        }
      } catch {}
    }
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
          initialContext["plan_title"] = plan.title || "";
          initialContext["plan_goal"] = plan.goal || "";
          initialContext["plan_acceptance_criteria"] = (plan.acceptance_criteria || []).join("\n- ");
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

    // ── Stage 4: Record outcome in context and per-node map ───────────────────
    state.context["outcome"] = outcome;
    state.context[`${current.id}.outcome`] = outcome;
    nodeOutcomes[current.id] = outcome;
    state.completed.push(current.id);

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
    const next = resolveHumanGateTarget(current, graph, state.context)
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
      break;
    }

    console.log();
    current = next;
  }

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
        // Re-enter the loop from the retry target
        // (recursive call to keep state clean)
        current = retryNode;
        while (current.type !== "exit") {
          const visits2 = (state.visitCounts[current.id] || 0) + 1;
          state.visitCounts[current.id] = visits2;

          if (current.max_visits !== undefined && visits2 > current.max_visits) {
            console.log(`\n${c.red}${c.bold}  ✗ max_visits=${current.max_visits} exceeded on '${current.label}' — aborting${c.reset}`);
            state.failed = true;
            state.failReason = `max_visits=${current.max_visits} exceeded on ${current.id}`;
            break;
          }

          const icon2 = nodeIcon(current);
          console.log(`${c.bold}${icon2} ${current.label}${c.reset}${visits2 > 1 ? c.dim + ` (visit ${visits2})` + c.reset : ""}`);

          let outcome2: NodeOutcome;
          if (options.dryRun) {
            outcome2 = "success";
          } else if (current.type === "command") {
            outcome2 = await executeCommand(current, state.context, cwd);
          } else if (current.type === "human") {
            outcome2 = await executeHumanGate(current, graph, state.context);
          } else if (current.type === "agent" || current.type === "prompt") {
            const backend2 = current.backend || "builtin";
            if (backend2 !== "builtin") {
              outcome2 = await executeCliAgent(current, graph, state.context, cwd, options);
            } else {
              outcome2 = await executeAgent(current, graph, state.context, cwd, options);
            }
          } else {
            outcome2 = "success";
          }

          state.context["outcome"] = outcome2;
          state.context[`${current.id}.outcome`] = outcome2;
          nodeOutcomes[current.id] = outcome2;
          state.completed.push(current.id);

          const next2 = resolveHumanGateTarget(current, graph, state.context)
            || resolveNextNode(graph, current, state.context);

          if (!next2) {
            if (outcome2 === "failure") {
              const retryNode2 = getRetryTarget(current.id, graph);
              if (retryNode2) { current = retryNode2; console.log(); continue; }
            }
            break;
          }
          console.log();
          current = next2;
        }

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
    process.exitCode = 1;
    if (options.runId) {
      await reportProgress(options, {
        current_node_id: current.id,
        node_id: current.id,
        node_status: "failed",
        run_status: "failed",
        fail_reason: state.failReason,
      });
    }
  }
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
