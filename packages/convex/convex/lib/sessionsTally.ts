// The rows `cast sessions` lists (inboxForCLI): the pure tally over enriched
// inbox rows, and the rail split each dormant row's under-line reads.
import type { Doc } from "../_generated/dataModel";
import { classifyRetirement, type WorkState } from "../inboxFilters";
import { agentOwnerOfRow, isSessionActivityFresh, personWorkState, trustedStatusAt, underOwnersModel, type InboxBucket, type SessionActivity } from "@codecast/shared/contracts";
import { childrenRunningOf, sessionActivity as railActivityOf } from "@codecast/shared/contracts/sessionActivity";
import { canAnswer, LIVE_RUN_STATUSES, runShipsChange, selectSessionRun, shipOfLiveRun, type GateDecision, type ShipRunFacts } from "@codecast/shared/contracts/shipRun";
import { sessionActivityWords } from "@codecast/shared/contracts/sessionActivityWords";
import { sourceTakesSessionChange } from "@codecast/shared/contracts/flowPool";
import { runWorkflowOf } from "./runGraph";

/** What a row is doing, as `cast sessions` shows it under the row: the rail's
 *  section for a dormant row (shared sessionActivity), or a working row's live
 *  tool line. `words` is the under-line. */
export type RailActivity = { state: "working" | "shipping" | "sleeping"; flavor: string | null; words: string };

const LIVE_TRIGGER_STATUSES = new Set(["scheduled", "running", "paused"]);
// The newest triggers a dormant row's wake is read from: a session's live
// triggers are among its latest, and the read stays bounded however many it
// ever armed.
const RAIL_TRIGGER_READ = 50;
// A session rarely holds more than one live run of each status.
const RAIL_RUN_READ = 5;
const prKey = (repository: string | null | undefined, number: number) => `${(repository ?? "").toLowerCase()}#${number}`;

/**
 * The rail split of every dormant row (Working, Shipping or Sleeping, with its
 * words), from the facts the server holds: the row's own fields, its armed
 * triggers, its child rows in this inbox, its live runs (by spawner, wherever
 * they run) and the pull requests its triggers and its change name. The same
 * shared rules the web rail reads (contracts/shipRun, sessionActivity), so
 * `cast sessions` and the rail say one thing for one row. `viewer` is who asks:
 * a run's approval card they may answer reads "Your call".
 */
export async function dormantRailActivities(ctx: { db: any }, sessions: any[], now: number, viewer: string | null = null): Promise<Map<string, RailActivity>> {
  const out = new Map<string, RailActivity>();
  const dormant = sessions.filter((s) => s.work_state === "dormant");
  if (!dormant.length) return out;
  const childrenOf = new Map<string, any[]>();
  for (const s of sessions) {
    const parent = s.parent_conversation_id ?? s.spawned_by_conversation_id;
    if (parent) childrenOf.set(String(parent), [...(childrenOf.get(String(parent)) ?? []), s]);
  }
  for (const s of dormant) {
    const id = String(s._id);
    const triggers = (s.armed_trigger_kind ?? "none") !== "none"
      ? (await ctx.db.query("agent_tasks").withIndex("by_originating_conversation", (q: any) => q.eq("originating_conversation_id", s._id)).order("desc").take(RAIL_TRIGGER_READ))
        .filter((t: any) => LIVE_TRIGGER_STATUSES.has(t.status)).map((task: any) => ({ task }))
      : [];
    // Every live run the session started, on any machine: the shared rule picks the one that speaks for it.
    const raw: Doc<"workflow_runs">[] = (await Promise.all([...LIVE_RUN_STATUSES].map((status) =>
      ctx.db.query("workflow_runs").withIndex("by_spawner_status", (q: any) => q.eq("spawner_conversation_id", s._id).eq("status", status)).take(RAIL_RUN_READ)))).flat();
    // Each stamped as the run feeds stamp it (enrichRun): whether its flow takes the session's change.
    const runs = await Promise.all(raw.map(async (r) => ({ ...r, takes_change: sourceTakesSessionChange((await runWorkflowOf(ctx as any, r))?.source) })));
    const run = selectSessionRun(runs);
    const runShips = !!run && runShipsChange(run);
    const gate = run?.gate_decision_id && viewer ? await ctx.db.get(run.gate_decision_id) : null;
    // The pull requests the split reads the state of: the row's own, its run's, and each trigger's.
    const ownStatus = s.pr_status && s.pr_status.state !== "merged" && s.pr_status.state !== "closed" ? s.pr_status : null;
    const runPr = runShips && run?.pr ? run.pr : null;
    const ownPr = ownStatus ? { repository: ownStatus.repository, number: ownStatus.number } : runPr ? { repository: runPr.repository, number: runPr.number } : null;
    const named = [
      ...(ownPr ? [ownPr] : []),
      ...triggers.map((t: any) => t.task.event_filter).filter((f: any) => f?.pr_number).map((f: any) => ({ repository: f.repository ?? null, number: f.pr_number })),
    ];
    const ended = new Set<string>();
    for (const pr of named) {
      if (!pr.repository) continue;
      const row = await ctx.db.query("pull_requests").withIndex("by_repository_number", (q: any) => q.eq("repository", pr.repository).eq("number", pr.number)).first();
      if (row && (row.state === "merged" || row.state === "closed")) ended.add(prKey(pr.repository, pr.number));
    }
    const pr = ownPr ? `#${ownPr.number}` : null;
    const children = childrenOf.get(id) ?? [];
    const running = children.filter((c) => childrenRunningOf([c], now) > 0);
    const a = railActivityOf({
      row: s,
      triggers,
      childrenRunning: running.length,
      childWork: running.map((c) => c.title ?? "").filter(Boolean),
      ship: runShips && run ? { ...shipOfLiveRun(run as ShipRunFacts, { gateIsViewers: canAnswer(gate as GateDecision | null, viewer) }), ...(pr ? { pr } : {}) } : null,
      runShips,
      runName: run && !runShips ? run.workflow_name?.trim() || null : null,
      ownPr,
      prEnded: (p) => !!p.repository && ended.has(prKey(p.repository, p.number)),
      now,
    });
    out.set(id, { state: a.state, flavor: a.state === "sleeping" ? a.flavor : null, words: sessionActivityWords(a, now) });
  }
  return out;
}

// The `cast sessions` tally + row filter, split out of inboxForCLI as a PURE
// function over already-enriched rows. This logic has been wrong twice — a
// killed row double-counted under a comment denying it, then `-a` zeroing the
// retirement figures while listing the rows — and both times a test would have
// caught it, so it gets a seam rather than living inside a db-heavy query.
export function tallyInboxRows(
  sessions: any[],
  opts: {
    showAll?: boolean;
    stateFilter?: string | null;
    labelByConv: Map<string, string>;
    /**
     * Conversation ids the caller named explicitly (`cast sessions <id>`).
     * Subagent rows are hidden from the top-level monitor, but a row you ask
     * for by id must answer — it is the wait signal an orchestrator watches
     * for a `cast spawn --subagent` worker.
     */
    requestedIds?: Set<string>;
    // The clock the activity freshness rule reads; a query passes its frozen
    // Date.now(), a test passes a fixed instant.
    now?: number;
    /** dormantRailActivities over the same rows: each dormant row's section and words. */
    railActivity?: Map<string, RailActivity>;
  },
) {
  const now = opts.now ?? Date.now();
  // `unstamped` is a HEALTH figure, not a bucket: rows this tally had to drop
  // because an upstream emitter skipped the projection. It should always read
  // 0; a non-zero value names a gap in computeInboxSessions.
  const counts = { working: 0, needs_input: 0, done: 0, dormant: 0, idle: 0, pinned: 0, live: 0, stashed: 0, dismissed: 0, killed: 0, below_fold: 0, total: 0, unstamped: 0 };
  const rows: Array<{
    id: string;
    session_id: string;
    title: string;
    short_title: string | null;
    project_path: string | null;
    updated_at: string;
    ts: number;
    message_count: number;
    agent_type?: string;
    agent_status?: string;
    hibernated_at?: number | null;
    // A person's newest turn (see schema), on rows named by id only (inboxForCLI).
    last_person_turn_at?: number | null;
    work_state: WorkState;
    // The projection placement (shared placeInboxRow) and the fold flag, next
    // to the verdict the CLI has always tallied.
    bucket: InboxBucket;
    // Under the owners model, the agent owner a wait files under working for
    // ("With <owner>": @role, or the owning session's id); null otherwise.
    // work_state stays raw for the agents that watch it.
    with_owner: string | null;
    below_fold: boolean;
    is_killed: boolean;
    is_pinned: boolean;
    is_live: boolean;
    is_unresponsive: boolean;
    awaiting_input: boolean;
    // The park kind when the newest turn is an unresolved login / limit /
    // connection banner ("limit", "auth", ...), else null: needs_input that
    // is plumbing, not a question. The workflow runner waits out the kinds
    // that recover on their own instead of reading the park as settled.
    blocked_on: string | null;
    // Why the row's start failed (a machine's refusal, a cloud host's failed
    // preparation), else null: a hand that never started reads idle forever,
    // and the workflow runner fails its station on this instead of a timeout.
    session_error: string | null;
    idle_summary: string | null;
    thread_state: string | null;
    thread_state_status: string | null;
    waiting_on: { kind: string; ref: string; label?: string; at: number } | null;
    last_user_message: string | null;
    label: string | null;
    active_plan: { short_id: string; title: string } | null;
    active_task: { short_id: string; title: string } | null;
    // Second-party ownership: run_by = the member whose account runs the
    // session when that isn't the caller; owner = the assigned owner if any.
    run_by: string | null;
    role: { handle: string; name: string } | null;
    owner: { name: string | null; email: string | null } | null;
    owned_by_me: boolean;
    // What the row is doing, for the line under it: a dormant row's rail
    // section and words (dormantRailActivities), or a working row's live tool
    // line while its stamp is fresh (shared isSessionActivityFresh), which
    // keeps its text, tool and at; null otherwise.
    activity: (RailActivity & Partial<SessionActivity>) | null;
  }> = [];

  // A subagent row can arrive twice — the top-level recency scan and its
  // parent's child enumeration both emit it (the web dedups by _id; this
  // tally must too, or a requested subagent lists and counts double).
  const seenSubagents = new Set<string>();
  for (const s of sessions) {
    // Keep the monitor to top-level sessions — unless this row was named. A
    // subagent the viewer owns under the owners model is a top-level row.
    if (s.is_subagent && !underOwnersModel(s)) {
      const id = s._id.toString();
      if (!opts.requestedIds?.has(id) || seenSubagents.has(id)) continue;
      seenSubagents.add(id);
    }
    // The three retirement states are TALLIES, not buckets — the same shape as
    // `pinned` and `live`, and deliberately NOT mutually exclusive with the
    // work-state counts. A rendered row lands in both its work_state figure
    // and its retirement figure (a pinned killed session is counted in `idle`,
    // `pinned`, `killed` and `total`); a collapsed row appears only in its
    // retirement figure. Counting is therefore unconditional — gating it on
    // !show_all left every figure at 0 under `-a` while the rows were listed,
    // which made `stashed` useless for its whole purpose (how many agents are
    // still running). See classifyRetirement for why killed outranks the rest.
    //
    // Only the COLLAPSE is conditional. A killed row renders through: it only
    // reaches here while pinned (shouldShowInInbox drops killed-and-unpinned),
    // and pinning is how you hold onto a killed row — swallowing it was the
    // CLI overriding a decision the server already made. Stashed and dismissed
    // keep collapsing, mirroring the web's separate parked group, so
    // already-triaged sessions don't inflate the active buckets; `-a` lists them.
    const retired = classifyRetirement(s);
    if (retired) counts[retired]++;
    if (retired && retired !== "killed" && !opts.showAll) continue;
    // The verdict is STAMPED upstream (computeInboxSessions with `projection`
    // runs the shared placeInboxRow); this tally never classifies — one
    // classifier, one alphabet (sync-convergence C3).
    const work_state: WorkState = s.work_state;
    const bucket: InboxBucket = s.bucket;
    // A stampless row is a bug in whoever emitted it, but it must cost ONE
    // ROW, not the inbox. Throwing here failed the whole query, so a single
    // unstamped subagent turned `cast sessions` into "Internal error" and hid
    // every other session the user has (ct-49761). Skip it, count it, and name
    // it in the logs so the upstream gap stays visible instead of silent.
    if (!work_state || !bucket) {
      counts.unstamped++;
      console.error(`tallyInboxRows: row ${s._id} is not stamped with a projection — skipped`);
      continue;
    }
    const is_live = !!s.is_connected && s.agent_status !== "hibernated";
    // A person's figures: a wait an agent owner answers counts as working
    // (personWorkState), the way the inbox files it.
    const shownState = personWorkState(s, { bucket, work_state });
    const agent = shownState !== work_state ? agentOwnerOfRow(s) : null;

    counts.total++;
    counts[shownState]++;
    if (s.is_pinned) counts.pinned++;
    if (is_live) counts.live++;
    if (s.below_fold) counts.below_fold++;
    const rowLabel = opts.labelByConv.get(s._id.toString()) ?? null;
    const rail = opts.railActivity?.get(String(s._id));

    if (opts.stateFilter === "pinned" && !s.is_pinned) continue;
    if (opts.stateFilter === "live" && !is_live) continue;
    if (opts.stateFilter === "hibernated" && s.agent_status !== "hibernated") continue;
    if (opts.stateFilter && opts.stateFilter !== "pinned" && opts.stateFilter !== "live" && opts.stateFilter !== "hibernated" && shownState !== opts.stateFilter) continue;

    rows.push({
      id: s._id,
      session_id: s.session_id,
      title: s.title || s.last_user_message || "New Session",
      short_title: s.short_title || null,
      project_path: s.project_path || null,
      updated_at: new Date(s.updated_at).toISOString(),
      ts: s.updated_at,
      message_count: s.message_count || 0,
      agent_type: s.agent_type,
      agent_status: trustedStatusAt(s, now),
      hibernated_at: s.hibernated_at ?? null,
      work_state,
      bucket,
      with_owner: agent ? (agent.kind === "role" ? `@${s.role?.handle ?? "role"}` : agent.id.slice(0, 7)) : null,
      below_fold: !!s.below_fold,
      // A retired row (still listed while pinned, or under --all). The watch
      // stream reads it to emit a kill as a departure, not a transition.
      is_killed: !!s.inbox_killed_at,
      is_pinned: !!s.is_pinned,
      is_live,
      is_unresponsive: !!s.is_unresponsive,
      awaiting_input: !!s.awaiting_input,
      blocked_on: s.pending_api_error ? (s.pending_api_error_kind ?? "error") : null,
      session_error: s.session_error || null,
      idle_summary: s.idle_summary || null,
      // The agent's own pinned state beats the generated blurb when both exist:
      // one is what the agent says is true now, the other is a description.
      thread_state: s.thread_state || null,
      thread_state_status: s.thread_state_status || null,
      waiting_on: s.waiting_on ?? null,
      last_user_message: s.last_user_message || null,
      label: rowLabel,
      active_plan: s.active_plan ? { short_id: s.active_plan.short_id, title: s.active_plan.title } : null,
      active_task: s.active_task ? { short_id: s.active_task.short_id, title: s.active_task.title } : null,
      run_by: s.author_name ?? null,
      role: s.role ? { handle: s.role.handle, name: s.role.name } : null,
      owner: s.owner_user_id ? { name: s.owner_name ?? null, email: s.owner_email ?? null } : null,
      owned_by_me: !!s.owned_by_me,
      // A dormant row's words ride as `text` too, where scripts read a working row's tool line.
      activity: (rail ? { ...rail, text: rail.words } : null)
        ?? (isSessionActivityFresh(s.activity, work_state, now) ? { state: "working", flavor: null, words: s.activity.text, ...s.activity } : null),
    });
  }
  return { counts, rows };
}
