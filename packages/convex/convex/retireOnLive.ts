// A session whose change is live on every deploy target it touches is retired
// (flows.md FL4), however the change shipped: a flow run, a pull request merged
// by hand, `cast ship`, a direct push. A flow run's own retire (cli
// workflow/runner.ts retireSubject) covers only its subject at its end; this is
// the server's pass, run when a deploy goes live, for every session owning a
// commit that deploy carries.
//
// The session's change is every commit of its own on main (commits.conversation_id,
// from the Codecast-Session trailer or the session's own commit row), not only
// the ones this deploy carries: retiring it while an older commit of its own is
// still waiting on a target would hide the session that answers for that commit.
// The one thing the server cannot read is the session's checkout. It reads what
// the session wrote instead (file_changes, the same tool edits the client's
// attribution counts): every file it changed must be in a commit of its own on
// main made after its last edit there, so an edit left uncommitted, or committed
// only on a branch main never took, keeps it.

import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { commitBySha } from "./deployTargetsState";
import { previousCut } from "./deployCarries";
import { reachOf } from "./deployReach";
import { workspaceGrantsAccess } from "./lib/access";
import { classifyNamedWorkState, retireRefusal } from "./conversations";
import { applyHideTransition } from "./cleanup";

/** Sessions one live deploy reads: its range is normally a handful of commits. */
const SESSIONS_MAX = 25;
/** Range commits read for their sessions, newest first. */
const RANGE_COMMITS_MAX = 500;
/** A session's own commits read; one with more is a long-lived lead, left to a person. */
const OWN_COMMITS_MAX = 100;
/** A session's (and its subagents') file changes read; past this it is kept rather than judged on part of them. */
const EDITS_MAX = 4_000;
/** Reach reads per session: one per commit that touches a file no newer commit of its own does. */
const REACH_READS_MAX = 12;
/** A commit's time is git's, to the second; the edit it holds can be stamped up to a second later. */
const COMMIT_CLOCK_SLACK_MS = 1_000;

const SETTLED = new Set(["done", "dormant", "idle"]);

/**
 * Why this session must stay, or null when its change is live everywhere it goes and retiring it loses nothing.
 * Reads only, so a query (the release sweep's) can ask it too.
 */
export async function liveRetireRefusal(ctx: any, conv: Doc<"conversations">, now: number): Promise<string | null> {
  if (conv.inbox_killed_at) return "it is already stopped";
  if (conv.inbox_pinned_at) return "a person pinned it";
  if (conv.standing_role_id) return "it is a role's standing session";
  // A subagent's commits are its parent's work: the parent is the one retired.
  if (conv.is_subagent || conv.parent_conversation_id) return "it is nested in another session";
  const own: Doc<"commits">[] = await ctx.db.query("commits").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id)).take(OWN_COMMITS_MAX + 1);
  if (own.length > OWN_COMMITS_MAX) return `it has more than ${OWN_COMMITS_MAX} commits`;
  const landed = own.filter((c) => c.main_at != null && c.repository);
  if (!landed.length) return "none of its commits is on main";
  const lastCommit = Math.max(...own.map((c) => c.timestamp));
  // A person's own send, a bare "yes" included; a machine's (a run's brief or end message) is not one (subjectPark.ts).
  if ((conv.last_person_turn_at ?? 0) > lastCommit) return "a person wrote to it after its last commit";
  const uncommitted = await uncommittedEdits(ctx, conv, landed);
  if (uncommitted) return uncommitted;
  const { state } = await classifyNamedWorkState(ctx, conv, now);
  if (!SETTLED.has(state)) return `it has not settled (${state})`;
  const notLive = await notLiveOn(ctx, conv, landed);
  if (notLive) return notLive;
  return await retireRefusal(ctx, conv, conv.message_count ?? 0, now);
}

/** Retire the session when liveRetireRefusal clears it: the same kill as `cast kill` (cliRetireSession). */
export async function retireIfLive(ctx: any, conv: Doc<"conversations">, now: number): Promise<string | null> {
  const reason = await liveRetireRefusal(ctx, conv, now);
  if (reason) return reason;
  const patch = { inbox_dismissed_at: now };
  await ctx.db.patch(conv._id, patch);
  await applyHideTransition(ctx, conv, patch, { forceKill: true, cause: "deploy:retire" });
  return null;
}

/** The files the session (or a subagent of its own) changed that no commit of its own on main holds since. */
async function uncommittedEdits(ctx: any, conv: Doc<"conversations">, landed: Doc<"commits">[]): Promise<string | null> {
  const subs: Doc<"conversations">[] = await ctx.db.query("conversations").withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", conv._id)).take(50);
  const lastEdit = new Map<string, number>();
  let read = 0;
  for (const id of [conv._id, ...subs.map((s) => s._id)]) {
    const rows: Doc<"file_changes">[] = await ctx.db.query("file_changes").withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", id)).take(EDITS_MAX - read + 1);
    read += rows.length;
    if (read > EDITS_MAX) return "its edits are too many to read";
    for (const r of rows) if (r.change_type !== "commit") lastEdit.set(r.file_path, Math.max(lastEdit.get(r.file_path) ?? 0, r.timestamp));
  }
  const root = conv.git_root ? conv.git_root.replace(/\/+$/, "") + "/" : null;
  const left: string[] = [];
  for (const [path, at] of lastEdit) {
    // A file outside its checkout (a scratch file, a note) is no part of the change, as the client's attribution reads it.
    if (root && path.startsWith("/") && !path.startsWith(root)) continue;
    // A commit names repository paths; an edit names the path it wrote, absolute or from a worktree under the checkout.
    const held = landed.some((c) => c.timestamp + COMMIT_CLOCK_SLACK_MS >= at && (c.files ?? []).some((f) => path === f.filename || path.endsWith(`/${f.filename}`)));
    if (!held) left.push(root && path.startsWith(root) ? path.slice(root.length) : path);
  }
  return left.length ? `it has changes not on main: ${left.slice(0, 5).join(", ")}${left.length > 5 ? ` and ${left.length - 5} more` : ""}` : null;
}

/**
 * Which targets the session's landed commits touch that do not run them yet, or null when all do. A deploy holding a
 * commit holds every commit main ordered before it, so a commit needs its own read only for the files no newer commit
 * of the session's touches.
 */
async function notLiveOn(ctx: any, conv: Doc<"conversations">, landed: Doc<"commits">[]): Promise<string | null> {
  const canRead = (w: string) => workspaceGrantsAccess(ctx, conv.user_id, w);
  const waiting = new Set<string>();
  let reads = 0;
  for (const repository of new Set(landed.map((c) => c.repository!))) {
    const seen = new Set<string>();
    for (const c of landed.filter((x) => x.repository === repository).sort((a, b) => b.main_at! - a.main_at!)) {
      const files = c.files?.map((f) => f.filename) ?? null;
      const fresh = files ? files.filter((f) => !seen.has(f)) : null;
      if (fresh && !fresh.length) continue;
      if (++reads > REACH_READS_MAX) return "its change is too long to read";
      for (const f of files ?? []) seen.add(f);
      const reach = await reachOf(ctx, canRead, repository, { sha: c.sha, main_at: c.main_at!, merged_at: c.main_at! }, fresh);
      // A change no target ships is live once it lands, as `cast flow await-deploy` reads it.
      if (!reach || reach.state === "live") continue;
      const speaking = reach.targets.filter((t) => !t.dormant);
      for (const t of speaking.length ? speaking : reach.targets) if (t.state !== "live") waiting.add(t.target);
    }
  }
  return waiting.size ? `its change is not live yet on ${[...waiting].join(", ")}` : null;
}

/** The sessions owning a commit a live deploy carries: the one at its sha, and those in its range on main. */
async function carriedSessions(ctx: any, d: Doc<"deploys">): Promise<Id<"conversations">[]> {
  const commits: Doc<"commits">[] = [];
  const own = await commitBySha(ctx, d.repository!, d.sha!);
  if (own) commits.push(own);
  if (d.cut_at != null) {
    const from = await previousCut(ctx, d);
    commits.push(...(await ctx.db
      .query("commits")
      .withIndex("by_repository_main", (q: any) => (from != null ? q.eq("repository", d.repository).gt("main_at", from) : q.eq("repository", d.repository)).lte("main_at", d.cut_at))
      .order("desc")
      .take(RANGE_COMMITS_MAX)));
  }
  return [...new Set(commits.flatMap((c) => (c.conversation_id ? [String(c.conversation_id)] : [])))].slice(0, SESSIONS_MAX) as Id<"conversations">[];
}

/** A deploy went live (deploys.ts onDeployStatus): each session owning a commit it carries is judged in its own transaction. */
export const retireSessionsOnLive = internalMutation({
  args: { deploy: v.id("deploys") },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.deploy);
    if (!d || d.status !== "live" || !d.sha || !d.repository) return { sessions: [] };
    const sessions = await carriedSessions(ctx, d);
    for (const conversation of sessions) await ctx.scheduler.runAfter(0, internal.retireOnLive.retireSessionOnLive, { conversation });
    return { sessions: sessions.map(String) };
  },
});

export const retireSessionOnLive = internalMutation({
  args: { conversation: v.id("conversations") },
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversation);
    if (!conv) return { retired: false, reason: "it is gone" };
    const reason = await retireIfLive(ctx, conv, Date.now());
    return reason ? { retired: false, reason } : { retired: true };
  },
});
