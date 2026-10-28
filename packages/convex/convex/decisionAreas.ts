// Who decides for which areas (contracts/decisionAreas). Each member of a
// team has takes-decisions and the projects they decide for, on
// team_memberships; decisionRouting.ts shares decisions out by them.
//
// Areas are set in plain words, never a settings form. One model call on the
// team's model budget (modelCalls.runModelCall) maps the words onto the
// team's members and projects, and applying the map writes each member's
// areas. Three ways in:
// - "Change areas" on the Decisions page's Team view: mapAreas previews the
//   map, and the store's applyDecisionAreas applies it (dispatch).
// - `cast team focus "<words>"` (focusForCli): maps and applies, or previews
//   with --dry-run.
// - A workspace with no areas asks its admins once, as a decision card
//   (askForAreas): "Who decides for which areas?", its first option a split
//   drawn from project leads, the people each role keeps and who answered
//   which decisions before. Picking it applies the split; an answer in their
//   own words is mapped and applied the same way (settleAreasCard).
import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { nextShortId } from "./counters";
import { runModelCall } from "./modelCalls";
import { CHEAP_MODEL } from "./lib/anthropic";
import { syncDecisionInbox } from "./lib/decisionInbox";
import { withdrawCore } from "./sessionDecisions";
import { allRolesInBoundary } from "./lib/orgAccess";
import { projectLeadOf } from "@codecast/shared/contracts/orgLead";
import {
  AREAS_CARD_LEAVE,
  AREAS_CARD_QUESTION,
  AREAS_CARD_USE,
  AREAS_MAX_TOKENS,
  AREAS_SYSTEM,
  areasPrompt,
  areasText,
  parseAreasReply,
  proposeSplit,
  takesDecisions,
  type AreaAssignment,
  type AreaSignal,
  type AreasRosterMember,
  type AreasRosterProject,
} from "@codecast/shared/contracts/decisionAreas";

type Ctx = { db: any; scheduler?: any };

/** Areas are worth asking about only when there are people to share among. */
const AREAS_MIN_PEOPLE = 2;
/** How long a team the card found nothing to ask of goes before an ask looks again. */
export const AREAS_RECHECK_MS = 24 * 60 * 60 * 1000;

/** A map as the preview shows it: each member with the projects they decide for. */
export type AreasPreview = {
  assignments: Array<AreaAssignment & { name: string; projects: Array<{ id: string; title: string }> }>;
  unplaced: string[];
  text: string;
};
export type AreasRoster = { team_id: Id<"teams">; members: AreasRosterMember[]; projects: AreasRosterProject[]; takes: Record<string, boolean>; current: AreaAssignment[] };

const nameOfUser = (u: Doc<"users"> | null) => u?.name || u?.github_username || u?.email || "a teammate";

/** The people (never bots) and live projects of a team, with the areas they have now. */
export async function areasRoster(ctx: Ctx, teamId: Id<"teams">): Promise<AreasRoster> {
  const memberships: Doc<"team_memberships">[] = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect();
  const members: AreasRosterMember[] = [];
  const takes: Record<string, boolean> = {};
  const current: AreaAssignment[] = [];
  for (const m of memberships) {
    const u: Doc<"users"> | null = await ctx.db.get(m.user_id);
    if (!u || u.is_bot) continue;
    members.push({ user_id: String(u._id), name: nameOfUser(u), ...(u.email ? { email: u.email } : {}) });
    takes[String(u._id)] = takesDecisions(m);
    current.push({ user_id: String(u._id), project_ids: (m.focus_project_ids ?? []).map(String), takes_decisions: takesDecisions(m) });
  }
  const rows: Doc<"projects">[] = await ctx.db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", `team:${teamId}`)).collect();
  const projects = rows.filter((p) => p.status !== "done").map((p) => ({ id: String(p._id), title: p.title, ...(p.short_id ? { short_id: p.short_id } : {}) }));
  return { team_id: teamId, members, projects, takes, current };
}

export function previewOf(roster: AreasRoster, assignments: AreaAssignment[], unplaced: string[] = []): AreasPreview {
  const name = new Map(roster.members.map((m) => [m.user_id, m.name]));
  const title = new Map(roster.projects.map((p) => [p.id, p.title]));
  return {
    assignments: assignments.map((a) => ({ ...a, name: name.get(a.user_id) ?? "a teammate", projects: a.project_ids.map((id) => ({ id, title: title.get(id) ?? id })) })),
    unplaced,
    text: areasText(assignments, (u) => name.get(u) ?? "a teammate", (p) => title.get(p) ?? p),
  };
}

// ── Applying a map ──

/** Writes each member's areas from a map; a member the map leaves out keeps nothing. Admins only. */
export async function applyAreasCore(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams">, assignments: AreaAssignment[], now = Date.now()): Promise<{ applied: number } | { error: string }> {
  const me = await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId)).first();
  if (!me) return { error: "Not a member of this team" };
  if (me.role !== "admin") return { error: "Only a team admin sets who decides for which areas" };
  const roster = await areasRoster(ctx, teamId);
  const projectIds = new Set(roster.projects.map((p) => p.id));
  const given = new Map(assignments.map((a) => [String(a.user_id), a]));
  let applied = 0;
  const memberships: Doc<"team_memberships">[] = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect();
  for (const m of memberships) {
    if (!roster.members.some((r) => r.user_id === String(m.user_id))) continue;
    const a = given.get(String(m.user_id));
    const focus = (a?.project_ids ?? []).filter((p) => projectIds.has(String(p))) as Id<"projects">[];
    const takes = a ? a.takes_decisions : takesDecisions(m);
    await ctx.db.patch(m._id, { focus_project_ids: focus.length ? focus : undefined, takes_decisions: takes ? undefined : false });
    if (focus.length) applied++;
  }
  const team: Doc<"teams"> | null = await ctx.db.get(teamId);
  const card = team?.decision_areas?.card_id ? await ctx.db.get(team.decision_areas.card_id) : null;
  await ctx.db.patch(teamId, { decision_areas: { ...(team?.decision_areas ?? {}), set_at: now, set_by: userId } });
  // The admins' card is moot once areas are set another way.
  if (card?.status === "pending") await withdrawCore(ctx, card, now, undefined, "Areas were set another way");
  return { applied };
}

export const applyInternal = internalMutation({
  args: { user_id: v.id("users"), team_id: v.id("teams"), assignments: v.array(v.object({ user_id: v.string(), project_ids: v.array(v.string()), takes_decisions: v.boolean() })) },
  handler: async (ctx, args) => applyAreasCore(ctx, args.user_id, args.team_id, args.assignments),
});

// ── Mapping plain words ──

export const rosterForUser = internalQuery({
  args: { user_id: v.id("users"), team_id: v.id("teams") },
  handler: async (ctx, args): Promise<AreasRoster | { error: string }> => {
    const m = await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", args.user_id).eq("team_id", args.team_id)).first();
    if (!m) return { error: "Not a member of this team" };
    return areasRoster(ctx, args.team_id);
  },
});

/** One model call on the team's budget: the words onto the roster's members and projects. */
async function mapWords(ctx: { runMutation: any; scheduler: any }, roster: AreasRoster, words: string): Promise<AreasPreview | { error: string }> {
  if (!words.trim()) return { error: "Say who decides for which areas" };
  if (roster.projects.length === 0) return { error: "This team has no projects to give out" };
  const reply = await runModelCall(ctx, { workspace: `team:${roster.team_id}`, team_id: roster.team_id }, "call", {
    model: CHEAP_MODEL,
    system: AREAS_SYSTEM,
    prompt: areasPrompt(words, roster.members, roster.projects),
    max_tokens: AREAS_MAX_TOKENS,
    output: "json",
  }, "Decision areas");
  if (!reply.ok) return { error: reply.reason === "budget" ? "The team's model budget has no room this month" : `Could not read the areas: ${reply.error}` };
  const parsed = parseAreasReply(reply.json, roster.members, roster.projects, new Map(Object.entries(roster.takes)));
  if (!parsed) return { error: "Could not read the areas from that answer" };
  return previewOf(roster, parsed.assignments, parsed.unplaced);
}

/** "Change areas": the map the words make, for the person to look at before applying it. */
export const mapAreas = action({
  args: { team_id: v.id("teams"), words: v.string() },
  handler: async (ctx, args): Promise<AreasPreview | { error: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Sign in first" };
    const roster: AreasRoster | { error: string } = await ctx.runQuery(internal.decisionAreas.rosterForUser, { user_id: userId, team_id: args.team_id });
    if ("error" in roster) return roster;
    return mapWords(ctx, roster, args.words);
  },
});

/** The admins' card answered in their own words: mapped and applied as the person who answered. */
export const mapAndApply = internalAction({
  args: { user_id: v.id("users"), team_id: v.id("teams"), words: v.string() },
  handler: async (ctx, args): Promise<{ applied: number } | { error: string }> => {
    const roster: AreasRoster | { error: string } = await ctx.runQuery(internal.decisionAreas.rosterForUser, { user_id: args.user_id, team_id: args.team_id });
    if ("error" in roster) return roster;
    const mapped = await mapWords(ctx, roster, args.words);
    if ("error" in mapped) return mapped;
    return await ctx.runMutation(internal.decisionAreas.applyInternal, { user_id: args.user_id, team_id: args.team_id, assignments: mapped.assignments.map(({ user_id, project_ids, takes_decisions }) => ({ user_id, project_ids, takes_decisions })) });
  },
});

// ── The admins' card ──

/** What points at who decides for each project: its lead's person, the people each covering role keeps, who answered its decisions. */
async function areaSignals(ctx: Ctx, teamId: Id<"teams">, projectIds: Set<string>): Promise<AreaSignal[]> {
  const signals: AreaSignal[] = [];
  const roles = (await allRolesInBoundary(ctx, { team_id: teamId })).filter((r: any) => r.status !== "retired");
  for (const pid of projectIds) {
    const project = await ctx.db.get(pid as Id<"projects">);
    const lead = projectLeadOf(project, roles);
    let cur: any = lead.kind === "lead" ? lead.role : null;
    for (let hops = 0; cur && hops < 16; hops++) {
      if (cur.reports_to?.kind === "user") { signals.push({ project_id: pid, user_id: String(cur.reports_to.user_id), kind: "lead" }); break; }
      cur = cur.reports_to?.role_id ? roles.find((r: any) => String(r._id) === String(cur.reports_to.role_id)) : null;
    }
  }
  for (const r of roles) {
    for (const pid of (r.scope?.project_ids ?? []).map(String)) {
      if (!projectIds.has(pid)) continue;
      for (const u of r.reports_user_ids ?? []) signals.push({ project_id: pid, user_id: String(u), kind: "kept" });
    }
  }
  const answered: Doc<"session_decisions">[] = await ctx.db.query("session_decisions").withIndex("by_team_status_created", (q: any) => q.eq("team_id", teamId).eq("status", "answered")).order("desc").take(300);
  const projectOfTask = new Map<string, string | null>();
  for (const d of answered) {
    if (!d.task_id || d.answered_by?.kind !== "user") continue;
    const key = String(d.task_id);
    if (!projectOfTask.has(key)) {
      const task: Doc<"tasks"> | null = await ctx.db.get(d.task_id);
      projectOfTask.set(key, task?.project_id ? String(task.project_id) : null);
    }
    const pid = projectOfTask.get(key);
    if (pid && projectIds.has(pid)) signals.push({ project_id: pid, user_id: String(d.answered_by.id), kind: "answered" });
  }
  return signals;
}

/** The split the card proposes, from the team's signals. */
export async function proposeAreas(ctx: Ctx, roster: AreasRoster): Promise<AreaAssignment[]> {
  const ids = roster.projects.map((p) => p.id);
  return proposeSplit(ids, roster.members.map((m) => m.user_id), await areaSignals(ctx, roster.team_id, new Set(ids)));
}

/**
 * Asks the admins of a team with no areas who decides for which areas, once:
 * a silent card (its answer is applied here, never sent into a session),
 * asked from the workspace's agent's session when it has one, else from the
 * session whose question found no areas.
 */
export async function askForAreas(ctx: Ctx, teamId: Id<"teams">, conversation: any, now: number): Promise<Id<"session_decisions"> | null> {
  const team: Doc<"teams"> | null = await ctx.db.get(teamId);
  const state = team?.decision_areas;
  if (!team || state?.card_id || state?.set_at || state?.declined_at) return null;
  const memberships: Doc<"team_memberships">[] = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect();
  const admins: Id<"users">[] = [];
  for (const m of memberships) if (m.role === "admin" && !(await ctx.db.get(m.user_id))?.is_bot) admins.push(m.user_id);
  const roster = await areasRoster(ctx, teamId);
  // Nothing to share among: one person, no projects, or no person to ask. Asks hold off for a day (scheduleAreasCard).
  if (admins.length === 0 || roster.projects.length === 0 || roster.members.length < AREAS_MIN_PEOPLE) {
    await ctx.db.patch(teamId, { decision_areas: { ...(state ?? {}), checked_at: now } });
    return null;
  }
  const proposal = await proposeAreas(ctx, roster);
  const preview = previewOf(roster, proposal);
  const anchor = await ctx.db.query("anchors").withIndex("by_team", (q: any) => q.eq("team_id", teamId)).first();
  const anchorConv = anchor?.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
  const asker = anchorConv ?? conversation;
  const split = preview.assignments.filter((a) => a.projects.length).map((a) => `- **${a.name}**: ${a.projects.map((p) => p.title).join(", ")}`).join("\n");
  const short_id = await nextShortId(ctx.db as any, "sd");
  const id: Id<"session_decisions"> = await ctx.db.insert("session_decisions", {
    conversation_id: asker._id,
    session_id: asker.session_id,
    user_id: asker.user_id,
    short_id,
    question: AREAS_CARD_QUESTION,
    context_md: `Each new decision about a project goes to whoever covers it, fewest open first. Projects: ${roster.projects.map((p) => p.title).join(", ")}.\n\nPick the split below, or answer in your own words, naming each person and what they cover.`,
    kind: "single",
    category: "unknown",
    options: [{ label: AREAS_CARD_USE, body_md: split }, { label: AREAS_CARD_LEAVE }],
    blocking: false,
    silent: true,
    status: "pending",
    holder: { kind: "user", id: String(admins[0]) },
    holder_key: `user:${admins[0]}`,
    asked_user_ids: admins,
    hops: [],
    team_id: teamId,
    created_at: now,
    session_title: asker.title,
  });
  await syncDecisionInbox(ctx, id, admins, now);
  await ctx.db.patch(teamId, { decision_areas: { ...(state ?? {}), card_id: id, proposal: proposal.map((a) => ({ user_id: a.user_id as Id<"users">, project_ids: a.project_ids as Id<"projects">[] })) } });
  return id;
}

/**
 * The ask that found no areas schedules the card rather than posting it in
 * its own write, so the asking session's question stays the only one it
 * made. A cheap read of the team decides whether there is anything to ask.
 */
export async function scheduleAreasCard(ctx: Ctx, teamId: Id<"teams">, conversationId: Id<"conversations">, now: number): Promise<void> {
  const state = (await ctx.db.get(teamId))?.decision_areas;
  if (!ctx.scheduler || state?.card_id || state?.set_at || state?.declined_at) return;
  if (state?.checked_at && now - state.checked_at < AREAS_RECHECK_MS) return;
  await ctx.scheduler.runAfter(0, internal.decisionAreas.postAreasCard, { team_id: teamId, conversation_id: conversationId });
}

export const postAreasCard = internalMutation({
  args: { team_id: v.id("teams"), conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (conversation) await askForAreas(ctx, args.team_id, conversation, Date.now());
  },
});

/**
 * The admins' card answered (sessionDecisions settleResolution): words win
 * over a picked option; the split applies as proposed; leaving areas unset or
 * dismissing it stops the card from being asked again.
 */
export async function settleAreasCard(
  ctx: Ctx,
  row: Pick<Doc<"session_decisions">, "_id" | "team_id">,
  verdict: { status: string; answer_index?: number; answer_text?: string },
  by: { kind: string; user_id?: Id<"users"> },
  now: number,
): Promise<void> {
  if (!row.team_id || (verdict.status !== "answered" && verdict.status !== "dismissed")) return;
  const team: Doc<"teams"> | null = await ctx.db.get(row.team_id);
  if (!team?.decision_areas?.card_id || String(team.decision_areas.card_id) !== String(row._id)) return;
  const words = verdict.status === "answered" ? verdict.answer_text?.trim() : undefined;
  if (words && by.user_id && ctx.scheduler) {
    await ctx.scheduler.runAfter(0, internal.decisionAreas.mapAndApply, { user_id: by.user_id, team_id: row.team_id, words });
    return;
  }
  if (verdict.status === "answered" && verdict.answer_index === 0 && by.user_id) {
    const proposal = (team.decision_areas.proposal ?? []).map((a) => ({ user_id: String(a.user_id), project_ids: a.project_ids.map(String), takes_decisions: true }));
    await applyAreasCore(ctx, by.user_id, row.team_id, proposal, now);
    return;
  }
  await ctx.db.patch(row.team_id, { decision_areas: { ...team.decision_areas, declined_at: now } });
}

// ── CLI: `cast team focus "<words>"` ──

export const cliCaller = internalQuery({
  args: { api_token: v.string(), team_id: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ user_id: Id<"users">; team_id: Id<"teams"> } | { error: string }> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    const user: Doc<"users"> | null = await ctx.db.get(auth.userId);
    const teamId = (args.team_id ? ctx.db.normalizeId("teams", args.team_id) : null) ?? user?.active_team_id ?? null;
    if (!teamId) return { error: "No team: pass --team <name|id>" };
    const m = await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", auth.userId).eq("team_id", teamId)).first();
    if (!m) return { error: "Not a member of that team" };
    return { user_id: auth.userId, team_id: teamId };
  },
});

export const focusForCli = action({
  args: { api_token: v.string(), team_id: v.optional(v.string()), words: v.optional(v.string()), dry_run: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<(AreasPreview & { applied?: number; current?: boolean }) | { error: string }> => {
    const caller: { user_id: Id<"users">; team_id: Id<"teams"> } | { error: string } = await ctx.runQuery(internal.decisionAreas.cliCaller, { api_token: args.api_token, team_id: args.team_id });
    if ("error" in caller) return caller;
    const roster: AreasRoster | { error: string } = await ctx.runQuery(internal.decisionAreas.rosterForUser, caller);
    if ("error" in roster) return roster;
    if (!args.words?.trim()) return { ...previewOf(roster, roster.current), current: true };
    const mapped = await mapWords(ctx, roster, args.words);
    if ("error" in mapped || args.dry_run) return mapped;
    const done: { applied: number } | { error: string } = await ctx.runMutation(internal.decisionAreas.applyInternal, { ...caller, assignments: mapped.assignments.map(({ user_id, project_ids, takes_decisions }) => ({ user_id, project_ids, takes_decisions })) });
    return "error" in done ? done : { ...mapped, applied: done.applied };
  },
});
