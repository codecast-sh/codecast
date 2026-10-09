// The hide/kill lifecycle transition: what a session's teardown IS, for every
// surface that hides one.
//
// A stash, a dismiss, a `cast kill` and the web's kill gestures all converge
// here, so the teardown a hide owes — the daemon's kill_session, the retired
// stamp, the standing schedules and queued messages a retirement cancels, and
// the nested group that comes down with the card — is written once rather than
// per caller. applyHideTransition and cascadeHideToNestedChildren are mutually
// recursive by construction (a lead's hide hides its children, each of which is
// its own transition), which is why they are one module.
//
// Split out of cleanup.ts, which keeps what it was named for: the GC sweeps and
// the admin wipes. The dependency runs one way, this file onto cleanup.ts, for
// the three empty-conversation predicates and the kill_session enqueue those
// sweeps share with a hide.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./functions";
import { refuseSeatKill } from "./lib/seatKill";
import { noteWriteCause } from "./lifecycleEvents";
import { cancelTasksBoundToConversation } from "./agentTasks";
import { cancelQueuedMessagesOnKill } from "./pendingMessages";
import { subagentEnded } from "./subagentFleet";
import { nestParentIdOf } from "./ccAccountsShared";
import { enqueueKillSessionCommand, hasLiveDraft, isGcableEmptyConversation } from "./cleanup";

// Authoritative "nothing worth keeping" check for ONE conversation — the
// denormalized flags isGcableEmptyConversation reads can lag, so confirm against
// the source tables (messages / pending_messages) and the per-user draft. Used at
// dismiss time (single conv); the batched GC sweep inlines the equivalent checks
// with a per-batch draft cache. Read-only.
export async function conversationHasNoWork(
  ctx: { db: any },
  conv: any,
): Promise<boolean> {
  if (!isGcableEmptyConversation(conv)) return false;
  const hasMsg = await ctx.db
    .query("messages")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id))
    .first();
  if (hasMsg) return false;
  const hasPending = await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conv._id))
    .first();
  if (hasPending) return false;
  const cs = await ctx.db
    .query("client_state")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", conv.user_id))
    .first();
  const drafts = cs?.drafts && typeof cs.drafts === "object" ? (cs.drafts as Record<string, unknown>) : null;
  if (drafts && hasLiveDraft(drafts[conv._id.toString()])) return false;
  return true;
}
// Pure decision for the conversation hide-transition hook (exported for tests).
//
//  "reap" — a never-prompted EMPTY pre-warm got hidden (dismissed OR stashed).
//           Quick-create eagerly boots a real agent per summon; a 0-message
//           pre-warm has nothing to preserve — leaving it running leaks a
//           zombie tmux that keeps the conversation is_connected and
//           re-surfaces it as a phantom "New session" card. The agent is
//           killed now; the hidden row goes with gcEmptyConversations.
//  "kill" — dismiss = kill. Stash is the keep-alive set-aside; dismiss retires
//           the session: tear the agent down and mark it completed (mirrors the
//           explicit killSession mutation). Gated on the TRANSITION (`doc` is
//           the pre-patch row) so a re-asserted dismiss can't re-kill, and an
//           undo (dismissed → null) never reaches here. Stays resumable.
//  "none" — a stash of a session with real work (the whole point of stash), or
//           a re-asserted dismiss.
//
// This is the decision for a PATCH; an explicit kill gesture is a desired state
// and overrides a "none" here — see applyHideTransition's forceKill.
export function classifyHideTransition(
  patch: { inbox_dismissed_at?: any; inbox_stashed_at?: any },
  doc: { inbox_dismissed_at?: number | null },
  hasNoWork: boolean,
): "reap" | "kill" | "none" {
  if (!patch.inbox_dismissed_at && !patch.inbox_stashed_at) return "none";
  if (hasNoWork) return "reap";
  if (patch.inbox_dismissed_at && !doc.inbox_dismissed_at) return "kill";
  return "none";
}

// Run the lifecycle side effects of a hide patch AFTER it has landed. `doc` is
// the PRE-patch row (the transition gate above needs the old flags). Shared by
// every hide path — the web dispatch layer and the CLI visibility mutation
// (cast dismiss/kill) — so a hide always gets the same teardown no matter which
// surface asked for it.
//
// `forceKill` marks the caller as an EXPLICIT kill gesture (cast kill, the web's
// killSession/killSessions actions) rather than a patch that merely happens to
// carry the flag.
export async function applyHideTransition(
  ctx: { db: any },
  doc: any,
  patch: { inbox_dismissed_at?: any; inbox_stashed_at?: any },
  opts?: { cascade?: boolean; forceKill?: boolean; cause?: string },
): Promise<{
  action: "reap" | "kill" | "none";
  canceledSchedules: number;
  canceledMessages: number;
  cascaded: number;
  teardownEnqueued: boolean;
}> {
  // An explicit kill naming a role's own session is refused (lib/seatKill);
  // a cascade from a parent never reaches a seat, and internal reaps carry no forceKill.
  if (opts?.forceKill && opts.cascade !== false && patch.inbox_dismissed_at) await refuseSeatKill(ctx, doc);
  const classified = classifyHideTransition(patch, doc, await conversationHasNoWork(ctx, doc));
  // Kill is a DESIRED STATE, not an event. classifyHideTransition gates on the
  // FLAG's transition, so a quiet re-assert of an already-set inbox_dismissed_at
  // (the web's optimistic re-patch, a stub-rekey field flush) classifies "none"
  // and skips teardown — right for a re-assert, wrong for a deliberate one. A
  // killed session whose worker came back (daemon resurrection) still carried
  // the flag, so `cast kill` reported "already dismissed", never enqueued
  // teardown, and the worker was unkillable through the supported path. An
  // EXPLICIT kill therefore runs the kill branch whatever the flags already
  // say; teardown is idempotent daemon-side (killing a dead pane no-ops).
  const action = classified === "none" && opts?.forceKill && patch.inbox_dismissed_at ? "kill" : classified;
  let canceledSchedules = 0;
  let canceledMessages = 0;
  let teardownEnqueued = false;
  if (action === "reap") {
    // Tear the agent down, but leave the row for gcEmptyConversations' grace
    // window. "No work" here reads only the server: a first message can still
    // be in the client's outbox (an image uploading, send-and-stash, a kill
    // from another window), and deleting the row under it loses that message
    // and strands the client's copy of the session (2026-10-01).
    teardownEnqueued = await enqueueKillSessionCommand(ctx, doc, Date.now(), `${opts?.cause ?? "hide"}:reap`);
    await subagentEnded(ctx, doc, "killed");
  } else if (action === "kill") {
    // false = an unexecuted kill_session for this conversation is ALREADY on the
    // daemon's queue (enqueueKillSessionCommand's 1h dedupe). The desired state
    // holds either way, so callers report which it was instead of piling on a
    // duplicate command. A kill the daemon already executed leaves no pending
    // row, so the re-kill that matters — the resurrection case — always inserts.
    teardownEnqueued = await enqueueKillSessionCommand(ctx, doc, Date.now(), opts?.cause ?? "hide");
    // A persistent anchor never auto-completes on a dismiss/kill — it goes
    // dormant, not retired (only decommissionAnchor clears `persistent`).
    // inbox_killed_at records when the session was FIRST killed: a forced
    // re-kill re-runs the teardown but must not rewrite that history, or the
    // row's honest "killed at" jumps forward every time a resurrection is
    // stamped out (and the cascade below claims exactly this for its children).
    const killPatch: Record<string, any> = {};
    if (!doc?.inbox_killed_at) killPatch.inbox_killed_at = Date.now();
    if (!doc?.persistent) killPatch.status = "completed";
    if (Object.keys(killPatch).length > 0) await ctx.db.patch(doc._id, killPatch);
    // A killed worker frees its fleet slot and keeps its worktree.
    if (!doc?.persistent) await subagentEnded(ctx, doc, "killed");
    // Dismiss retires the session — a standing schedule that injects
    // into it must die with it, or its next fire would silently
    // resurrect a session the user just retired. User gestures only:
    // bulk cleanup sweeps patch inbox_dismissed_at directly (not via
    // dispatch) and deliberately leave standing schedules armed. Task
    // owner = the conversation's runner (a second-party owner may be
    // triaging).
    //
    // Kill is terminal for messages ALREADY queued, or the retry loop delivers
    // one later and revives a session carrying kill metadata (and an exhausted
    // one strands the row as completed + has_pending forever). Re-runs safely on
    // a forced re-kill, taking anything queued since the first kill with it.
    //
    // Both of these are RETIREMENT effects, so a persistent anchor is exempt
    // from both: killing an anchor means dormancy, not death. Its schedules stay
    // armed on purpose — and so its queue must stay too, or the anchor wakes on
    // its next trigger and runs WITHOUT the messages the human queued for it,
    // silently. (The schedule sweep is safe to re-run: it only touches
    // scheduled/running/paused tasks, so a second pass over already-canceled
    // ones is a no-op — and a schedule re-armed since the first kill SHOULD die
    // again with it.)
    if (!doc?.persistent) {
      canceledSchedules = await cancelTasksBoundToConversation(ctx, doc.user_id, doc._id);
      canceledMessages = await cancelQueuedMessagesOnKill(ctx, doc._id);
    }
  }
  // The nested group (Task subagents + agent-team teammates) always comes down
  // with the card, no matter which surface asked — the group is one unit. Runs
  // on every hide SET (not just fresh transitions) because a stash has action
  // "none" yet must still take its children, and the per-child already-hidden
  // guard inside makes re-asserts cheap and race-safe. The cascade's own
  // per-child transition call opts out to stay single-level.
  let cascaded = 0;
  if (opts?.cascade !== false && (patch.inbox_dismissed_at || patch.inbox_stashed_at)) {
    cascaded = await cascadeHideToNestedChildren(ctx, doc, patch, { forceKill: action === "kill" && opts?.forceKill, cause: opts?.cause });
  }
  return { action, canceledSchedules, canceledMessages, cascaded, teardownEnqueued };
}

// A hide gesture on a session takes its NESTED group with it — the same set
// the inbox renders beneath the card (nestParentIdOf): Task subagents
// (parent_conversation_id) and agent-team teammates (spawned_by +
// agent_team_name). A teammate whose lead disappears deliberately floats as a
// first-class card — the categorizer can't hide it — so the cascade is the
// only place the group can come down together. The web store sweeps its own
// gesture optimistically (hideSessionInDraft); this server twin is what makes
// cast kill/dismiss and every non-web caller behave the same. Single level,
// matching the web sweep: a hidden child's own Task subagents become orphans,
// which the inbox already hides.
//
// Idempotent against the web race: a child already carrying the hide flag is
// skipped, so whichever of the client's per-child patch or this cascade lands
// second sees no transition and never re-kills. cast-spawn lineage
// (spawned_by WITHOUT a team name) and forks stay first-class — the per-child
// nestParentIdOf gate is the same one the renderer uses.
//
// `forceKill` overrides that skip: an EXPLICIT kill of the lead re-tears-down
// already-flagged children too, because the group comes down as ONE unit and a
// resurrected child is exactly the bug forcing exists to fix — a lead whose
// teammate's pane survived is as unkillable as one whose own did. Their hide
// STAMP is left alone (they are already hidden; only teardown re-runs), and the
// per-child `{ cascade: false }` still keeps the sweep single-level.
export async function cascadeHideToNestedChildren(
  ctx: { db: any },
  lead: any,
  patch: { inbox_dismissed_at?: number; inbox_stashed_at?: number },
  opts?: { forceKill?: boolean; cause?: string },
): Promise<number> {
  const field = patch.inbox_dismissed_at ? ("inbox_dismissed_at" as const) : ("inbox_stashed_at" as const);
  const stamp = patch[field];
  if (!stamp) return 0;
  const leadId = lead._id.toString();
  const [taskSubs, spawned] = await Promise.all([
    ctx.db
      .query("conversations")
      .withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", lead._id))
      .take(200),
    ctx.db
      .query("conversations")
      .withIndex("by_spawned_by", (q: any) => q.eq("spawned_by_conversation_id", lead._id))
      .take(200),
  ]);
  const seen = new Set<string>();
  const childIds: string[] = [];
  for (const child of [...taskSubs, ...spawned]) {
    const idStr = child._id.toString();
    if (idStr === leadId || seen.has(idStr)) continue;
    seen.add(idStr);
    if (nestParentIdOf(child) !== leadId) continue;
    if (child[field] && !opts?.forceKill) continue; // quiet re-assert — never re-kill
    childIds.push(idStr);
  }
  await hideNestedChildren(ctx, lead._id, field, stamp, childIds, opts);
  return childIds.length;
}

// Each child's teardown costs tens of reads, so a lead with 175 subagents
// passed Convex's 4096-read cap inside the gesture's own transaction and the
// lead could not be hidden at all (2026-10-08). The first batch goes now; the
// rest follow in scheduled batches, which stop if the lead was un-hidden since.
const CASCADE_BATCH = 20;

async function hideNestedChildren(
  ctx: { db: any; scheduler?: any },
  leadId: any,
  field: "inbox_dismissed_at" | "inbox_stashed_at",
  stamp: number,
  childIds: string[],
  opts?: { forceKill?: boolean; cause?: string },
): Promise<void> {
  const now = ctx.scheduler ? childIds.slice(0, CASCADE_BATCH) : childIds;
  for (const id of now) {
    // A copy: applyHideTransition classifies on the PRE-patch row.
    const found = await ctx.db.get(id);
    if (!found) continue;
    const child = { ...found };
    const alreadyHidden = !!child[field];
    if (alreadyHidden && !opts?.forceKill) continue;
    const childPatch = { [field]: alreadyHidden ? child[field] : stamp };
    if (!alreadyHidden) await ctx.db.patch(child._id, childPatch);
    await applyHideTransition(ctx, child, childPatch, { cascade: false, forceKill: opts?.forceKill, cause: `cascade<-${opts?.cause ?? "hide"}` });
  }
  const rest = childIds.slice(now.length);
  if (rest.length) {
    await ctx.scheduler.runAfter(0, internal.hideTransition.continueCascadeHide, {
      lead_id: leadId, field, stamp, child_ids: rest, force_kill: opts?.forceKill, cause: opts?.cause,
    });
  }
}

export const continueCascadeHide = internalMutation({
  args: {
    lead_id: v.id("conversations"),
    field: v.union(v.literal("inbox_dismissed_at"), v.literal("inbox_stashed_at")),
    stamp: v.number(),
    child_ids: v.array(v.string()),
    force_kill: v.optional(v.boolean()),
    cause: v.optional(v.string()),
  },
  handler: async (ctx, { lead_id, field, stamp, child_ids, force_kill, cause }) => {
    const lead = await ctx.db.get(lead_id);
    if (!lead || !(lead as any)[field]) return;
    if (cause) noteWriteCause(ctx, cause);
    await hideNestedChildren(ctx, lead_id, field, stamp, child_ids, { forceKill: force_kill, cause });
  },
});

