import { CONTINUE_BANNER_KINDS, FOREIGN_TEXT_CAPS, capForeignText, escapeForeignControlChars, inlineForeignText, fromConvexAgentType, toConvexAgentType, resolveAgentLaunch, type AgentDefinitionSpec } from "@codecast/shared/contracts";
import { splitReviewNote } from "./reviewNote";
import { definitionLaunchFlags } from "../agentLaunch.js";
import { CHEAP_MODEL } from "@codecast/shared/contracts/modelOptions";
import { NO_CAUSE_HISTORY } from "@codecast/shared/contracts/causeHistory";
import { gateDoc } from "@codecast/shared/contracts/changeCard";
import { ParkedClock, taskWaiting } from "./parkedClock.js";
import { diskFullFailReason, requeueAfterDiskFull } from "../diskFull.js";
import { countingSemaphore } from "../semaphore.js";
import { WorkflowGraph, WorkflowNode, WorkflowRunState, NodeOutcome } from "./types";
import { evalCondition } from "./condition";
import { keepEnds } from "./keepEnds";
import { contextVar, executeCommand, expandScriptVars, recordNodeOutput } from "./commandStation";
import { planReadiness } from "../planReadiness.js";
import { readGateCard } from "../cardFile.js";
import { agentResultPreview, resultPreview } from "./chainWorkflow.js";
import { spawnSync } from "../proc.js";
import { argvOnLaunchAccount } from "../ccAccounts.js";
import { applyUnattended } from "../unattended.js";
import { deviceId } from "../remote/device.js";
import { LineProfileError, lineProfileVars, loadLineProfile } from "../lineProfile.js";
import { deadEndReason, profileFailure, quotedTitle, taskStopCard } from "./runFailure.js";
import { claimRun, clearVisits, readCheckpoint, resumePoint, runnerStamp, withOptionWords, writeCheckpoint, type ResumePoint, type ResumeRow } from "./runResume.js";
import presenterBase from "./presenter.md" with { type: "text" };
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { c } from "../colors.js";
import { cliFetch } from "../cliHttp.js";
import { claudeProjectDirName } from "../projectPathResolver.js";
import { frozenChangeContext } from "./flowChangeFile.js";
import { lineRunsRoot } from "./runDirs.js";
import { restoreResumedWorktree } from "./runWorktree.js";

function resolveNextNode(
  graph: WorkflowGraph,
  current: WorkflowNode,
  context: Record<string, string>
): WorkflowNode | null {
  // A gate's labelled edges are its options: only choosing one follows it
  // (resolveHumanGateTarget), never the fallthrough below.
  const outEdges = graph.edges
    .filter(e => e.from === current.id && !(current.type === "human" && e.label))
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

export { expandScriptVars, recordNodeOutput } from "./commandStation";

// A call node (learning-loop.md LL1): one prompt, one answer, no tools and no
// session. The prompt is the node's own words with $vars expanded and nothing
// appended, so what the graph says is exactly what the model reads. It runs
// through the server's one call path (/cli/model/call), on the team's model
// budget, which answers with the text, the parsed JSON when the node asks
// for json, and what the call cost. The answer lands under `<id>.output` and
// `<id>.json`, the cost under `<id>.cost_usd`.
export const CALL_NODE_DEFAULTS = { max_tokens: 1_000, output: "json" as const };

export function callNodeBody(node: WorkflowNode, graph: WorkflowGraph, context: Record<string, string>, cwd: string) {
  return {
    model: resolveModel(node, graph) || CHEAP_MODEL,
    max_tokens: node.max_tokens ?? CALL_NODE_DEFAULTS.max_tokens,
    ...(node.system ? { system: expandPromptVars(node.system, graph, context) } : {}),
    prompt: expandPromptVars(node.prompt ?? "", graph, context),
    output: node.output ?? CALL_NODE_DEFAULTS.output,
    label: node.label,
    project_path: cwd,
  };
}

/** The command stations a resumed run makes again before it goes on: those marked `refresh` that it already made, in the order it made them. */
export function refreshedOnResume(graph: WorkflowGraph, completed: string[]): WorkflowNode[] {
  return [...new Set(completed)].map((id) => graph.nodes.get(id)).filter((n): n is WorkflowNode => !!n?.refresh && n.type === "command" && !!n.script);
}

async function executeCallNode(node: WorkflowNode, graph: WorkflowGraph, context: Record<string, string>, cwd: string, options: RunOptions): Promise<NodeOutcome> {
  const body = callNodeBody(node, graph, context, cwd);
  console.log(`${c.dim}  call: ${body.model}, up to ${body.max_tokens} tokens, ${body.output}${c.reset}`);
  if (!options.convexSiteUrl || !options.apiToken) {
    context["last_error"] = "A call node runs on codecast's model budget: sign in (cast auth) to run it.";
    console.log(`  ${c.red}✗ ${context["last_error"]}${c.reset}`);
    return "failure";
  }
  let result: any;
  try {
    const resp = await fetch(`${options.convexSiteUrl}/cli/model/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: options.apiToken, ...body, ...(options.runId ? { run_id: options.runId } : {}) }),
    });
    result = await resp.json();
    if (!resp.ok && !result?.reason) result = { ok: false, error: result?.error ?? `the server answered ${resp.status}`, cost_usd: 0 };
  } catch (err: any) {
    result = { ok: false, error: err?.message ?? String(err), cost_usd: 0 };
  }
  context[`${node.id}.cost_usd`] = String(result?.cost_usd ?? 0);
  if (!result?.ok) {
    context["last_error"] = String(result?.error ?? "the call failed");
    recordNodeOutput(context, node.id, context["last_error"]);
    console.log(`  ${c.red}✗ ${context["last_error"]}${c.reset}`);
    return "failure";
  }
  const text = String(result.text ?? "");
  recordNodeOutput(context, node.id, text, result.json !== undefined ? JSON.stringify(result.json) : text);
  console.log(c.dim + (text.length > 500 ? text.slice(0, 500) + "..." : text) + c.reset);
  console.log(`  ${c.green}✓ answered${c.reset}${c.dim} ($${Number(result.cost_usd ?? 0).toFixed(4)})${c.reset}`);
  return "success";
}

function findNewestSessionId(cwd: string, afterMs: number): string | null {
  const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  const projectDirName = claudeProjectDirName(cwd);
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
    // On the fleet store like every codecast launch, never the bare keychain
    // login (ct-56748).
    const argv = argvOnLaunchAccount(args, (msg) => console.log(`${c.dim}${msg}${c.reset}`));
    const result = spawnSync(argv[0], argv.slice(1), {
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

    recordNodeOutput(context, node.id, output);
    if (sessionId) context[`${node.id}.session_id`] = sessionId;

    if (result.status === 0) {
      console.log(`  ${c.green}✓ done${c.reset}${sessionId ? c.dim + " [" + sessionId.slice(0, 8) + "]" + c.reset : ""}`);
      return "success";
    } else {
      console.log(`  ${c.red}✗ agent failed (exit ${result.status})${c.reset}`);
      context["last_error"] = keepEnds(stderr || output, 2000);
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

  const timeout = handTimeoutMs(node, options);
  const startMs = Date.now();
  const pollInterval = 10_000;

  while (Date.now() - startMs < timeout) {
    await new Promise(r => setTimeout(r, pollInterval));

    if (!runtime.isAlive(handle)) {
      const output = runtime.getOutput(handle, 500);
      recordNodeOutput(context, node.id, output.text);
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
// runner degrades instead of throwing mid-graph. Through cliFetch, so a write
// that lost a race on every server retry (nothing applied) is sent again with
// backoff, whatever the route: at fifty runs a station's spawn lost to other
// stations' writes and failed its node on the first 500 (2026-10-23).
async function cliCall(options: RunOptions, route: string, body: Record<string, any>): Promise<any | null> {
  if (!options.convexSiteUrl || !options.apiToken) return null;
  try {
    const resp = await cliFetch(`${options.convexSiteUrl}${route}`, {
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

// How long a settled hand with an empty session may still be waiting on its
// first transcript sync before the station reads it as never having run.
const EMPTY_HAND_GRACE_MS = 120_000;

// A session node (backend=session) is a hand: a real codecast session started
// through /cli/spawn exactly as `cast spawn --unattended` starts one, so it is
// reachable with cast send/read and opened with the unattended opening
// (the-line.md L11). It nests under the run's own session (L10). The runner then waits for it to settle: done or
// needs_input, killed, or its process gone. A hand that outlives the node
// timeout fails the node; runWorkflow's failure path returns the task to open
// with a comment. However the station ends, the server stops its hand when the
// runner reports the node over (workflow_runs.stopStationHands). A run the
// server never registered has nobody to report to, so its runner stops the
// hand itself.
async function executeSessionNode(
  node: WorkflowNode,
  graph: WorkflowGraph,
  context: Record<string, string>,
  cwd: string,
  options: RunOptions,
  onSpawned?: () => void,
): Promise<NodeOutcome> {
  const outcome = await waitOnStation(node, graph, context, cwd, options, onSpawned);
  const hand = context[`${node.id}.conversation_id`];
  if (!options.runId && hand) await cliCall(options, "/cli/sessions/kill", { session: hand });
  return outcome;
}

async function waitOnStation(
  node: WorkflowNode,
  graph: WorkflowGraph,
  context: Record<string, string>,
  cwd: string,
  options: RunOptions,
  onSpawned?: () => void,
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
    worktreeName = runSlug(graph, context, node.id);
    context["worktree"] = worktreeName;
    context["branch"] = `codecast/${worktreeName}`;
  }
  // A resumed run waits on the hand its runner left working (runResume.ts)
  // rather than starting the station over; a hand stopped when the run ended
  // does not count, and the station starts anew. A hand that died with the
  // runner (a reboot takes both) is waited for: the watchdog revives it in the
  // same conversation (midWorkRevive.ts), usually after the sweep has already
  // restarted this runner, and a second hand spawned meanwhile would work the
  // same worktree beside it. One not back within the grace is not coming
  // (recovery off, its revive budget spent): it is stopped, so a late revive
  // finds it retired, and the station starts anew.
  const left = options.resumed?.hand && options.resumed.node_id === node.id ? options.resumed.hand : null;
  if (options.resumed) options.resumed.hand = null;
  const leftRow = left ? ((await cliCall(options, "/cli/inbox", { session_ids: [left], show_all: true, limit: 5 }))?.sessions || []).find((r: any) => r.id === left) : null;
  let reattach = !!leftRow && !leftRow.is_killed;
  if (reattach && !leftRow.is_live && leftRow.work_state !== "done" && !(await revivedInTime(left!, options))) {
    console.log(`${c.yellow}  ${context[`${node.id}.session_id`] || left!.slice(0, 7)} died with the last runner and was not revived; starting ${node.id} again${c.reset}`);
    await cliCall(options, "/cli/sessions/kill", { session: left });
    reattach = false;
  }

  // A station that presents a decision is the one session a person talks it
  // over with (presenter.md), and its gate adopts the decision that session
  // posted. Sent back to it (a card the run refused), a fresh hand would find
  // its predecessor's decision, which it can neither correct nor withdraw and
  // the gate never adopts: Present on ct-61115 re-pinned the same report, the
  // card refused it again, and the run failed on max_visits with sd-1072 in the
  // queue linked to nothing. So the run goes back to the hand that presented,
  // with its brief as it stands now (a send restarts a stopped hand), and that
  // hand has answered once it pins again.
  const presenter = !reattach && presentsDecision(node, graph) ? context[`${node.id}.conversation_id`] : undefined;
  let answeredAfter: number | null | undefined;
  if (presenter) {
    const before = await cliCall(options, "/cli/sessions/state/get", { session: presenter });
    const sent = await cliCall(options, "/cli/messages/send", {
      to: presenter,
      ...(options.runSession ? { from: options.runSession } : {}),
      body: `The run is back at this station, with you. Your brief as it stands now:\n\n${buildNodePrompt(node, graph, context)}`,
      wake: true,
    });
    if (sent) answeredAfter = typeof before?.at === "number" ? before.at : null;
  }

  let hand: { conversationId: string; shortId: string };
  if (reattach) {
    hand = { conversationId: left!, shortId: context[`${node.id}.session_id`] || left!.slice(0, 7) };
    console.log(`  ${c.green}waiting again on${c.reset} ${c.cyan}${hand.shortId}${c.reset}`);
  } else if (answeredAfter !== undefined) {
    hand = { conversationId: presenter!, shortId: context[`${node.id}.session_id`] || presenter!.slice(0, 7) };
    onSpawned?.();
    console.log(`  ${c.green}back to${c.reset} ${c.cyan}${hand.shortId}${c.reset}`);
  } else {
    const spawned = await spawnHand(node, graph, context, cwd, options, agent, model, worktreeName);
    if (!spawned) return "failure";
    hand = spawned;
    context[`${node.id}.session_id`] = hand.shortId;
    context[`${node.id}.conversation_id`] = hand.conversationId;
    onSpawned?.();
    console.log(`  ${c.green}spawned${c.reset} ${c.cyan}${hand.shortId}${c.reset}`);
  }
  const { conversationId, shortId } = hand;

  if (options.runId) {
    await reportProgress(options, { current_node_id: node.id, node_id: node.id, node_status: "running", session_id: shortId });
  }

  const timeout = handTimeoutMs(node, options);
  const startMs = Date.now();
  const pollInterval = options.pollIntervalMs ?? 10_000;
  // The runner it took over from was waiting on a live hand, so a reattached
  // hand that reads not live has gone dark (below), not answered.
  let wasLive = reattach;
  let lastState = "";
  let askedOnce = false;
  let heldDormant = false;
  let emptySince = 0;
  // A station whose every edge routes on the handoff is answered by the task, not by
  // how the hand's session reads. A hand that handed off is done even while a
  // dormant pin from an earlier wait or a background check it left running
  // keeps its session parked: three Implement hands handed off and were killed
  // 180 minutes later (ct-58311, ct-61013, ct-58686, 2026-10-22). And a session
  // that reads finished without a handoff has not answered: four Implement
  // hands read idle in the middle of a tool call routed on an empty handoff
  // (ct-60376, ct-57854, ct-61269, ct-58286). Such a hand is asked once to
  // finish with its handoff; one that settles again without it fails the station.
  const outgoing = graph.edges.filter((e) => e.from === node.id);
  const answersByHandoff = !!options.taskId && outgoing.length > 0 && outgoing.every((e) => /\bhandoff\b/.test(e.condition ?? ""));
  // The work is open again at this station: a task still in review from the
  // last round's handoff goes back to in progress, so only this hand's
  // handoff can put it in review (a check that sent the round back leaves
  // the old one standing).
  if (answersByHandoff && !reattach && await handedOff(options)) {
    await cliCall(options, "/cli/work/update", { short_id: options.taskId, status: "in_progress" });
  }
  let askedForHandoffAt = 0;
  let seenMessages = -1;
  // The node's clock leaves out time the hand spends parked on its task's wait or a usage limit (parkedClock.ts).
  const clock = new ParkedClock(startMs);
  while (clock.elapsed() < timeout) {
    await new Promise(r => setTimeout(r, pollInterval));
    clock.beginPoll();
    if (answersByHandoff && await handedOff(options)) {
      console.log(`  ${c.green}✓ handed off${c.reset}`);
      recordNodeOutput(context, node.id, "handed off");
      return "success";
    }
    const inbox = await cliCall(options, "/cli/inbox", { session_ids: [conversationId], show_all: true, limit: 5 });
    const row = (inbox?.sessions || []).find((r: any) => r.id === conversationId);
    if (!row) {
      // A hand the read never returns would otherwise wait in silence until
      // the node's timeout kills it: say so once, with the reason at hand.
      if (lastState !== "unseen" && Date.now() - startMs > 60_000) {
        console.log(`${c.yellow}  ${shortId}: the session read ${inbox ? "does not list this hand" : "is failing"}, so the run cannot see it settle${c.reset}`);
        lastState = "unseen";
      }
      continue;
    }
    const state: string = row.work_state || "idle";
    if (row.is_live) wasLive = true;
    // A hand whose start failed (its machine refused it, or a cloud host's
    // preparation failed) reads idle, never live and never killed: nothing
    // would settle it before the node's timeout, three hours at prove. Once
    // the error has stood past the first-sync grace, the station fails with it.
    if (!wasLive && row.message_count === 0 && row.session_error) {
      emptySince ||= Date.now();
      if (Date.now() - emptySince >= EMPTY_HAND_GRACE_MS) {
        console.log(`  ${c.red}✗ ${shortId} could not start${c.reset}: ${String(row.session_error).split("\n")[0]}`);
        context["last_error"] = `hand ${shortId} at ${node.id} could not start: ${String(row.session_error).slice(0, 1500)}`;
        context["station_dead"] = node.id;
        return "failure";
      }
      continue;
    }
    // A hand seen live that now reads not live, neither killed nor
    // hibernated, has a daemon that went quiet: its heartbeat lapsed, and the
    // row reads stopped and needs_input on that alone. That is the daemon's
    // silence, not the hand's answer: a hand that exits is reported by its
    // daemon while the row is still live, and the settle below catches it
    // there. A daemon frozen for 199s under load settled a hand mid tool
    // call and routed the run to failure (agentwatch Build, 2026-10-14).
    // Wait for the daemon to come back, or for the node's timeout; a hand
    // that declared done before the silence keeps that answer.
    const dark = wasLive && !row.is_live && !row.is_killed && row.agent_status !== "hibernated";
    if (dark && state !== "done") {
      if (lastState !== "dark") console.log(`${c.dim}  ${shortId}: its daemon has gone quiet, waiting for it to report again${c.reset}`);
      lastState = "dark";
      askedOnce = false;
      continue;
    }
    if (state !== lastState) {
      console.log(`${c.dim}  ${shortId}: ${state}${c.reset}`);
      lastState = state;
    }
    // A parked hand (limit, throttle, dropped connection) resumes on its own: wait. A limit or throttle also stops
    // the node's clock (18 limit-parked hands hit their timeout, 2026-10-24); other parks keep it, so they still end.
    if (row.blocked_on && CONTINUE_BANNER_KINDS.includes(row.blocked_on)) {
      const quota = row.blocked_on === "limit" || row.blocked_on === "throttle";
      if (lastState !== `parked:${row.blocked_on}`) console.log(`${c.dim}  ${shortId}: parked on ${row.blocked_on}, waiting for it to resume${quota ? "; the node's clock stops until it does" : ""}${c.reset}`);
      lastState = `parked:${row.blocked_on}`;
      if (quota) clock.park();
      continue;
    }
    // A live hand can read needs_input for a moment between a reply and its
    // next tool call; one such reading ended a prove station three minutes in,
    // with the hand still working. A live hand settles on needs_input only
    // when two reads in a row say so. One that stopped needs no second read.
    // A transcript still growing is a hand at work, whatever its status reads: a process restarted outside the daemon
    // posts statuses the daemon refuses (no launch token), and three Revise builds settled 15 s into their work (Oct 26).
    const grew = seenMessages >= 0 && (row.message_count ?? 0) > seenMessages;
    seenMessages = row.message_count ?? seenMessages;
    const asking = state === "needs_input" && row.is_live && !row.is_killed;
    if (asking && (!askedOnce || grew)) {
      askedOnce = true;
      continue;
    }
    askedOnce = asking;
    const settled = state === "done" || state === "needs_input" || row.is_killed || (wasLive && !row.is_live);
    if (!settled) continue;
    const pinned = await cliCall(options, "/cli/sessions/state/get", { session: conversationId });
    // A presenter brought back still shows the pin it left last visit until it pins again.
    if (answeredAfter !== undefined && !row.is_killed && !(typeof pinned?.at === "number" && (answeredAfter === null || pinned.at > answeredAfter))) {
      askedOnce = false;
      continue;
    }
    // conversations.getThreadState: the pinned text is `state`, its status `status`.
    const pinnedText: string = typeof pinned?.state === "string" ? pinned.state : "";
    // A hand that pinned dormant said a machine wakes it next: a background
    // check, a replay, a Monitor. Its row reads needs_input or not live while
    // it waits, and that is the pause, not its answer: the Implement hand of
    // ct-59998 pinned dormant on a check and an eval, and the run routed on
    // the empty handoff (2026-10-16). Wait within the node's timeout for it to
    // pin again. It still settles on done, on being killed, and on a real ask:
    // an open question, or an error it does not come back from by itself.
    if (pinned?.status === "dormant" && state !== "done" && !row.is_killed && !row.awaiting_input && !row.blocked_on) {
      if (!heldDormant) console.log(`${c.dim}  ${shortId}: pinned dormant, waiting for its wake${c.reset}`);
      heldDormant = true;
      askedOnce = false;
      const waiting = await taskWaiting((route, body) => cliCall(options, route, body), options.taskId);
      if (waiting && clock.park()) console.log(`${c.dim}  ${shortId}: its task waits (${waiting}); the node's clock stops until it clears${c.reset}`);
      continue;
    }
    // The pin is display text, capped; its json block is stored whole as
    // `result`, which is what the station's edges route on.
    const pinnedResult: string = typeof pinned?.result === "string" ? pinned.result : "";
    const output = `work_state: ${state}${pinnedText ? `\n${pinnedText}` : ""}`;
    recordNodeOutput(context, node.id, output, pinnedResult || output);
    const pinnedStatus: string = pinned?.status || "";
    // A hand whose session holds no message and no pin never ran a turn: its
    // process never started, or its transcript went to another conversation.
    // It answered nothing, so the station fails instead of passing an empty
    // result down the graph. A live one gets a moment for its first sync.
    if (row.message_count === 0 && !pinnedStatus) {
      emptySince ||= Date.now();
      if (row.is_live && !row.is_killed && Date.now() - emptySince < EMPTY_HAND_GRACE_MS) continue;
      console.log(`  ${c.red}✗ ${shortId} never ran a turn${c.reset}`);
      context["last_error"] = `hand ${shortId} at ${node.id} never ran a turn: its session holds no messages and no result`;
      context["station_dead"] = node.id;
      return "failure";
    }
    // A hand that stopped on an API error it does not come back from by itself
    // (a logged-out machine answers every prompt "Not logged in") and pinned
    // nothing did no work. Read as a settle, it passed, and the run routed on
    // the task's old fields: a whole box's runs parked their causes unread
    // (Union, 2026-10-14). The station fails with the error instead.
    if (!pinnedStatus && row.blocked_on && !CONTINUE_BANNER_KINDS.includes(row.blocked_on)) {
      console.log(`  ${c.red}✗ ${shortId} stopped on an ${row.blocked_on} error${c.reset}`);
      context["last_error"] = `hand ${shortId} at ${node.id} stopped on an ${row.blocked_on} error before doing the work${row.session_error ? `: ${String(row.session_error).slice(0, 1500)}` : ""}`;
      context["station_dead"] = node.id;
      return "failure";
    }
    if (pinnedStatus === "blocked") {
      console.log(`  ${c.yellow}blocked${c.reset}: ${pinnedText.split("\n")[0] || "(no detail)"}`);
      context["last_error"] = pinnedText.slice(0, 2000);
      // What it pinned is the question its ask gate puts to a person: kept whole.
      context["blocked_note"] = pinnedText;
      // A station that pinned blocked waits on a person: the run stops here,
      // whatever its json says: the loop checks this before any edge.
      context["station_blocked"] = node.id;
      return "failure";
    }
    if (answersByHandoff) {
      // A hand that ended a turn while its own check runs in the background
      // (the Bash tool backgrounds past 120s) has not answered yet: the ask
      // has it pin dormant, which the wait above holds to the node's timeout.
      // Its handoff landed 1 to 60+ minutes later on 14 runs (ct-60145).
      if (!askedForHandoffAt && !row.is_killed) {
        askedForHandoffAt = Date.now();
        console.log(`${c.yellow}  ${shortId}: read as finished without a handoff; asking it to finish with one${c.reset}`);
        await cliCall(options, "/cli/messages/send", {
          to: conversationId,
          ...(options.runSession ? { from: options.runSession } : {}),
          body: `The run reads this session as finished, but ${options.taskId} has no handoff from it, and this station's next step routes on the handoff. If work you started is still running (a backgrounded check, a replay), pin \`cast state --status dormant\` naming what you wait on and end your turn: the run waits for your wake. When the work is done, or cannot be done, end with \`cast task handoff ${options.taskId} --status done|blocked|needs_context\` as your brief says.`,
          wake: true,
        });
        askedOnce = false;
        heldDormant = false;
        continue;
      }
      if (askedForHandoffAt && !row.is_killed && Date.now() - askedForHandoffAt < (options.handoffAskGraceMs ?? HANDOFF_ASK_GRACE_MS)) continue;
      console.log(`  ${c.red}✗ ${shortId} ended without a handoff${c.reset}`);
      context["last_error"] = `hand ${shortId} at ${node.id} ended its turn without a handoff${askedForHandoffAt ? ", also after being asked for one" : ""}`;
      context["station_dead"] = node.id;
      return "failure";
    }
    console.log(`  ${c.green}✓ settled${c.reset} ${c.dim}(${state})${c.reset}`);
    return "success";
  }

  console.log(`  ${c.red}timeout${c.reset} after ${Math.round(timeout / 60_000)}m — killing ${shortId}`);
  context["last_error"] = `hand ${shortId} killed after ${Math.round(timeout / 60_000)}m at ${node.id}`;
  context["killed_hand"] = shortId;
  context["station_dead"] = node.id;
  return "failure";
}

// How long a hand asked for its missing handoff has to start answering before
// a finished reading counts again: the message lands at its next turn.
const HANDOFF_ASK_GRACE_MS = 3 * 60_000;

/** Whether the run's task stands handed off: in review, with how the hand ended. */
async function handedOff(options: RunOptions): Promise<boolean> {
  const task = await cliCall(options, "/cli/work/get", { short_id: options.taskId });
  return String(task?.status || "") === "in_review" && !!task?.execution_status;
}

// The watchdog revives a hand that died mid-work on its first pass after a
// reboot, five minutes apart and three a pass, station hands first.
const REVIVE_GRACE_MS = 20 * 60_000;

/** Whether a hand that died with the last runner comes back (live, or done) within the grace. */
async function revivedInTime(conversationId: string, options: RunOptions): Promise<boolean> {
  const until = Date.now() + (options.reviveGraceMs ?? REVIVE_GRACE_MS);
  const pollInterval = options.pollIntervalMs ?? 10_000;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, pollInterval));
    const row = ((await cliCall(options, "/cli/inbox", { session_ids: [conversationId], show_all: true, limit: 5 }))?.sessions || []).find((r: any) => r.id === conversationId);
    if (row?.is_killed) return false;
    if (row?.is_live || row?.work_state === "done") return true;
  }
  return false;
}

/** Start a station's hand through /cli/spawn, the way `cast spawn --unattended` starts one. */
async function spawnHand(
  node: WorkflowNode,
  graph: WorkflowGraph,
  context: Record<string, string>,
  cwd: string,
  options: RunOptions,
  agent: string,
  model: string | undefined,
  worktreeName: string | undefined,
): Promise<{ conversationId: string; shortId: string } | null> {
  const prompt = stationBrief(node, graph, context);
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
    title: stationTitle(node, context, presentsDecision(node, graph)),
    // A station is the run's worker: nested under the run's own session, so
    // it reads, answers cast send and shows on the run, and stays out of the
    // inbox's top level. The task's blocker comment is what reaches a person.
    ...(options.runSession ? { parent_session: options.runSession } : {}),
    // With a definition the server folds its client in unless the node names one.
    ...(node.definition && !node.agent ? {} : { agent_type: agent }),
    ...(node.definition ? { definition: node.definition } : {}),
    ...(model ? { model } : {}),
    // Every hand runs on the machine running the run: the branch, its worktree
    // and the proof directory live here. An isolated hand placed elsewhere left
    // verify checking nothing; a shared hand placed by its path alone landed on
    // another host with the same checkout path and could not read the run's
    // branch (review on union-line-3 for a run on union-line-1, 2026-10-23).
    device: deviceId(),
    ...(worktreeName ? { isolated: true, worktree_name: worktreeName } : {}),
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
    return null;
  }
  return { conversationId: spawned.conversation_id, shortId: spawned.short_id || spawned.conversation_id.slice(0, 7) };
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
    else if (branch.type === "call") outcome = await executeCallNode(branch, graph, ctx, cwd, options);
    else if ((branch.type === "agent" || branch.type === "prompt") && branch.backend === "session") outcome = await executeSessionNode(branch, graph, ctx, cwd, options);
    else if ((branch.type === "agent" || branch.type === "prompt") && branch.backend && branch.backend !== "builtin") outcome = await executeCliAgent(branch, graph, ctx, cwd, options);
    else if (branch.type === "agent" || branch.type === "prompt") outcome = await executeAgent(branch, graph, ctx, cwd, options);
    else outcome = "success";
    // Only the branch's own keys flow back; a shared draft would let branches
    // overwrite each other's last_error.
    for (const [k, v] of Object.entries(ctx)) {
      if (k.startsWith(`${branch.id}.`)) state.context[k] = v;
    }
    // The branch's own report ends its node, which stops its hand (workflow_runs.stopStationHands).
    if (options.runId) {
      await reportProgress(options, { current_node_id: node.id, node_id: branch.id, node_status: outcome === "failure" ? "failed" : "completed", outcome, session_id: ctx[`${branch.id}.session_id`] });
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

  // An answer that names no option is asked again: defaulting to the first
  // option would take a typo for "ship".
  for (;;) {
    const answerUpper = (await promptUser("  Your choice: ")).trim().toUpperCase();
    const match = choices.find(c => c.key.toUpperCase() === answerUpper);
    if (match) {
      context["human.gate.selected"] = match.key;
      context["human.gate.label"] = match.label;
      context["human.gate.target"] = match.target;
      return match.key.toLowerCase();
    }
    console.log(`  ${c.yellow}pick one of ${choices.map(ch => ch.key).join(", ")}${c.reset}`);
  }
}

// An edge out of a gate is an option (the-line.md L4): "[A] Approve :: what
// happens if chosen". The key is the bracketed letter, the label follows,
// the description follows "::". The label keeps its key so the run's
// gate_choices mirror reads as before; the server strips it for the option.
export function parseGateEdgeLabel(label: string): { key: string; label: string; description?: string } {
  const sep = label.indexOf("::");
  const head = (sep >= 0 ? label.slice(0, sep) : label).trim();
  const description = sep >= 0 ? label.slice(sep + 2).trim() : "";
  return { key: extractKey(head), label: head, ...(description ? { description } : {}) };
}

export { gateDoc };

// The gate's question and document (the-line.md L4): the node's prompt
// (first line the question, the rest the context) and its doc attribute,
// both expanded with the same $vars a node prompt reads.
// A card attribute names the change card (LE11) the gate decides on; a card
// that is missing or fails its contract leaves the gate asking without it.
export function gatePayload(node: WorkflowNode, graph: WorkflowGraph, context: Record<string, string>) {
  const card = node.card ? readGateCard(expandPromptVars(node.card, graph, context).trim()) : null;
  return {
    prompt: node.prompt ? expandPromptVars(node.prompt, graph, context) : node.label,
    ...(node.doc ? { doc_md: gateDoc(expandPromptVars(node.doc, graph, context)) } : {}),
    ...(node.category ? { category: node.category } : {}),
    ...(graph.stack ? { stack: expandPromptVars(graph.stack, graph, context) } : {}),
    ...(card && "card" in card ? { card: card.card } : {}),
    ...(card && "proposal" in card ? { proposal: card.proposal } : {}),
    ...(card && "judge_fix" in card ? { judge_fix: card.judge_fix } : {}),
    // The presenting station the gate names, and its session when it ran: such a gate asks only the card it posted.
    ...(node.asker ? { asker: node.asker } : {}),
    ...(node.asker && context[`${node.asker}.session_id`] ? { asker_session_id: context[`${node.asker}.session_id`] } : {}),
  };
}

// LE1.4 one live run per cause: a run the server could not register must not
// execute when it is bound to a cause (the refusal of a second live run, or
// any failure that would leave a cause-bound run invisible) or handed to the
// daemon. Only an unbound local run may carry on unregistered.
export function runRegistrationIsFatal(opts: { detach?: boolean; taskId?: string; planId?: string }): boolean {
  return !!(opts.detach || opts.taskId || opts.planId);
}

// the-line.md L8 node fidelity: the one serializer for a workflow push. Every
// node attribute the daemon needs to run the stored graph as a local run
// would (definition, reviewer, timeout, temperature, and the gate's doc and
// category) rides here, so a second push site cannot drop one.
export function graphToPushPayload(graph: WorkflowGraph) {
  const nodes = [...graph.nodes.values()].map((n) => ({
    id: n.id, label: n.label, shape: n.shape, type: n.type,
    ...(n.prompt ? { prompt: n.prompt } : {}),
    ...(n.script ? { script: n.script } : {}),
    ...(n.model ? { model: n.model } : {}),
    ...(n.backend ? { backend: n.backend } : {}),
    ...(n.agent ? { agent: n.agent } : {}),
    ...(n.isolated !== undefined ? { isolated: n.isolated } : {}),
    ...(n.reasoning_effort ? { reasoning_effort: n.reasoning_effort } : {}),
    ...(n.max_visits !== undefined ? { max_visits: n.max_visits } : {}),
    ...(n.max_retries !== undefined ? { max_retries: n.max_retries } : {}),
    ...(n.retry_target ? { retry_target: n.retry_target } : {}),
    ...(n.goal_gate !== undefined ? { goal_gate: n.goal_gate } : {}),
    ...(n.definition ? { definition: n.definition } : {}),
    ...(n.reviewer !== undefined ? { reviewer: n.reviewer } : {}),
    ...(n.timeout !== undefined ? { timeout: n.timeout } : {}),
    ...(n.temperature !== undefined ? { temperature: n.temperature } : {}),
    ...(n.doc ? { doc: n.doc } : {}),
    ...(n.category ? { category: n.category } : {}),
    ...(n.card ? { card: n.card } : {}),
    ...(n.asker ? { asker: n.asker } : {}),
    ...(n.answerer ? { answerer: n.answerer } : {}),
  }));
  const edges = graph.edges.map((e) => ({
    from: e.from, to: e.to,
    ...(e.label ? { label: e.label } : {}),
    ...(e.condition ? { condition: e.condition } : {}),
  }));
  // The graph attribute stack (the-line.md L4: one decision stack per run)
  // travels with the push so a daemon run keeps it.
  return { nodes, edges, ...(graph.stack ? { stack: graph.stack } : {}), ...(graph.serves?.length ? { serves: graph.serves } : {}) };
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
    .map((e) => ({ ...parseGateEdgeLabel(e.label!), target: e.to }));
  const payload = gatePayload(node, graph, context);
  // A resumed run never asks again what its gate already asked: an answer
  // that came while nothing drove the run is taken as given, and a gate
  // still open is waited on, not posted twice (runResume.ts).
  const resumed = options.resumed?.gate?.node_id === node.id ? options.resumed.gate : null;
  if (options.resumed) options.resumed.gate = null;
  const ask = (asked: typeof choices) => resumed?.response ? Promise.resolve(resumed.response)
    : resumed?.open ? pollGate(options)
    : reportGate(options, node.id, payload, asked);

  console.log(`\n${c.bold}${c.magenta}  Human gate: ${node.label} (${resumed?.response ? "answered while the run was down" : "waiting for web response"})${c.reset}`);

  if (choices.length === 0) {
    const response = await ask([{ key: "ok", label: "Continue", target: "" }]);
    if (response === PRESENT_AGAIN) return presentAgain(node, graph, context);
    if (response && !resumed?.response) await continueFreshIfStale(graph, options, node);
    return response ? "success" : "failure";
  }

  let response = await ask(choices);
  if (response === PRESENT_AGAIN) return presentAgain(node, graph, context);
  if (!response) return "failure";
  if (!resumed?.response) await continueFreshIfStale(graph, options, node);
  // A question the presenting station answered is spent once the gate asks again.
  delete context["human.gate.question"];
  delete context["human.gate.no_card"];

  for (;;) {
    // The human's message is context for the next hand.
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
      // A bare key ("A") is the choice, not a note: nothing to hand on.
      if (stripped) context["human.message"] = stripped;
      else delete context["human.message"];
      context["human.gate.selected"] = match.key;
      context["human.gate.label"] = match.label;
      context["human.gate.target"] = match.target;
      console.log(`  ${c.green}✓ received: ${match.label}${c.reset}`);
      return match.key.toLowerCase();
    }

    // Free text names no option, so it never follows one ("can you explain
    // plainly" once landed a change through Ship). A graph that routes free
    // text says so with an unlabelled edge out of the gate.
    if (outEdges.some(e => !e.label)) {
      console.log(`  ${c.green}✓ received message (free-form)${c.reset}`);
      return "success";
    }
    // Otherwise it is a question back: the station that presents the decision
    // answers it and the gate asks again; a gate with no presenter asks again
    // itself, the question on top of its document.
    const answerer = node.asker || node.answerer;
    const asker = answerer ? graph.nodes.get(answerer) : undefined;
    if (asker) {
      context["human.gate.question"] = trimmed;
      context["human.gate.target"] = asker.id;
      console.log(`  ${c.yellow}? question back to ${asker.label}${c.reset}`);
      return "success";
    }
    console.log(`  ${c.yellow}? a question, not a choice: asking again${c.reset}`);
    const doc = [`**You asked:** ${trimmed}`, payload.doc_md].filter(Boolean).join("\n\n");
    response = await reportGate(options, node.id, { ...payload, doc_md: doc }, choices);
    if (!response) return "failure";
  }
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

// Expand $goal and context variables. Unfilled vars are removed (not left as $var).
// `$scout.output` names a prior node's result (the runner stores every
// node's output under `<id>.output`), so a chain of nodes can hand work on.
// Shared by node prompts and gate prompts and documents (the-line.md L4).
export function expandPromptVars(template: string, graph: WorkflowGraph, context: Record<string, string>): string {
  const goal = graph.goal || "";
  return template.replace(/\$(\w+(?:\.\w+)*)/g, (_, key) => {
    if (key === "goal") return goal;
    return contextVar(context, key) ?? "";
  });
}

// One $name as both expanders read it. `$human_message` is the gate note,
// empty when there is none, so a script can test it without tripping on an
// unset `$human.message` (which the shell would read as `$human`). A node's
// `$<id>.output` reads empty for the same reason when the node left none (a
// hand that never spawned).
/** The base presenting brief codecast ships (presenter.md): what a decision put to a person is, on any line. */
export const PRESENTER_BASE = presenterBase.trim();

/**
 * Whether `node` presents a decision: some human gate of its graph names it as
 * its asker (`asker=<node>`), so the decision that gate puts to a person is the
 * one this station posts. Such a station reads the base presenter first and
 * its own prompt as the line's addendum, so no graph rewrites what a decision is.
 */
export function presentsDecision(node: Pick<WorkflowNode, "id">, graph: WorkflowGraph): boolean {
  for (const n of graph.nodes.values()) if (n.type === "human" && n.asker === node.id) return true;
  return false;
}

/** Whether `node` answers questions typed at some gate of its graph (`answerer=<node>`) without presenting its decision. */
export function answersGate(node: Pick<WorkflowNode, "id">, graph: WorkflowGraph): boolean {
  for (const n of graph.nodes.values()) if (n.type === "human" && n.answerer === node.id) return true;
  return false;
}

export function buildNodePrompt(
  node: WorkflowNode,
  graph: WorkflowGraph,
  context: Record<string, string>
): string {
  const goal = graph.goal || "";
  const parts: string[] = [];

  if (goal) {
    parts.push(`# Goal\n${goal}\n`);
  }

  if (node.prompt && presentsDecision(node, graph)) {
    parts.push(`# Task: ${node.label}\n${PRESENTER_BASE}\n\n# This line\n\n${expandPromptVars(node.prompt, graph, context)}`);
  } else if (node.prompt) {
    parts.push(`# Task: ${node.label}\n${expandPromptVars(node.prompt, graph, context)}`);
  } else {
    parts.push(`# Task: ${node.label}\n${goal ? `Complete this step of the goal: ${goal}` : node.label}`);
  }

  // A question typed at the gate this station presents comes back here: the
  // decision it posts again is the answer.
  if (context["human.gate.no_card"] && presentsDecision(node, graph)) {
    parts.push(`\n# No decision of yours stands at ${context["human.gate.no_card"]}\nThe gate decides only on a decision you post in this visit: an answer given to a card from an earlier visit does not carry over. Post the decision for the change as it stands.`);
  }
  if (context["human.gate.question"] && presentsDecision(node, graph)) {
    parts.push(`\n# The person's question about your decision\n${context["human.gate.question"]}\n\nThey asked instead of choosing. Answer it in the decision you post again.`);
  } else if (context["human.gate.question"] && answersGate(node, graph)) {
    parts.push(`\n# The person's question at the card\n${context["human.gate.question"]}`);
  } else if (context["human.message"]) {
    // Surface human message prominently if present
    parts.push(`\n# Human Instructions\n${context["human.message"]}`);
  }

  // A hand receives only what its prompt names (the-line.md L3: the reviewer
  // sees the branch, the title and the criteria, nothing else). Builtin and
  // cli agents keep the context and last error appendix.
  if (node.backend === "session") return parts.join("\n");

  // Add relevant context
  const contextEntries = Object.entries(context)
    .filter(([k, _v]) => !k.endsWith(".output") && !k.endsWith(".json") && !["outcome", "last_error", "human.message", "blocked_note"].includes(k))
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

/**
 * What a session station's hand reads on its first turn: the unattended
 * opening, naming the step that started it, then the node's prompt. The runner, `cast
 * line try` and the evals all render a station through here.
 */
export function stationBrief(node: WorkflowNode, graph: WorkflowGraph, context: Record<string, string>): string {
  const run = context["run_id"] ? ` (run ${context["run_id"]})` : "";
  return applyUnattended(buildNodePrompt(node, graph, context), `the "${node.label}" step of workflow ${graph.name}${run}`);
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
  /** The run's own session (workflow_runs.primary_conversation_id): stations nest under it. */
  runSession?: string;
  /** Settle poll for session nodes (tests shorten it). */
  pollIntervalMs?: number;
  /** How long a resumed run waits for the hand it left to be revived (REVIVE_GRACE_MS; tests shorten it). */
  reviveGraceMs?: number;
  /** How long a hand asked for its missing handoff has before a finished reading counts (HANDOFF_ASK_GRACE_MS; tests shorten it). */
  handoffAskGraceMs?: number;
  /** Continue this run row from where it stands instead of from start (runResume.ts). */
  resume?: ResumeRow;
  /** Set by runWorkflow on a resume: the gate and the hand the node it resumes at left open, each taken once. */
  resumed?: Pick<ResumePoint, "node_id" | "gate" | "hand">;
  /**
   * How this run continues in a fresh runner (the daemon's runner passes one
   * that hands off and exits; runResume.ts handOffRun). Given, a gate answered
   * after the graph's files or the runner's code changed on disk continues there.
   */
  continueFresh?: () => Promise<void>;
  /** Set by runWorkflow when continueFresh is given: what this runner loaded (runResume.ts runnerStamp). */
  loadedStamp?: string;
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
  const card = splitReviewNote(context["review_note"]);
  // A note with no words still asks something the person can place.
  context["review_question"] = inlineForeignText(card.question) || `Ship "${context["task_title"]}"?`;
  context["review_body"] = card.body;
  // One routable value for "how did the hand end": the execution status of a
  // handoff that placed the task in review, else none. A `changes` verdict
  // moves the task to in_progress without clearing execution_status, so
  // status = in_review is the freshness signal; a hand that ended without a
  // handoff (an inline question, a decision, a crash) reads as none and no
  // edge fires, which is the failure path.
  context["handoff"] = String(task.status || "") === "in_review" ? String(task.execution_status || "none") : "none";
  // What a hand that stopped (blocked, needs_context) said in its handoff: the
  // question the line's ask gate puts to a person, whole. Only a gate's doc
  // names it (no hand's prompt does), and a person answers what they can read
  // to its end, so it carries no prompt cap.
  context["handoff_note"] = context["handoff"] === "blocked" || context["handoff"] === "needs_context"
    ? escapeForeignControlChars(String(task.verification_evidence || ""))
    : "";
  // The ground node's fields (the-line-end-to-end.md LE5), which the line's
  // edges route on; empty until ground writes them.
  context["goal_ref"] = inlineForeignText(task.goal_ref || "");
  context["category"] = String(task.category || "");
  context["risk"] = String(task.risk || "");
  context["readiness"] = String(task.readiness || "");
  context["readiness_note"] = inlineForeignText(task.readiness_note || "");
  // Whose line this is, for the line's decision stack (LE11).
  context["assignee"] = inlineForeignText(task.assignee_info?.name || task.assignee || "unassigned");
}

// A cause remembers its attempts (line-workspace.md LW5): every run on a cause,
// in any graph, is handed what the earlier runs on it found, proposed, built
// and shipped, when each fix went live and whether the problem came back, as
// $cause_history. The server assembles it from codecast's own records with the
// derivation the web's timeline uses (lineWorkspace.causeHistoryForTask). Read
// once at start: nothing a run does mid-way is an earlier attempt.
export { NO_CAUSE_HISTORY };
const UNREAD_CAUSE_HISTORY = "The problem's earlier attempts could not be read for this run; `cast task history <task>` shows them.";
async function loadCauseHistory(options: RunOptions, context: Record<string, string>): Promise<void> {
  if (!options.taskId) return;
  const read = await cliCall(options, "/cli/work/history", { short_id: options.taskId, ...(options.runId ? { except_run_id: options.runId } : {}) });
  context["cause_history"] = !read ? UNREAD_CAUSE_HISTORY : read.brief ? escapeForeignControlChars(String(read.brief)) : NO_CAUSE_HISTORY;
}

// The plan fields node prompts and edge conditions read, refreshed after
// every node like the task's: `ready_tasks` counts the plan's tasks that can
// start now, so plan-autopilot's loop routes on the plan as it is.
async function loadPlanContext(options: RunOptions, context: Record<string, string>): Promise<void> {
  if (!options.planId) return;
  const plan = await cliCall(options, "/cli/plans/get", { short_id: options.planId });
  if (!plan) return;
  context["plan_title"] = inlineForeignText(plan.title);
  context["plan_goal"] = capForeignText(
    escapeForeignControlChars(plan.goal || ""),
    FOREIGN_TEXT_CAPS.descriptionChars,
  );
  context["plan_acceptance_criteria"] = (plan.acceptance_criteria || [])
    .map((c: string) => inlineForeignText(c)).join("\n- ");
  const { open, ready } = planReadiness<any>(plan.tasks || [], plan.graph_outside);
  context["ready_tasks"] = String(ready.length);
  context["open_tasks"] = String(open.length);
}

// The repo's default branch, for prompts that diff a hand's branch against it.
// One name per graph and task: the isolated hand's worktree (and branch) and
// the run's files directory share it, so a second visit or a later run on the
// same task finds the same worktree and the same files.
const slugPart = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export function runSlug(graph: WorkflowGraph, context: Record<string, string>, fallback: string): string {
  return `${slugPart(graph.name)}-${slugPart(context["task_id"] || `${fallback}-${Date.now().toString(36)}`)}`;
}

/**
 * `$run_dir` (line-profile.md LP4): the run's files (proof, reps, the card),
 * inside the repository's own git directory so nothing there is ever
 * committed, and known from the first node, so every station and every
 * project command names the same place. Outside a repository it lives under
 * the temp directory.
 */
export function lineRunDir(cwd: string, slug: string): string {
  return path.join(lineRunsRoot(cwd), slug);
}

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
async function queueTaskDecision(options: RunOptions, question: string, note: string, nodeId: string): Promise<boolean> {
  if (!options.taskId || !options.spawnerSession) return false;
  const result = await cliCall(options, "/cli/decide", {
    session_id: options.spawnerSession,
    task: options.taskId,
    // A failure gate is the run's decision too (the-line.md L4).
    ...(options.runId ? { workflow_run_id: options.runId, gate_node_id: nodeId } : {}),
    question,
    options: [
      { label: "Reopen for another implement round", description: "Run the line on this task again. If the reason below is outside the change, fix that first or the run stops the same way." },
      { label: "Drop the task", description: "Close the task and land nothing." },
      { label: "I will take it myself", description: "The task stays parked in review for you to finish by hand." },
    ],
    context_md: note.slice(0, 4000),
    blocking: true,
  });
  return !!result;
}

// A station's name, fixed at spawn: the node and what it works on, so the row
// reads on its own ("Prove · ct-42") instead of a title drawn from the
// unattended preamble every station's prompt opens with. A station that
// presents a decision is the session a person talks the fix over with, and its
// title shows wherever they meet it (the decision's chat, its page's bar): it
// is named by the problem, in the problem's own words.
export function stationTitle(node: Pick<WorkflowNode, "id" | "label">, context: Record<string, string>, presents = false): string {
  const problem = context["task_title"]?.replace(/\s+/g, " ").trim();
  if (presents && problem) return problem.length > 100 ? `${problem.slice(0, 99).trimEnd()}…` : problem;
  const subject = context["task_id"] || context["plan_id"] || context["goal"];
  const label = node.label || node.id;
  return subject ? `${label} · ${subject.slice(0, 80)}` : label;
}

// How long a hand may run before the runner kills it: the node's own
// `timeout` (seconds) when the graph sets one, since a station that replays
// evals under load needs more than one that writes criteria, else the run's
// --agent-timeout, else 30 minutes.
export function handTimeoutMs(node: Pick<WorkflowNode, "timeout">, options: Pick<RunOptions, "agentTimeout">): number {
  return node.timeout ? node.timeout * 1000 : options.agentTimeout || 1800_000;
}

// The failure path for a bound task (the-line.md L4). A hand that handed off
// blocked or needs_context already parked the task in review: keep it there.
// Retries exhausted parks it in review as blocked. Anything else (a killed
// hand, a hand that ended without a handoff) returns it to open. Either way
// a blocker comment says what happened, and a parked task gets a decision.
async function returnTaskOnFailure(options: RunOptions, graph: WorkflowGraph, state: WorkflowRunState): Promise<void> {
  // A dry run validates the graph; it never moves or comments on the real task.
  if (!options.taskId || options.dryRun) return;
  // A problem closed while the run stood (merged into another, dropped by a person) ended the run, not the
  // other way round: its close stands and its closing note says why (ct-59242 and ct-59534 came back open).
  const closed = await cliCall(options, "/cli/work/get", { short_id: options.taskId });
  if (closed && (closed.status === "done" || closed.status === "dropped")) return;
  const exhausted = /max_visits/.test(state.failReason || "");
  const handoff = state.context["handoff"];
  const parkedByHand = handoff === "blocked" || handoff === "needs_context";
  // The card names the station's session, which a nested worker no longer
  // puts in the inbox on its own, so the blocker leads straight there.
  const card = taskStopCard(graph, state, options.taskId);
  let text = card.body ? `${card.summary}\n\n${card.body}` : card.summary;
  // A run that stopped on purpose (a stop exit), or any failure on a graph
  // that stops on failure, leaves its problem open with why and asks nobody.
  if (state.context["stopped_at"] || graph.on_failure === "stop") {
    const stopped = state.context["stopped_at"] ? `${state.failReason}${state.context[`${state.context["stopped_at"]}.from`] ?? ""}` : text;
    await cliCall(options, "/cli/work/update", { short_id: options.taskId, status: "open" });
    await cliCall(options, "/cli/work/comment", { short_id: options.taskId, comment_type: "blocker", text: stopped });
    return;
  }
  // A hand that handed off blocked already parked the task in review; a
  // station that only pinned blocked did not, so the run parks it.
  const stationBlocked = !!state.context["station_blocked"];
  if (!parkedByHand || stationBlocked) {
    await cliCall(options, "/cli/work/update", exhausted || stationBlocked
      ? { short_id: options.taskId, status: "in_review", execution_status: "blocked" }
      : { short_id: options.taskId, status: "open" });
  }
  if (parkedByHand || exhausted) {
    const queued = await queueTaskDecision(options, card.question, card.body || card.summary, state.currentNodeId);
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

/** The node each unfinished run last reported, so a stopped runner can say where it stopped. */
const lastReportedNode = new Map<string, string>();

/**
 * A runner stopped by a signal (Ctrl-C, a kill) records its run as failed at
 * the node it was on, with why. Without this the run stays "running" for good:
 * every surface shows a run in build that nothing is building, and the cause
 * refuses a new run until it is forced.
 */
export async function reportRunStopped(options: RunOptions, signal: string): Promise<void> {
  const node = options.runId ? lastReportedNode.get(options.runId) : undefined;
  if (!node) return;
  await reportProgress(options, {
    current_node_id: node,
    node_id: node,
    node_status: "failed",
    run_status: "failed",
    fail_reason: `the runner was stopped (${signal}) at ${node}`,
  });
}

/**
 * A person's Ctrl-C stops the run: it is recorded failed where it stood. A
 * SIGTERM or SIGHUP is the machine going away under the runner (a shutdown,
 * a daemon restart, a closed pane), not a decision about the run, so the run
 * stays live and is resumed where it stood (runResume.ts).
 */
export function stopRunOnSignals(options: RunOptions): void {
  process.once("SIGINT", () => {
    void reportRunStopped(options, "SIGINT").finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => process.exit(143));
  process.once("SIGHUP", () => process.exit(129));
}

async function reportProgress(options: RunOptions, payload: Record<string, any>): Promise<void> {
  if (!options.runId || !options.convexSiteUrl || !options.apiToken) return;
  // A run that reported its end has nothing left to stop: forget it, so a late
  // signal cannot mark a finished run failed.
  const node = payload.current_node_id ?? payload.node_id;
  if (payload.run_status === "completed" || payload.run_status === "failed") lastReportedNode.delete(options.runId);
  else if (typeof node === "string") lastReportedNode.set(options.runId, node);
  const body = { api_token: options.apiToken, run_id: options.runId, ...payload };
  try {
    await fetch(`${options.convexSiteUrl}/cli/workflow-runs/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {}
}

// A gate with a presenting station (`asker=`) decides on the card that station
// posted and asks no question of its own. With no card of it standing, nobody
// is asked, and the run goes back to the station to present one.
const PRESENT_AGAIN = "\0present again";

function presentAgain(node: WorkflowNode, graph: WorkflowGraph, context: Record<string, string>): NodeOutcome {
  const asker = node.asker ? graph.nodes.get(node.asker) : undefined;
  if (!asker) return "failure";
  context["human.gate.target"] = asker.id;
  // Nobody answered, so this is no new attempt: the station's visits keep counting.
  context["human.gate.no_card"] = node.label;
  console.log(`  ${c.yellow}no card from ${asker.label} stands at ${node.label}: back to ${asker.label}${c.reset}`);
  return "success";
}

async function reportGate(
  options: RunOptions,
  nodeId: string,
  payload: ReturnType<typeof gatePayload>,
  choices: Array<{ key: string; label: string; description?: string; target: string }>
): Promise<string | null> {
  if (!options.runId || !options.convexSiteUrl || !options.apiToken) return null;
  try {
    const resp = await fetch(`${options.convexSiteUrl}/cli/workflow-runs/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: options.apiToken,
        run_id: options.runId,
        node_id: nodeId,
        ...payload,
        choices,
      }),
    });
    const asked = await resp.json().catch(() => null) as { error?: string; present_again?: boolean } | null;
    if (asked?.present_again) return PRESENT_AGAIN;
    // Nobody was asked: stop here so the failure path says why, rather than
    // wait on an answer that cannot come.
    if (asked?.error) {
      console.log(`  ${c.red}gate not asked${c.reset}: ${asked.error}`);
      return null;
    }
  } catch {
    return null;
  }
  return pollGate(options);
}

/**
 * A gate was answered: when the graph's files or the runner's code changed
 * since this runner loaded them, the run continues in a fresh runner, which
 * resumes at this gate with the answer the row holds and the stations as they
 * are on disk now. Nothing is reported first, so the row still shows the answer.
 */
async function continueFreshIfStale(graph: WorkflowGraph, options: RunOptions, node: WorkflowNode): Promise<void> {
  if (!options.continueFresh || options.loadedStamp === undefined) return;
  if (runnerStamp(graph) === options.loadedStamp) return;
  console.log(`${c.dim}  ${node.label} answered; the graph or the runner changed since this runner started: continuing in a fresh runner${c.reset}`);
  await options.continueFresh();
}

// An answer that comes while the person is still at the card is picked up at
// once; a gate that has waited longer is waiting on someone who walked away,
// and a few seconds more cost nothing. Polling every 3s for days made paused
// runs 7.9 backend calls a second (ct-56547).
export const GATE_POLL_FAST_MS = 3000;
export const GATE_POLL_SLOW_MS = 15_000;
export const GATE_POLL_FAST_WINDOW_MS = 2 * 60_000;
export function gatePollIntervalMs(waitedMs: number, override?: number): number {
  if (override !== undefined) return override;
  return waitedMs < GATE_POLL_FAST_WINDOW_MS ? GATE_POLL_FAST_MS : GATE_POLL_SLOW_MS;
}

/** Wait on the run's open gate: its answer, or null when the run stops waiting. */
// A gate waits on a person for as long as they take: hours, or days. It ends
// only with an answer or when the run leaves "paused" (withdrawn, cancelled);
// a clock ending the wait would read as an answer nobody gave.
async function pollGate(options: RunOptions): Promise<string | null> {
  if (!options.runId || !options.convexSiteUrl || !options.apiToken) return null;
  const startedAt = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, gatePollIntervalMs(Date.now() - startedAt, options.pollIntervalMs)));
    try {
      const resp = await fetch(`${options.convexSiteUrl}/cli/workflow-runs/poll-gate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_token: options.apiToken, run_id: options.runId }),
      });
      const data = await resp.json() as { status?: string; gate_response?: string | null; gate_answer?: string | null };
      if (data.gate_response) return withOptionWords(data.gate_response, data.gate_answer);
      // Only the run's own status ends the wait. A refused or errored poll (an
      // overloaded backend answers {error} with no status) is a poll that
      // failed, not a gate taken back: four trial gates died that way at once.
      if (resp.ok && typeof data.status === "string" && data.status !== "paused") return null;
    } catch {}
  }
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

  const { validateWorkflow, graphHash, graphNodeHashes, emptySlots } = await import("./parser");
  // A backbone runs only once a flow that extends it fills every slot.
  const errors = [...validateWorkflow(graph), ...emptySlots(graph).map((s) => `Slot '${s.id}' is empty (${s.does}): fill it from a flow that extends this one, with subgraph ${s.id} { ... }`)];
  if (errors.length > 0) {
    console.error(`${c.red}Workflow validation errors:${c.reset}`);
    errors.forEach(e => console.error(`  ${c.red}✗ ${e}${c.reset}`));
    return "invalid";
  }

  const startNode = [...graph.nodes.values()].find(n => n.type === "start")!;

  const initialContext: Record<string, string> = {};
  initialContext["project_path"] = cwd;
  initialContext["default_branch"] = detectDefaultBranch(cwd);
  // The run's own id, for a node that reports to the server about this run
  // (the line's merge step, the-line.md L12). Empty on a run with no row.
  initialContext["run_id"] = options.runId ?? "";
  // The day the run started (local), so a graph stack can group one day's
  // gates (the-line-end-to-end.md LE11: "Line · <role> · <date>").
  const today = new Date();
  initialContext["run_date"] = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const hash = graphHash(graph);

  if (options.taskId) {
    initialContext["task_id"] = options.taskId;
    await loadTaskContext(options, initialContext);
    await loadCauseHistory(options, initialContext);
  }

  if (options.planId) {
    initialContext["plan_id"] = options.planId;
    await loadPlanContext(options, initialContext);
  }

  // A malformed profile stops the run before anything runs, rather than standing in defaults.
  const profile = currentLineVars(cwd);
  if (profile instanceof LineProfileError) {
    console.error(`${c.red}✗ ${profile.message}${c.reset}`);
    if (options.runId && !options.dryRun) await reportProgress(options, profileFailure(startNode.id, profile.message));
    return "invalid";
  }
  Object.assign(initialContext, profile);
  // A run with no cause keeps its files under its own id, so a resume finds them.
  initialContext["run_dir"] = lineRunDir(cwd, !initialContext["task_id"] && options.runId ? `${slugPart(graph.name)}-${slugPart(options.runId)}` : runSlug(graph, initialContext, "run"));
  // A change frozen for this run (flows.md FL4) waits on its own branch and worktree: every station starts on it.
  Object.assign(initialContext, frozenChangeContext(initialContext["run_dir"]));

  if (options.continueFresh) options.loadedStamp = runnerStamp(graph);
  // One runner per run: a resume never drives a run a live runner holds.
  const claim = options.runId && !options.dryRun ? claimRun(options.runId) : null;
  if (claim && "heldBy" in claim) {
    console.error(`${c.yellow}Run ${options.runId} is already driven by pid ${claim.heldBy} on this machine${c.reset}`);
    return "invalid";
  }
  try {
    return await driveRun(graph, options, cwd, initialContext, startNode, hash, graphNodeHashes);
  } finally {
    claim?.release();
  }
}

async function driveRun(
  graph: WorkflowGraph,
  options: RunOptions,
  cwd: string,
  initialContext: Record<string, string>,
  startNode: WorkflowNode,
  hash: string,
  graphNodeHashes: (g: WorkflowGraph) => Array<{ id: string; h: string }>,
): Promise<WorkflowRunOutcome> {
  // Where a resumed run continues: its checkpoint on this machine, else what the row holds.
  const resumeAt = options.resume && options.runId
    ? resumePoint(graph, options.resume, readCheckpoint(initialContext["run_dir"], options.runId))
    : null;
  if (options.resume && !resumeAt) {
    console.error(`${c.red}✗ cannot resume: the run stands at ${options.resume.current_node_id ?? "no node"}, which this graph does not have${c.reset}`);
    return "invalid";
  }

  // Expand $variables in the graph goal
  if (graph.goal) {
    graph.goal = graph.goal.replace(/\$(\w+)/g, (_, key) => initialContext[key] || `$${key}`);
  }
  // A script reads the goal as $goal too, the way a prompt does: a graph run
  // with no task names its subject there (judge-review.cast, LL11).
  if (graph.goal && initialContext["goal"] === undefined) initialContext["goal"] = graph.goal;

  const state: WorkflowRunState = {
    currentNodeId: startNode.id,
    visitCounts: {},
    context: initialContext,
    completed: [],
    failed: false,
  };

  // Per-run outcome record for goal gate checking (all completed nodes)
  const nodeOutcomes: Record<string, NodeOutcome> = {};

  if (resumeAt) {
    // What the run learned before stays; what every run reads fresh (the
    // task, the profile, the run's ids) is read again.
    state.context = { ...resumeAt.context, ...initialContext };
    state.visitCounts = resumeAt.visit_counts;
    for (const [id, n] of Object.entries(state.visitCounts)) state.context[`${id}.visits`] = String(n);
    state.completed = resumeAt.completed;
    state.currentNodeId = resumeAt.node_id;
    Object.assign(nodeOutcomes, resumeAt.node_outcomes);
    // A row-built resume has no context of its own: the shared worktree is
    // named for the cause, so a station past an isolated one finds it again.
    const isolated = state.completed.map((id) => graph.nodes.get(id)).find((n) => n?.isolated);
    if (isolated && !state.context["worktree"]) {
      state.context["worktree"] = runSlug(graph, state.context, isolated.id);
      state.context["branch"] = `codecast/${state.context["worktree"]}`;
    }
    // A run waiting days at its card can lose its checkout; its branch puts it back.
    if (!options.dryRun) await restoreResumedWorktree(cwd, state.context);
    options.resumed = { node_id: resumeAt.node_id, gate: resumeAt.gate, hand: resumeAt.hand };
    console.log(`${c.dim}Resuming at ${graph.nodes.get(resumeAt.node_id)?.label ?? resumeAt.node_id} (state from the ${resumeAt.from})${c.reset}`);
    // The line's own text is read as it is now (line-versions.md LV4).
    for (const node of refreshedOnResume(graph, state.completed)) await executeCommand(node, state.context, cwd);
  }

  // The machine driving the run, so the run is resumed there when its runner
  // dies (runResume.ts). Its own report: a server without the arg rejects it.
  if (options.runId && !options.dryRun) {
    await reportProgress(options, {
      current_node_id: state.currentNodeId,
      node_id: state.currentNodeId,
      node_status: "running",
      runner_device: deviceId(),
    });
  }

  if (options.runId && !resumeAt) {
    await reportProgress(options, {
      current_node_id: startNode.id,
      node_id: startNode.id,
      node_status: "running",
      run_status: "running",
    });
  }
  // The graph the run is on now, on a start or a resume that read a newer
  // one (line-versions.md LV4). Its own report: a server without the
  // graph_hash arg rejects the whole call, and the run must still read as
  // running there.
  if (options.runId && !options.dryRun) {
    await reportProgress(options, {
      current_node_id: state.currentNodeId,
      node_id: state.currentNodeId,
      node_status: "running",
      graph_hash: hash,
      graph_nodes: graphNodeHashes(graph),
    });
  }

  console.log(`\n${c.bold}${c.cyan}━━━ Workflow: ${graph.name} ━━━${c.reset}`);
  if (graph.goal) console.log(`${c.dim}Goal: ${graph.goal}${c.reset}`);
  console.log();

  let current: WorkflowNode = await runNodeLoop(resumeAt ? graph.nodes.get(resumeAt.node_id)! : startNode, graph, state, nodeOutcomes, cwd, options);

  // An exit with `stop` ends the run on purpose, in the graph's own words for why.
  if (current.type === "exit" && current.stop && !state.failed) {
    const why = expandPromptVars(current.stop, graph, state.context).trim().replace(/\s+/g, " ");
    state.failed = true;
    state.failReason = `Stopped: ${(why || current.label).slice(0, 1000)}`;
    state.context["stopped_at"] = current.id;
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
      const queued = await queueTaskDecision(options, `${quotedTitle(state.context, options.taskId)}: review rejected. What next?`, note, current.id);
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
    if (options.planId && options.apiToken && options.convexSiteUrl && !options.dryRun) {
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
    const diskFull = options.dryRun ? null : diskFullFailReason(options.cwd ?? process.cwd(), `${state.failReason ?? ""}\n${state.context["last_error"] ?? ""}`.trim(), options.taskId);
    if (diskFull) state.failReason = diskFull.slice(0, 2000); // the run failed, not the problem: the host holds line runs, the problem requeues
    console.log(`\n${c.bold}${c.red}━━━ Workflow failed: ${state.failReason} ━━━${c.reset}`);
    // The run is reported over first: that stops its hands. The blocker
    // comment that follows goes to the session that owns the task, which is
    // often the hand itself, and a hand still reading as working is woken by
    // it: ct-59998's dead Implement hand was resumed by its own run's failure
    // comment three seconds after the run ended, and kept working the task
    // with no run waiting on it (2026-10-16).
    if (options.runId) {
      await reportProgress(options, {
        current_node_id: current.id,
        node_id: current.id,
        node_status: "failed",
        run_status: "failed",
        fail_reason: state.failReason,
      });
    }
    const requeued = diskFull && options.taskId ? await requeueAfterDiskFull((route, body) => cliCall(options, route, body), options.taskId) : null;
    if (requeued) console.log(requeued.text);
    if (!requeued?.queued) await returnTaskOnFailure(options, graph, state); // a refused requeue (a trial's) fails as usual
    return "failed";
  }
  return "completed";
}

// The repo's line profile (line-profile.md LP2), every value as $line.<key>, so a
// shipped template names no path or tool of its own. Read at a run's start and
// again before every station: a run started (or checkpointed) before the profile
// changed would otherwise run the old commands through every wait and resume.
function currentLineVars(cwd: string): Record<string, string> | LineProfileError {
  try {
    return lineProfileVars(loadLineProfile(cwd).profile);
  } catch (err) {
    if (err instanceof LineProfileError) return err;
    throw err;
  }
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
    // Within an attempt visit counts are never reset (even after retry_target jumps); a gate's answer starts the next.
    state.currentNodeId = current.id;
    const visits = (state.visitCounts[current.id] || 0) + 1;
    state.visitCounts[current.id] = visits;
    // Edges may route on how often a station has run (`build.visits >= 3`).
    state.context[`${current.id}.visits`] = String(visits);

    if (current.max_visits !== undefined && visits > current.max_visits) {
      console.log(`\n${c.red}${c.bold}  ✗ max_visits=${current.max_visits} exceeded on '${current.label}' — aborting${c.reset}`);
      state.failed = true;
      state.failReason = `max_visits=${current.max_visits} exceeded on ${current.id}`;
      break;
    }

    // A run that waited days at a card runs the commands the profile names now.
    const profile = currentLineVars(cwd);
    if (profile instanceof LineProfileError) {
      state.failed = true;
      state.failReason = profileFailure(current.id, profile.message).fail_reason;
      break;
    }
    Object.assign(state.context, profile);

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
    const checkpoint = (next?: string) => {
      if (options.runId && !options.dryRun) writeCheckpoint(state.context["run_dir"], options.runId, state, nodeOutcomes, next);
    };
    checkpoint();

    let outcome: NodeOutcome;
    const nodeStartedAt = Date.now();

    if (options.dryRun) {
      console.log(`${c.dim}  [dry-run]${c.reset}`);
      outcome = "success";
      // A dry run walks a gate through its first option, as if it were chosen.
      const option = current.type === "human" ? graph.edges.find(e => e.from === current.id && e.label) : undefined;
      if (option) state.context["human.gate.target"] = option.to;
    } else if (current.type === "start") {
      outcome = "success";
    } else if (current.type === "command") {
      outcome = await executeCommand(current, state.context, cwd);
    } else if (current.type === "call") {
      outcome = await executeCallNode(current, graph, state.context, cwd, options);
    } else if (current.type === "human" && options.runId) {
      outcome = await executeRemoteHumanGate(current, graph, state.context, options);
    } else if (current.type === "human") {
      outcome = await executeHumanGate(current, graph, state.context);
    } else if (current.type === "parallel_fanout") {
      outcome = await executeFanout(current, graph, state, cwd, options);
    } else if (current.type === "parallel_fanin") {
      outcome = "success";
    } else if ((current.type === "agent" || current.type === "prompt") && current.backend === "session") {
      outcome = await executeSessionNode(current, graph, state.context, cwd, options, () => checkpoint());
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
    // A person's answer is the next attempt: a Revise sent back to a build that spent its visits is carried out (Oct 26).
    if (current.type === "human" && outcome !== "failure" && !options.dryRun && !state.context["human.gate.no_card"]) clearVisits(state.visitCounts, state.context);

    if (options.runId) {
      await reportProgress(options, {
        current_node_id: current.id,
        node_id: current.id,
        // A gate's outcome is the key it was answered with ("s" for Ship):
        // only "failure" is a failed node.
        node_status: outcome === "failure" ? "failed" : "completed",
        outcome,
        session_id: state.context[`${current.id}.session_id`],
        // A station script's own words (the dissolve station's JSON, a
        // check's failure) are what its node shows; an agent's is what it
        // concluded, so the run reads it without loading the transcript.
        result_preview: current.type === "command" || current.type === "call" ? resultPreview(state.context[`${current.id}.output`] ?? "")
          : current.type === "agent" || current.type === "prompt" ? agentResultPreview(state.context[`${current.id}.output`] ?? "")
          : undefined,
        // A call node's cost, as the server charged it (learning-loop.md LL10).
        cost_usd: current.type === "call" ? Number(state.context[`${current.id}.cost_usd`] ?? 0) : undefined,
      });
    }

    // A hand may have moved the task (handoff, verdict); the next edge routes
    // on the task as it is now. Verdicts older than this node read as none.
    if (options.taskId && current.type !== "start" && !options.dryRun) {
      await loadTaskContext(options, state.context, nodeStartedAt);
    }
    if (options.planId && current.type !== "start" && !options.dryRun) {
      await loadPlanContext(options, state.context);
    }

    // A gate's note is for the hand it routes to (a Revise note to the
    // builder), not for every hand after it: the reviewer sees only what its
    // prompt names (the-line.md L3). A command node in between keeps it.
    if (current.type === "agent" || current.type === "prompt") delete state.context["human.message"];

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
    if (options.planId && options.apiToken && options.convexSiteUrl && current.type !== "start" && !options.dryRun) {
      try {
        await fetch(`${options.convexSiteUrl}/cli/plans/log`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: options.apiToken,
            short_id: options.planId,
            entry: `Workflow node "${current.label}" ${outcome === "failure" ? "failed" : "completed"}`,
          }),
        });
      } catch {}
    }

    // ── Stage 5: Select next node ─────────────────────────────────────────────
    // Priority: human gate target > conditional edges > unconditional edges >
    //           retry_target on failure with no edge > abort
    // A fanout's branches already ran inside executeFanout; the run continues
    // at the fanin they converge on, never down one branch again.
    // A station that pinned blocked waits on a person: it routes only on an
    // edge for a blocked handoff (the line's ask gate), never on its json, and
    // without one the run stops here.
    const stationBlocked = outcome === "failure" && state.context["station_blocked"] === current.id;
    if (stationBlocked) {
      state.context["handoff"] = "blocked";
      state.context["handoff_note"] = state.context["blocked_note"] || state.context["last_error"] || "";
    }
    // A gate that came back without an answer (its question taken back,
    // dismissed, or timed out) follows none of its choices: its labelled edges
    // are the person's answers, and nobody gave one. Only an edge conditioned
    // on that outcome routes it; without one the run stops here.
    const unanswered = current.type === "human" && outcome === "failure";
    // A station whose hand left no answer (it never ran a turn, or outlived
    // its timeout and was killed) has nothing for the next node to read: only
    // an edge that asks about the outcome routes it, never a plain one.
    const stationDead = outcome === "failure" && state.context["station_dead"] === current.id;
    delete state.context["station_dead"];
    const next = stationBlocked
      ? resolveNextNode({ ...graph, edges: graph.edges.filter((e) => e.from !== current.id || /\bhandoff\b/.test(e.condition ?? "")) }, current, state.context)
      : stationDead
        ? resolveNextNode({ ...graph, edges: graph.edges.filter((e) => e.from !== current.id || /\boutcome\b/.test(e.condition ?? "")) }, current, state.context)
      : unanswered
        ? resolveNextNode({ ...graph, edges: graph.edges.filter((e) => e.from !== current.id || (!e.label && !!e.condition)) }, current, state.context)
      : current.type === "parallel_fanout" && outcome === "success"
        ? findFanin(current, graph)
        : resolveHumanGateTarget(current, graph, state.context)
          || resolveNextNode(graph, current, state.context);
    if (stationBlocked && next) delete state.context["station_blocked"];
    if (stationBlocked && !next) {
      console.log(`\n${c.yellow}  '${current.label}' is waiting on a person; the run stops here${c.reset}`);
      state.failed = true;
      state.failReason = `${current.id} is waiting on a person`;
      break;
    }

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
      // A dead station says why it left no answer; a routable outcome no edge
      // takes names the fields its edges route on.
      state.failReason = stationDead && state.context["last_error"] ? state.context["last_error"] : deadEndReason(graph, current.id, outcome, state.context);
      break;
    }

    // A station the run comes back to is told what sent it back: the station
    // that routed here and what it said. A hand reads only what its prompt
    // names, so without this a builder sent back by a failed check could not
    // tell that round from its first and checked its own work again (ct-58757).
    if (state.completed.includes(next.id)) state.context["sent_back"] = `${current.label}: ${state.context[`${current.id}.output`] ?? ""}`.trim();
    else delete state.context["sent_back"];

    checkpoint(next.id);
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
    case "call": return "◇";
    default: return "·";
  }
}
