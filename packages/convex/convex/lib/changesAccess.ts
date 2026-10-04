// The one gate between sessions and the Changes page (docs/proposals/
// changes-page.md 8.4). Stories and editions are team-only rows with no
// `workspace` key, so they stay safe only if no private input ever enters
// them. Every read of `conversations` or `session_insights` by a changes*
// module goes through here; changesAccess.guard.test.ts fails on any other.
//
// A conversation passes when the team can already read it, by the same rules
// the team feed applies (createTeamFeedFilter: sharing, a locked-private
// override, the owner's membership level at the session's start), when its
// owner is still a member, when its visible team is this team, and when its
// effective visibility mode is above `minimal`. The mode decides what prose
// may use: `summary` allows the insight's headline and summary, `full` (the
// feed's `full` or `detailed`) allows its turns, its images and its edits to
// instruction text too. An insight written while the session sat in another
// team is withheld even when the session itself passes.

import type { Doc, Id } from "../_generated/dataModel";
import { conversationRepository, createTeamFeedFilter, getOwnerMembership, resolveVisibilityMode, teamVisibleConvTeam } from "../privacy";
import { effectiveMembershipVisibility, type TeamVisibilityLevel } from "../teamVisibility";
import { sessionImages, sessionInstructionEdits, type InstructionEdit } from "./sessionMedia";

type DbCtx = { db: any };

export type ChangesInputMode = "summary" | "full";

/** The insight fields prose may read. goal, what_changed, key_changes,
 *  next_action and themes never leave this module. */
export type ChangesInsight = {
  _id: Id<"session_insights">;
  generated_at: number;
  headline?: string;
  summary: string;
  outcome_type: Doc<"session_insights">["outcome_type"];
  // Present only at mode `full`.
  turns?: Array<{ ask: string; did: string[] }>;
};

export type TeamVisibleInput = {
  conversation_id: Id<"conversations">;
  owner_id: Id<"users">;
  started_at: number;
  title?: string;
  active_task_id?: Id<"tasks">;
  mode: ChangesInputMode;
  // The owner's membership level for this session (history-aware). Hashed
  // into a story's inputs_hash so a level change regenerates its prose.
  membership_level: TeamVisibilityLevel;
  insight: ChangesInsight | null;
  /** The repository the session ran in, from its git remote; absent when it recorded none. */
  repository?: string;
  /** Where it ran (its git root, else its project path), for resolving a repository through the owner's repo_sources. Never written into a row. */
  checkout_root?: string;
};

function inputMode(mode: string): ChangesInputMode | null {
  if (mode === "full" || mode === "detailed") return "full";
  if (mode === "summary") return "summary";
  return null;
}

function projectInsight(row: Doc<"session_insights">, mode: ChangesInputMode): ChangesInsight {
  return {
    _id: row._id,
    generated_at: row.generated_at,
    headline: row.headline,
    summary: row.summary,
    outcome_type: row.outcome_type,
    ...(mode === "full" && row.turns ? { turns: row.turns } : {}),
  };
}

/** The level the owner shows one session at in a team, read from the
 *  membership's visibility_history at the session's start. */
export async function ownerMembershipVisibilityAt(
  ctx: DbCtx,
  ownerId: Id<"users">,
  teamId: Id<"teams">,
  startedAt: number | undefined,
): Promise<TeamVisibilityLevel> {
  return effectiveMembershipVisibility(await getOwnerMembership(ctx, ownerId, teamId), startedAt);
}

/** For each conversation the team may draw on, its mode and its gated insight,
 *  keyed by conversation id. A conversation missing from the map contributes
 *  nothing but the commit text already readable through canAccessCommit. */
export async function teamVisibleInputs(
  ctx: DbCtx,
  teamId: Id<"teams">,
  conversationIds: Iterable<Id<"conversations">>,
): Promise<Map<string, TeamVisibleInput>> {
  const out = new Map<string, TeamVisibleInput>();
  const ids = [...new Set([...conversationIds].map(String))] as Id<"conversations">[];
  if (ids.length === 0) return out;

  const filter = await createTeamFeedFilter(ctx, teamId);
  // A former member's sessions keep their team_id and sharing, and the feed
  // filter reads a missing membership as the default level, so ending a
  // membership withdraws only through this check.
  const members = new Set(filter.memberships.map((m) => String(m.user_id)));
  const conversations: Array<Doc<"conversations"> | null> = await Promise.all(ids.map((id) => ctx.db.get(id)));

  await Promise.all(conversations.map(async (conv) => {
    if (!conv || !members.has(String(conv.user_id))) return;
    if (String(teamVisibleConvTeam(conv)) !== String(teamId)) return;
    if (!filter.isVisible(conv)) return;
    const level = filter.getVisibilityFor(conv) as TeamVisibilityLevel;
    const mode = inputMode(resolveVisibilityMode(conv.team_visibility, level, true));
    if (!mode) return;

    const insight: Doc<"session_insights"> | null = await ctx.db
      .query("session_insights")
      .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id))
      .first();
    out.set(String(conv._id), {
      conversation_id: conv._id,
      owner_id: conv.user_id,
      started_at: conv.started_at,
      title: conv.title,
      active_task_id: conv.active_task_id,
      mode,
      membership_level: level,
      insight: insight && String(insight.team_id) === String(teamId) ? projectInsight(insight, mode) : null,
      repository: conversationRepository(conv),
      checkout_root: conv.git_root ?? conv.project_path ?? undefined,
    });
  }));
  return out;
}

/** The team's insights generated since `since` whose sessions pass the gate,
 *  newest first, each with its input. For "In the works", which starts from
 *  insights rather than from commits. */
export async function teamVisibleRecentInsights(
  ctx: DbCtx,
  teamId: Id<"teams">,
  since: number,
  limit = 200,
): Promise<Array<TeamVisibleInput & { insight: ChangesInsight }>> {
  const rows: Doc<"session_insights">[] = await ctx.db
    .query("session_insights")
    .withIndex("by_team_generated_at", (q: any) => q.eq("team_id", teamId).gte("generated_at", since))
    .order("desc")
    .take(limit);
  const inputs = await teamVisibleInputs(ctx, teamId, rows.map((r) => r.conversation_id));
  const out: Array<TeamVisibleInput & { insight: ChangesInsight }> = [];
  for (const row of rows) {
    const input = inputs.get(String(row.conversation_id));
    // The gate reads the conversation's current insight; a stale duplicate row
    // never stands in for it.
    if (input?.insight && String(input.insight._id) === String(row._id)) {
      out.push(input as TeamVisibleInput & { insight: ChangesInsight });
    }
  }
  return out;
}

/** What a story may show from one session: images it posted and its edits to instruction text. */
export type ChangesMedia = {
  images: Array<{ url: string; timestamp: number; context: string }>;
  edits: InstructionEdit[];
};

const MEDIA_IMAGES_PER_SESSION = 4;
const MEDIA_EDITS_PER_SESSION = 3;
const MEDIA_EDIT_CHARS = 900;
const MEDIA_CONTEXT_CHARS = 220;

/** A message's words around an image: its text with image markup and links dropped, clipped. */
function imageContext(content: string | undefined): string {
  const text = (content ?? "").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  return text.length > MEDIA_CONTEXT_CHARS ? `${text.slice(0, MEDIA_CONTEXT_CHARS - 1)}…` : text;
}

/**
 * The media a story may draw on, per conversation, read only for sessions the
 * team sees in full: the same mode that lets their turns into prose. A
 * session at `summary` contributes nothing here, however much it made.
 */
export async function teamVisibleMedia(
  ctx: DbCtx & { storage?: { getUrl: (id: any) => Promise<string | null> } },
  inputs: ReadonlyArray<Pick<TeamVisibleInput, "conversation_id" | "mode">>,
  window: { since: number; until: number },
): Promise<Map<string, ChangesMedia>> {
  const out = new Map<string, ChangesMedia>();
  for (const input of inputs) {
    if (input.mode !== "full") continue;
    const found = await sessionImages(ctx, input.conversation_id, { ...window, max: MEDIA_IMAGES_PER_SESSION });
    const images = [];
    for (const img of found) {
      const message: Doc<"messages"> | null = await ctx.db.get(img.message_id);
      images.push({ url: img.url, timestamp: img.timestamp, context: imageContext(message?.content) });
    }
    const edits = await sessionInstructionEdits(ctx, input.conversation_id, { ...window, max: MEDIA_EDITS_PER_SESSION, chars: MEDIA_EDIT_CHARS });
    if (images.length || edits.length) out.set(String(input.conversation_id), { images: images.reverse(), edits });
  }
  return out;
}
