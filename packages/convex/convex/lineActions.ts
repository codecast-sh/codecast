// The line workspace's actions (docs/architecture/line-workspace.md LW4):
// editing a step of a published graph, trying an edit on past cases, and
// asking an agent to change a step. Each write is a dispatch side effect
// (dispatch.ts editLineGraph, tryLineStep, askLineAgent), so the store paints
// it at once and a throw here is a refusal it takes back.
//
// A graph is edited and tried on the machine that pushed it from a file
// (workflows.origin, written by cli lineGraphEdit.graphOrigin): the app
// cannot reach a file anywhere else, and only that machine's owner may send it
// commands. A teammate's graph is edited by its owner, or by anyone who has
// pushed the same graph from their own checkout (the viewer's own row by slug).
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { canReadRun } from "./workflow_runs";
import { findConversationByAnyRef } from "./conversationSessionLookup";
import { enqueueConfigCommand } from "./users";
import { canAccessProject, resolveWorkspaceKey } from "./lib/access";
import { stationBrief } from "./lineWorkspace";
import { fileLineCauseCore, startLineCauseCore, type LineCauseInput } from "./lineCause";

/** The most cases one try runs: each is a whole agent turn on the publishing machine. */
export const TRY_MAX_CASES = 8;
/** A case's brief as the command carries it; a longer one is cut (and so cannot be patched, and falls back to the checkpoint). */
const TRY_BRIEF_MAX_CHARS = 60_000;
const TEXT_MAX_CHARS = 100_000;

/** A short content hash, the same for the same text everywhere (FNV-1a, 32 bits). */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The row whose machine edits and tries the graph the viewer is looking at:
 * the row itself when the viewer pushed it from a file, else the viewer's own
 * push of the same graph (by slug). Throws the reason in words otherwise.
 */
export async function editableGraph(ctx: any, userId: Id<"users">, workflowId: Id<"workflows">): Promise<Doc<"workflows"> & { origin: NonNullable<Doc<"workflows">["origin"]> }> {
  const drawn: Doc<"workflows"> | null = await ctx.db.get(workflowId);
  if (!drawn) throw new ConvexError("This graph is not saved in codecast");
  const own: Doc<"workflows"> | null = drawn.user_id === userId
    ? drawn
    : await ctx.db.query("workflows").withIndex("by_user_slug", (q: any) => q.eq("user_id", userId).eq("slug", drawn.slug)).first();
  // A teammate's graph and the viewer's own row share only a slug: they are one graph when both
  // were pushed from the same .cast in their checkouts. Another file is another graph, and its edits
  // would land in a repo the runs never read.
  if (own?.origin && own !== drawn && drawn.origin && own.origin.file !== drawn.origin.file) {
    throw new ConvexError(`Your ${own.name} is another graph (${own.origin.file}, where this one is ${drawn.origin.file}), so its owner edits this one. To edit it yourself, push ${drawn.origin.file} from your own checkout: cast workflow push ${drawn.origin.file}`);
  }
  if (own?.origin) return own as any;
  if (drawn.user_id !== userId) {
    throw new ConvexError(`${drawn.name} was pushed from a teammate's machine, so its owner edits it. To edit it yourself, push it from your own checkout: cast workflow push <its .cast file>`);
  }
  throw new ConvexError(`codecast does not know which file ${drawn.name} lives in: push it once from its checkout (cast workflow push <its .cast file>), then edit it here`);
}

/** The step's hash in the graph as last pushed. */
const nodeHashOf = (row: { origin?: { nodes: Array<{ id: string; h: string }> } | null }, nodeId: string) =>
  row.origin?.nodes.find((n) => n.id === nodeId)?.h ?? null;

// ── edit ────────────────────────────────────────────────────────────────────

export type GraphEditInput = { node: string; field?: "prompt" | "script"; text: string; base_hash?: string | null; base_text?: string | null };

/**
 * Save one step's prompt or script: hands the daemon on the graph's machine a
 * line_graph_edit under the store's request id, so sessionCommands settles
 * the store's row from its answer (and its later push report).
 */
export async function editLineGraphCore(ctx: any, userId: Id<"users">, requestId: string, workflowId: Id<"workflows">, input: GraphEditInput) {
  const row = await editableGraph(ctx, userId, workflowId);
  const field = input.field ?? "prompt";
  if (field !== "prompt" && field !== "script") throw new ConvexError("A step's prompt or script is what can be edited");
  if (typeof input.text !== "string" || !input.text.trim()) throw new ConvexError(`A step's ${field} cannot be empty`);
  if (input.text.length > TEXT_MAX_CHARS) throw new ConvexError(`A step's ${field} is at most ${TEXT_MAX_CHARS.toLocaleString()} characters`);
  const node = row.nodes.find((n) => n.id === input.node);
  if (!node) throw new ConvexError(`${row.name} has no step "${input.node}"`);
  // The text the edit was made from travels too: a checkout holding other text refuses rather than mix the two.
  const baseText = typeof input.base_text === "string" && input.base_text.length <= TEXT_MAX_CHARS ? input.base_text : null;
  const args = { root: row.origin.root, file: row.origin.file, node: node.id, field, text: input.text, ...(input.base_hash ? { base_hash: input.base_hash } : {}), ...(baseText !== null ? { base_text: baseText } : {}) };
  const commandId = await enqueueConfigCommand(ctx, userId, "line_graph_edit", JSON.stringify(args), row.origin.device_id, requestId);
  return { command_id: commandId, workflow_id: row._id };
}

// ── try ─────────────────────────────────────────────────────────────────────

/** `base_text` is the text the edit was made from (the drawn graph's step), so the edit replays as the person made it even when the machine's copy differs. */
export type TryInput = { node: string; text: string; runs: string[]; base_hash?: string | null; base_text?: string | null };

/** What a step decided when a case ran: its outcome, its pinned words, its json. */
function oldDecision(nodeStatus: any, conv: any) {
  let result: unknown;
  try { result = conv?.thread_state_result ? JSON.parse(conv.thread_state_result) : undefined; } catch { result = undefined; }
  const words = typeof conv?.thread_state === "string" ? conv.thread_state.split("\n").find((l: string) => l.trim())?.trim().slice(0, 600) : undefined;
  return {
    ...(nodeStatus?.outcome ? { outcome: String(nodeStatus.outcome) } : {}),
    ...(words ? { words } : {}),
    ...(result && typeof result === "object" ? { result } : {}),
  };
}

/**
 * Run a step's edited prompt on chosen past cases. One line_tries row per
 * case, queued, then one line_try command to the graph's machine carrying
 * each case's brief; the daemon reports each row as it settles.
 */
export async function tryLineStepCore(ctx: any, userId: Id<"users">, tryId: string, workflowId: Id<"workflows">, input: TryInput) {
  if (!tryId || tryId.length > 64) throw new ConvexError("A try needs its id");
  const existing = await ctx.db.query("line_tries").withIndex("by_try", (q: any) => q.eq("try_id", tryId)).take(TRY_MAX_CASES);
  if (existing.length) return { try_id: tryId, rows: existing.map((r: any) => String(r._id)) };
  const runIds = [...new Set(input.runs ?? [])];
  if (!runIds.length) throw new ConvexError("Pick at least one case to try the edit on");
  if (runIds.length > TRY_MAX_CASES) throw new ConvexError(`A try runs at most ${TRY_MAX_CASES} cases at once`);
  if (typeof input.text !== "string" || !input.text.trim()) throw new ConvexError("Try needs the edited prompt");
  if (input.text.length > TEXT_MAX_CHARS) throw new ConvexError(`A prompt is at most ${TEXT_MAX_CHARS.toLocaleString()} characters`);
  const row = await editableGraph(ctx, userId, workflowId);
  const node = row.nodes.find((n) => n.id === input.node);
  if (!node) throw new ConvexError(`${row.name} has no step "${input.node}"`);
  if (!node.prompt || node.type === "command" || node.type === "human") throw new ConvexError(`${node.label} is not an agent's step, so there is no prompt to try`);
  const current = nodeHashOf(row, node.id);
  const now = Date.now();
  const text_hash = textHash(input.text);
  const cases: Array<{ row_id: string; run_id: string; received: string | null }> = [];
  const rows: Id<"line_tries">[] = [];
  for (const runId of runIds) {
    const run: any = await ctx.db.get(runId as Id<"workflow_runs">).catch(() => null);
    if (!run || !(await canReadRun(ctx, userId, run))) throw new ConvexError("A case you picked is not one you can read");
    const status = (run.node_statuses ?? []).find((n: any) => n.node_id === node.id);
    if (!status) throw new ConvexError(`Case ${run.goal_override ?? runId} never reached ${node.label}`);
    const conv: any = status.session_id ? await findConversationByAnyRef(ctx, status.session_id, run.user_id) : null;
    const brief = conv ? await stationBrief(ctx, conv._id) : { text: "", found: false };
    const ranHash = (run.graph_nodes ?? []).find((n: any) => n.id === node.id)?.h ?? null;
    const task: any = run.task_id ? await ctx.db.get(run.task_id) : null;
    const id = await ctx.db.insert("line_tries", {
      key: `${tryId}:${String(run._id)}`,
      try_id: tryId,
      workspace: await resolveWorkspaceKey(ctx, run),
      ...(run.team_id ? { team_id: run.team_id } : {}),
      ...(task?.project_id ? { project_id: task.project_id } : {}),
      workflow_id: row._id,
      node_id: node.id,
      run_id: run._id,
      ...(run.task_id ? { case_id: run.task_id } : {}),
      by: userId,
      at: now,
      updated_at: now,
      status: "queued",
      ...(ranHash && current && ranHash !== current ? { older_text: true } : {}),
      model: node.model || "opus",
      ...(input.base_hash ? { base_hash: input.base_hash } : {}),
      text_hash,
      old: oldDecision(status, conv),
      device_id: row.origin.device_id,
    });
    rows.push(id);
    cases.push({ row_id: String(id), run_id: String(run._id), received: brief.found && brief.text.length <= TRY_BRIEF_MAX_CHARS ? brief.text : null });
  }
  const args = {
    try_id: tryId, root: row.origin.root, file: row.origin.file, node: node.id, model: node.model || "opus",
    old_template: typeof input.base_text === "string" && input.base_text.trim() ? input.base_text : node.prompt, new_template: input.text, cases,
  };
  const commandId = await enqueueConfigCommand(ctx, userId, "line_try", JSON.stringify(args), row.origin.device_id);
  for (const id of rows) await ctx.db.patch(id, { command_id: commandId });
  return { try_id: tryId, rows: rows.map(String), command_id: commandId };
}

const TRY_STATUS_ORDER = { queued: 0, running: 1, done: 2, not_tryable: 2, failed: 2 } as const;

const tryDecisionV = v.object({ status: v.optional(v.union(v.string(), v.null())), words: v.optional(v.string()), result: v.optional(v.union(v.any(), v.null())) });

/** The daemon's report on one case (cli lineTry.ts LineTryReport). Only the machine owner who asked writes it, and a settled case stays settled. */
export const reportTry = mutation({
  args: {
    api_token: v.string(),
    row_id: v.id("line_tries"),
    report: v.object({
      status: v.union(v.literal("running"), v.literal("done"), v.literal("not_tryable"), v.literal("failed")),
      reason: v.optional(v.string()),
      via: v.optional(v.union(v.literal("patch"), v.literal("checkpoint"))),
      decision: v.optional(v.union(tryDecisionV, v.null())),
      reply: v.optional(v.string()),
      cost_usd: v.optional(v.number()),
      turns: v.optional(v.number()),
      refused: v.optional(v.array(v.string())),
      took_ms: v.optional(v.number()),
    }),
  },
  handler: async (ctx, { api_token, row_id, report }) => {
    const auth = await verifyApiToken(ctx, api_token);
    if (!auth) return { error: "Unauthorized" };
    const row = await ctx.db.get(row_id);
    if (!row || row.by !== auth.userId) return { error: "Not found" };
    if (TRY_STATUS_ORDER[row.status] >= TRY_STATUS_ORDER[report.status] && row.status !== "queued") return { ok: true, ignored: true };
    const d = report.decision;
    await ctx.db.patch(row_id, {
      status: report.status,
      updated_at: Date.now(),
      ...(report.reason ? { reason: report.reason.slice(0, 600) } : {}),
      ...(report.via ? { via: report.via } : {}),
      ...(d ? { new: { ...(d.status ? { status: d.status } : {}), ...(d.words ? { words: d.words.slice(0, 600) } : {}), ...(d.result && typeof d.result === "object" ? { result: d.result } : {}) } } : {}),
      ...(report.reply ? { reply: report.reply.slice(0, 8000) } : {}),
      ...(typeof report.cost_usd === "number" ? { cost_usd: report.cost_usd } : {}),
      ...(typeof report.turns === "number" ? { turns: report.turns } : {}),
      ...(report.refused ? { refused: report.refused.slice(0, 40).map((r) => r.slice(0, 300)) } : {}),
      ...(typeof report.took_ms === "number" ? { took_ms: report.took_ms } : {}),
    });
    return { ok: true };
  },
});

/** The tries a project's feed carries, newest first. */
const TRIES_CAP = 400;

/** A try's case as every reader gets it, with its machine's pickup when it has not started. */
const shapeTry = (r: Doc<"line_tries">, command: Doc<"daemon_commands"> | null) => ({
  _id: String(r._id),
  key: r.key,
  try_id: r.try_id,
  workspace: r.workspace,
  ...(r.team_id ? { team_id: String(r.team_id) } : {}),
  ...(r.project_id ? { project_id: String(r.project_id) } : {}),
  workflow_id: String(r.workflow_id),
  node_id: r.node_id,
  run_id: String(r.run_id),
  ...(r.case_id ? { case_id: String(r.case_id) } : {}),
  by: String(r.by),
  at: r.at,
  updated_at: r.updated_at,
  status: r.status,
  ...(r.reason ? { reason: r.reason } : {}),
  ...(r.older_text ? { older_text: true } : {}),
  model: r.model,
  ...(r.base_hash ? { base_hash: r.base_hash } : {}),
  text_hash: r.text_hash,
  ...(r.via ? { via: r.via } : {}),
  old: r.old,
  ...(r.new ? { new: r.new } : {}),
  ...(r.reply ? { reply: r.reply } : {}),
  ...(typeof r.cost_usd === "number" ? { cost_usd: r.cost_usd } : {}),
  ...(typeof r.turns === "number" ? { turns: r.turns } : {}),
  ...(r.refused ? { refused: r.refused } : {}),
  ...(typeof r.took_ms === "number" ? { took_ms: r.took_ms } : {}),
  // A case still queued says whether its machine took the command, or why it never will.
  ...(r.status === "queued" && command ? { pickup: command.error ? { error: command.error } : command.executed_at ? { at: command.executed_at } : { waiting: true } } : {}),
});

/** A project's tries: the cases the viewer may read (their run's workspace is the project's, or the viewer asked), newest first. */
export const tries = query({
  args: { project_id: v.id("projects") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const project = await ctx.db.get(args.project_id);
    if (!project || !(await canAccessProject(ctx, userId, project))) return [];
    const workspace = project.workspace ?? (await resolveWorkspaceKey(ctx, project));
    const rows = await ctx.db.query("line_tries").withIndex("by_project_at", (q) => q.eq("project_id", args.project_id)).order("desc").take(TRIES_CAP);
    const commands = new Map<string, Doc<"daemon_commands"> | null>();
    const out = [];
    for (const r of rows) {
      if (r.workspace !== workspace && r.by !== userId) continue;
      let command: Doc<"daemon_commands"> | null = null;
      if (r.status === "queued" && r.command_id) {
        const k = String(r.command_id);
        if (!commands.has(k)) commands.set(k, await ctx.db.get(r.command_id));
        command = commands.get(k) ?? null;
      }
      out.push(shapeTry(r, command));
    }
    return out;
  },
});

/** The versions of the graph a project draws, newest first, when the viewer may read the graph (it is theirs, or they read a run of it). */
export const versions = query({
  args: { workflow_id: v.id("workflows") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const row = await ctx.db.get(args.workflow_id);
    if (!row) return [];
    if (row.user_id !== userId) {
      const runs = await ctx.db.query("workflow_runs").withIndex("by_workflow_id", (q) => q.eq("workflow_id", args.workflow_id)).order("desc").take(5);
      let readable = false;
      for (const r of runs) if (await canReadRun(ctx, userId, r)) { readable = true; break; }
      if (!readable) return [];
    }
    // The viewer's own push of the same graph carries the versions their edits make.
    const own = row.user_id === userId ? row : await ctx.db.query("workflows").withIndex("by_user_slug", (q) => q.eq("user_id", userId).eq("slug", row.slug)).first();
    const ids = [...new Set([String(row._id), ...(own ? [String(own._id)] : [])])] as Id<"workflows">[];
    const out = [];
    for (const id of ids) {
      const vs = await ctx.db.query("workflow_versions").withIndex("by_workflow_at", (q) => q.eq("workflow_id", id)).order("desc").take(100);
      for (const ver of vs) out.push({ _id: String(ver._id), workflow_id: String(args.workflow_id), pushed_to: String(id), graph_hash: ver.graph_hash, nodes: ver.nodes, changed: ver.changed, by: String(ver.by), at: ver.at });
    }
    return out.sort((a, b) => b.at - a.at);
  },
});

/** Whether the viewer can edit and try the graph a project draws, and where, or why not: the drawer's Save and Try read it before offering either. */
export const editability = query({
  args: { workflow_id: v.id("workflows") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    try {
      const row = await editableGraph(ctx, userId, args.workflow_id);
      return { _id: String(args.workflow_id), editable: true as const, file: row.origin.file, files: row.origin.files, device_id: row.origin.device_id, nodes: row.origin.nodes, target: String(row._id) };
    } catch (err) {
      return { _id: String(args.workflow_id), editable: false as const, reason: err instanceof ConvexError ? String(err.data) : "This graph cannot be edited here" };
    }
  },
});

// ── ask an agent ────────────────────────────────────────────────────────────

/**
 * Ask an agent to change a step (LX6): the cause is filed through the line
 * composer's own path, the person's words and the labeled cases its first
 * signal, and the project's line is started on it. A line nobody leads files
 * the cause and says why it did not start, rather than refuse the words.
 */
export async function askLineAgentCore(ctx: any, userId: Id<"users">, clientKey: string, projectId: Id<"projects">, input: LineCauseInput) {
  const filed = await fileLineCauseCore(ctx, userId, clientKey, projectId, input);
  // A replayed ask whose run already started answers with that run.
  const task: any = await ctx.db.get(filed.task_id);
  if (task?.workflow_run_id) return { ...filed, started: true as const, run_id: task.workflow_run_id };
  try {
    const started = await startLineCauseCore(ctx, userId, filed.task_id as Id<"tasks">);
    return { ...filed, started: true as const, run_id: started.run_id, role_handle: started.role_handle };
  } catch (err) {
    if (!(err instanceof ConvexError)) throw err;
    return { ...filed, started: false as const, reason: String(err.data) };
  }
}
