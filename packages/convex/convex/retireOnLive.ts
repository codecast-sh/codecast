// A session whose change is live on every deploy target it touches is retired
// (flows.md FL4), however the change shipped: a flow run, a pull request merged
// by hand, `cast ship`, a direct push. A flow run's own retire (cli
// workflow/runner.ts retireSubject) covers only its subject at its end; this is
// the server's pass, run when a deploy goes live, for every session owning a
// commit that deploy carries.
//
// The server never kills on what it can read alone. It picks candidates and
// proves their change live, then asks the session's own daemon
// (`retire_on_live`, cli workflow/retireOnLive.ts) to look at the real
// checkout with the checks the run-end retire uses (settled, taken over, other
// work) and retire it through cliRetireSession, whose refusals still apply. A
// daemon that does not know the command answers "Unknown command" and nothing
// happens.
//
// The session's change is every commit it made itself on main: one whose
// Codecast-Session trailer names it, or whose sha its own commit row records.
// A commit linked to it only by a guess (the one session sitting on the
// branch it was pushed to) is not its work. Retiring it while an older commit
// of its own is still waiting on a target would hide the session that answers
// for that commit. What it wrote (file_changes, the tool edits the client's
// attribution counts) must each be in a commit of its own on main made after
// its last edit there.

import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { DAEMON_COMMAND_TTL_MS } from "@codecast/shared/contracts";
import { extractSessionTrailer } from "@codecast/shared/blame";
import { commitBySha } from "./deployTargetsState";
import { previousCut } from "./deployCarries";
import { reachOf } from "./deployReach";
import { workspaceGrantsAccess } from "./lib/access";
import { classifyNamedWorkState, retireRefusal } from "./conversations";
import { enqueuePendingMessage } from "./pendingMessages";
import { extractDaemonCommandConversationId } from "./daemonCommandUtils";
import { PRESENCE_FRESH_MS } from "./presencePolicy";
import { workspaceKeyHasFeature } from "./lib/teamFeatureGuard";

/** Sessions one live deploy reads: its range is normally a handful of commits. */
const SESSIONS_MAX = 25;
/** Range commits read for their sessions, newest first. */
const RANGE_COMMITS_MAX = 500;
/** A session's own commits read; one with more is a long-lived lead, left to a person. */
const OWN_COMMITS_MAX = 100;
/** Subagents whose edits are read; past this it is kept rather than judged on part of them. */
const SUBAGENTS_MAX = 50;
/** A session's (and its subagents') file changes read; past this it is kept rather than judged on part of them. */
const EDITS_MAX = 4_000;
/** Reach reads per session: one per commit that touches a file no newer commit of its own does. */
const REACH_READS_MAX = 12;
/** A commit's time is git's, to the second; the edit it holds can be stamped up to a second later. */
const COMMIT_CLOCK_SLACK_MS = 1_000;
/** A worktree under the checkout: gitignored there, so the daemon's look at the checkout never sees its edits. */
const WORKTREE_DIR = /^\.(?:codecast|claude)\/worktrees\//;
/** The system's temporary directories: a scratch file there is nobody's change. */
const SCRATCH_DIR = /^\/(?:private\/)?(?:tmp|var\/folders)\//;

export const RETIRE_COMMAND = "retire_on_live";

/** What the daemon is asked to confirm: the commits of its own that are live, newest first, and when its own work ended. */
type Candidate = { since: number; landed: Doc<"commits">[] };

/**
 * Why this session must stay, or null when its change is live everywhere it goes and its daemon may be asked to
 * retire it. `workspace` is the deploy's: a session whose owner has no access there is no part of that deploy's pass.
 * Reads only, so a query (the release sweep's) can ask it too.
 */
export async function liveRetireRefusal(ctx: any, conv: Doc<"conversations">, now: number, opts: { workspace?: string } = {}): Promise<string | null> {
  const judged = await judge(ctx, conv, now, opts);
  return typeof judged === "string" ? judged : null;
}

async function judge(ctx: any, conv: Doc<"conversations">, now: number, opts: { workspace?: string }): Promise<string | Candidate> {
  if (conv.inbox_killed_at) return "it is already stopped";
  if (conv.inbox_pinned_at) return "a person pinned it";
  if (conv.standing_role_id) return "it is a role's standing session";
  // A subagent's commits are its parent's work: the parent is the one retired.
  if (conv.is_subagent || conv.parent_conversation_id) return "it is nested in another session";
  if (opts.workspace && !(await workspaceGrantsAccess(ctx, conv.user_id, opts.workspace))) return "it is outside the deploy's workspace";
  // Done only: dormant waits on a wake of its own (a monitor, a job, a blocker, a worker), idle never did the work.
  const { state } = await classifyNamedWorkState(ctx, conv, now);
  if (state !== "done") return `it is not done (${state})`;
  if (await watched(ctx, conv, now)) return "a person has it open";
  const work = await ownWork(ctx, conv);
  if (typeof work === "string") return work;
  const own: Doc<"commits">[] = await ctx.db.query("commits").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id)).take(OWN_COMMITS_MAX + 1);
  if (own.length > OWN_COMMITS_MAX) return `it has more than ${OWN_COMMITS_MAX} commits`;
  // A commit only guessed onto it (a branch it sat on) proves nothing about what it made.
  const made = (c: Doc<"commits">) => extractSessionTrailer(c.message) === String(conv._id) || work.hashes.some((h) => c.sha.startsWith(h));
  const landed = own.filter((c) => c.main_at != null && c.repository && made(c)).sort((a, b) => b.main_at! - a.main_at!);
  if (!landed.length) return "none of its own commits is on main";
  // A person's own send, a bare "yes" included; a machine's (a run's brief or end message) is not one (subjectPark.ts).
  // Measured against its own last edit or commit, not main's commit time, which a squash stamps at landing.
  if ((conv.last_person_turn_at ?? 0) > work.lastAt) return "a person wrote to it after its own work";
  const uncommitted = uncommittedEdits(conv, work.lastEdit, landed);
  if (uncommitted) return uncommitted;
  const notLive = await notLiveOn(ctx, conv, landed);
  if (notLive) return notLive;
  const refused = await retireRefusal(ctx, conv, conv.message_count ?? 0, now);
  return refused ?? { since: work.lastAt, landed };
}

/** A person has the session open: a focused window reporting it, or a page holding its reply stream's lease. */
async function watched(ctx: any, conv: Doc<"conversations">, now: number): Promise<boolean> {
  const viewers = await ctx.db.query("user_presence").withIndex("by_viewing_conversation", (q: any) => q.eq("viewing_conversation_id", conv._id)).take(20);
  if (viewers.some((p: any) => now - p.last_seen < PRESENCE_FRESH_MS)) return true;
  const stream = await ctx.db.query("reply_streams").withIndex("by_conversation", (q: any) => q.eq("conversation_id", conv._id)).first();
  return (stream?.watch_until ?? 0) > now;
}

/** What the session and its subagents wrote: each file's last edit, the commits its own rows record, and when its work last moved. */
async function ownWork(ctx: any, conv: Doc<"conversations">): Promise<string | { lastEdit: Map<string, number>; hashes: string[]; lastAt: number }> {
  const subs: Doc<"conversations">[] = await ctx.db.query("conversations").withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", conv._id)).take(SUBAGENTS_MAX + 1);
  if (subs.length > SUBAGENTS_MAX) return "it has too many subagents to read";
  const lastEdit = new Map<string, number>();
  const hashes: string[] = [];
  let lastAt = 0;
  let read = 0;
  for (const id of [conv._id, ...subs.map((s) => s._id)]) {
    const rows: Doc<"file_changes">[] = await ctx.db.query("file_changes").withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", id)).take(EDITS_MAX - read + 1);
    read += rows.length;
    if (read > EDITS_MAX) return "its edits are too many to read";
    for (const r of rows) {
      lastAt = Math.max(lastAt, r.timestamp);
      if (r.change_type === "commit") { if (r.commit_hash && r.commit_hash.length >= 7) hashes.push(r.commit_hash); }
      else lastEdit.set(r.file_path, Math.max(lastEdit.get(r.file_path) ?? 0, r.timestamp));
    }
  }
  return { lastEdit, hashes, lastAt };
}

/**
 * The repository path an edit names, or null for a file outside the checkout (a scratch file, another repository). An
 * edit names the path it wrote, usually absolute.
 */
export function repoPathOf(path: string, gitRoot: string | undefined): string | null {
  let rel = path;
  if (path.startsWith("/")) {
    const root = gitRoot ? gitRoot.replace(/\/+$/, "") + "/" : null;
    if (!root || !path.startsWith(root)) return null;
    rel = path.slice(root.length);
  }
  return rel.replace(/^\.\//, "");
}

/**
 * The files the session (or a subagent of its own) changed that no commit of its own on main holds since. An edit
 * outside its checkout (a second repository, a worktree elsewhere) or in a worktree under it keeps it outright: the
 * daemon checks only the checkout, where such a worktree is gitignored, so nothing would confirm that work landed. A
 * scratch file in a temporary directory is no one's change.
 */
function uncommittedEdits(conv: Doc<"conversations">, lastEdit: Map<string, number>, landed: Doc<"commits">[]): string | null {
  const left: string[] = [];
  const outside: string[] = [];
  const inWorktree: string[] = [];
  for (const [path, at] of lastEdit) {
    const rel = repoPathOf(path, conv.git_root);
    if (rel == null) {
      if (!SCRATCH_DIR.test(path)) outside.push(path);
      continue;
    }
    if (WORKTREE_DIR.test(rel)) {
      inWorktree.push(path);
      continue;
    }
    const held = landed.some((c) => c.timestamp + COMMIT_CLOCK_SLACK_MS >= at && (c.files ?? []).some((f) => f.filename === rel));
    if (!held) left.push(rel);
  }
  if (outside.length) return `it wrote outside its checkout: ${outside.slice(0, 3).join(", ")}${outside.length > 3 ? ` and ${outside.length - 3} more` : ""}`;
  if (inWorktree.length) return `it edited in a worktree: ${inWorktree.slice(0, 3).join(", ")}${inWorktree.length > 3 ? ` and ${inWorktree.length - 3} more` : ""}`;
  return left.length ? `it has changes not on main: ${left.slice(0, 5).join(", ")}${left.length > 5 ? ` and ${left.length - 5} more` : ""}` : null;
}

/**
 * Which targets the session's landed commits touch that do not run them yet, or null when all do. Every target counts,
 * a dormant one too: a target that has not shipped since does not run the change. A deploy holding a commit holds
 * every commit main ordered before it, so a commit needs its own read only for the files no newer commit of the
 * session's touches.
 */
async function notLiveOn(ctx: any, conv: Doc<"conversations">, landed: Doc<"commits">[]): Promise<string | null> {
  const canRead = (w: string) => workspaceGrantsAccess(ctx, conv.user_id, w);
  const waiting = new Set<string>();
  let reads = 0;
  for (const repository of new Set(landed.map((c) => c.repository!))) {
    const seen = new Set<string>();
    for (const c of landed.filter((x) => x.repository === repository)) {
      const files = c.files?.map((f) => f.filename) ?? null;
      const fresh = files ? files.filter((f) => !seen.has(f)) : null;
      if (fresh && !fresh.length) continue;
      if (++reads > REACH_READS_MAX) return "its change is too long to read";
      for (const f of files ?? []) seen.add(f);
      const reach = await reachOf(ctx, canRead, repository, { sha: c.sha, main_at: c.main_at!, merged_at: c.main_at! }, fresh);
      // A change no target ships is live once it lands, as `cast flow await-deploy` reads it.
      for (const t of reach?.targets ?? []) if (t.state !== "live") waiting.add(t.target);
    }
  }
  return waiting.size ? `its change is not live yet on ${[...waiting].join(", ")}` : null;
}

/** A tell the session hears when its daemon keeps it (a run's "it is over at Live"), sent once the ask has had its time. */
export type KeptTell = { content: string; client_id: string; from_user_id: Id<"users"> };

/**
 * Ask the session's daemon to retire it, or say why not. Null means asked (or already asked): the daemon decides.
 * `tell` is sent if the session is still alive once the command's time is up, whatever the daemon answered or if it
 * never did.
 */
export async function askDaemonToRetire(ctx: any, conv: Doc<"conversations">, now: number, opts: { workspace?: string; tell?: KeptTell } = {}): Promise<string | null> {
  const judged = await judge(ctx, conv, now, opts);
  if (typeof judged === "string") return judged;
  if (!conv.session_id || !conv.owner_device_id) return "it has no confirmed owning device";
  const pending: Doc<"daemon_commands">[] = await ctx.db.query("daemon_commands").withIndex("by_user_pending", (q: any) => q.eq("user_id", conv.user_id).eq("executed_at", undefined)).take(200);
  const asked = pending.some((c) => c.command === RETIRE_COMMAND && extractDaemonCommandConversationId(c.args) === String(conv._id));
  if (!asked) {
    await ctx.db.insert("daemon_commands", {
      user_id: conv.user_id,
      target_device_id: conv.owner_device_id,
      command: RETIRE_COMMAND,
      args: JSON.stringify({
        conversation_id: conv._id,
        session_id: conv.session_id,
        root: conv.git_root ?? conv.project_path,
        since: judged.since,
        commits: judged.landed.map((c) => ({ sha: c.sha, main_at: c.main_at })),
      }),
      created_at: now,
    });
  }
  if (opts.tell) await ctx.scheduler.runAfter(DAEMON_COMMAND_TTL_MS + 60_000, internal.retireOnLive.tellIfKept, { conversation: conv._id, ...opts.tell });
  return null;
}

/** The sessions owning a commit a live deploy carries: the one at its sha, and those in its range on main. */
async function carriedSessions(ctx: any, d: Doc<"deploys">): Promise<Id<"conversations">[]> {
  const commits: Doc<"commits">[] = [];
  const own = await commitBySha(ctx, d.repository!, d.sha!);
  if (own) commits.push(own);
  // Without the target's previous live cut the range is unbounded: the deploy's own commit is all that is read.
  const from = d.cut_at != null ? await previousCut(ctx, d) : null;
  if (from != null) {
    commits.push(...(await ctx.db
      .query("commits")
      .withIndex("by_repository_main", (q: any) => q.eq("repository", d.repository).gt("main_at", from).lte("main_at", d.cut_at))
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
    // Behind the deploy's workspace's retire_on_live flag while it proves itself (Union first).
    if (!(await workspaceKeyHasFeature(ctx, d.workspace, "retire_on_live"))) return { sessions: [] };
    const sessions = await carriedSessions(ctx, d);
    for (const conversation of sessions) await ctx.scheduler.runAfter(0, internal.retireOnLive.retireSessionOnLive, { conversation, workspace: d.workspace });
    return { sessions: sessions.map(String) };
  },
});

export const retireSessionOnLive = internalMutation({
  args: { conversation: v.id("conversations"), workspace: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversation);
    if (!conv) return { asked: false, reason: "it is gone" };
    const reason = await askDaemonToRetire(ctx, conv, Date.now(), { workspace: args.workspace });
    return reason ? { asked: false, reason } : { asked: true };
  },
});

/** The session is still alive once its daemon had its chance: it hears what it would have been spared, once. */
export const tellIfKept = internalMutation({
  args: { conversation: v.id("conversations"), content: v.string(), client_id: v.string(), from_user_id: v.id("users") },
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversation);
    if (!conv || conv.inbox_killed_at) return { told: false };
    const again = await ctx.db.query("pending_messages").withIndex("by_conversation_client_id", (q: any) => q.eq("conversation_id", conv._id).eq("client_id", args.client_id)).first();
    if (again) return { told: false };
    // A send refused (a hosted session the run's owner does not own) tells nobody.
    await enqueuePendingMessage(ctx, conv, args.from_user_id, { content: args.content, client_id: args.client_id }).catch(() => {});
    return { told: true };
  },
});
