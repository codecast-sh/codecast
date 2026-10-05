// The learning loop (docs/architecture/org-hire.md H12): a workspace's opt-in,
// the pass that reads an opted-in instance's sessions and files generalized
// lessons on the template, and what the publisher reads to turn lessons into a
// release and a canary into stable. Built on orgTemplates (templates, instances,
// the one lesson writer, the one bind queue); the rules are the shared ones in
// orgTemplateLearning (contracts).
//
// A session is read in exactly one place, `performDigest`, an internal query
// only the pass calls, and the opt-in is read there again. The role's brief
// is read there too, for the rules in its playbook. What it returns
// goes to the model and nowhere else: the pass's caller, Codecast's scheduled
// run, receives lessons that passed the leak check and counts.
import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { parseWorkspaceKey, requireTeamAdmin, requireTeamMembership } from "./lib/access";
import { callModel, parseJsonBlock } from "./lib/anthropic";
import { isUserMessageNoise, stripMessageTags } from "./lib/userSend";
import { noteOrgChange, roleSubject, whereOfRole } from "./lib/orgChangeLog";
import { isToolResultCarrier, parseUserMessage } from "@codecast/shared/contracts";
import { compareVersions, type OrgTemplate } from "@codecast/shared/contracts/orgTemplateManifest";
import { readiness } from "@codecast/shared/contracts/orgTemplateState";
import { LEARNING, canaryVerdict, draftDue, learningRequest, lessonLeaks, nextPatch, parseLessons, playbookRuleSignals, structuralSignals, workspaceTerms, type CanaryInstance, type LeakKind, type LearningDigest, type Redirect, type WorkspaceFacts } from "@codecast/shared/contracts/orgTemplateLearning";
import { parsePlaybook } from "@codecast/shared/contracts/rolePlaybook";
import { CODECAST_TEMPLATE_ACCESS, callerWorkspace, enqueueBind, fileLessonRow, requireCaller, requireCodecastPublisher, routineRows, stateOf, templateRow, visibleTemplate, type Ctx } from "./orgTemplates";
import { standingConversationOf } from "./orgRoles";

/** The model a pass asks. Generalizing a correction without carrying its specifics is judgment, not summary. */
export const LEARNING_MODEL = "claude-sonnet-5-5";
const HOUR = 3_600_000;
/** An instance is read at most this often, so a rerun of a pass skips what it just read. */
const MIN_INTERVAL_MS = HOUR;
/** A daily run finds an instance due again after this long. */
const PASS_DUE_MS = 20 * HOUR;
/** Instances one call of the pass reads; the caller asks again while any remain. */
const PASS_BATCH = 8;
const STANDING_MESSAGES = 80, HAND_MESSAGES = 30, HANDS = 5;

// ── The opt-in ──────────────────────────────────────────────────────────────

async function optInRow(ctx: Ctx, workspace: string): Promise<any> {
  return ctx.db.query("org_template_learning").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).first();
}
/** Whether a workspace lets Codecast learn from its template roles. No row is no. */
export async function learningEnabled(ctx: Ctx, workspace: string): Promise<boolean> {
  return (await optInRow(ctx, workspace))?.enabled === true;
}

/** The switch as a surface shows it: its state, who last set it, and whether this person may change it. */
export async function performLearning(ctx: Ctx, userId: Id<"users">, args: { team_id?: Id<"teams"> }) {
  const membership = args.team_id ? await requireTeamMembership(ctx as any, userId, args.team_id) : null;
  const workspace = await callerWorkspace(ctx, userId, args.team_id);
  const row = await optInRow(ctx, workspace);
  const by = row ? await ctx.db.get(row.changed_by) : null;
  return { workspace, enabled: row?.enabled === true, changed_at: row?.changed_at ?? null, changed_by: by?.name ?? null, can_change: !membership || membership.role === "admin" };
}

/** A team's admin, or the owner of a personal workspace, turns learning on or off for the whole workspace. */
export async function performSetLearning(ctx: Ctx, userId: Id<"users">, args: { team_id?: Id<"teams">; enabled: boolean }) {
  if (args.team_id) await requireTeamAdmin(ctx as any, userId, args.team_id);
  const workspace = await callerWorkspace(ctx, userId, args.team_id);
  const row = await optInRow(ctx, workspace);
  const fields = { enabled: args.enabled, changed_by: userId, changed_at: Date.now() };
  if (row) await ctx.db.patch(row._id, fields);
  else await ctx.db.insert("org_template_learning", { workspace, ...fields });
  return performLearning(ctx, userId, { team_id: args.team_id });
}

// ── The pass ────────────────────────────────────────────────────────────────

async function codecastTemplate(ctx: Ctx, templateId: string): Promise<any> {
  const template = await templateRow(ctx, templateId, CODECAST_TEMPLATE_ACCESS);
  if (!template) throw new Error(`No Codecast template ${templateId}: the learning loop improves the templates Codecast publishes`);
  return template;
}
/** A template's bound instances that run Codecast's release of it (a workspace's own template of the same id is its own). */
async function codecastInstances(ctx: Ctx, templateId: string): Promise<any[]> {
  const rows: any[] = await ctx.db.query("org_template_instances").withIndex("by_template", (q: any) => q.eq("template_id", templateId)).collect();
  const out: any[] = [];
  for (const row of rows) {
    if (row.phase !== "ready" || !row.role_id) continue;
    if ((await visibleTemplate(ctx, templateId, row.workspace))?.workspace === CODECAST_TEMPLATE_ACCESS) out.push(row);
  }
  return out;
}
async function optedIn(ctx: Ctx, rows: any[]): Promise<any[]> {
  const enabled = new Map<string, boolean>();
  for (const row of rows) if (!enabled.has(row.workspace)) enabled.set(row.workspace, await learningEnabled(ctx, row.workspace));
  return rows.filter((row) => enabled.get(row.workspace));
}

/** The instances this call of the pass reads: opted in, longest unread first. */
export async function performPassPlan(ctx: Ctx, userId: Id<"users">, args: { template_id: string; now: number }) {
  await requireCodecastPublisher(ctx, userId);
  await codecastTemplate(ctx, args.template_id);
  const due = (await optedIn(ctx, await codecastInstances(ctx, args.template_id)))
    .filter((row) => (row.learning?.at ?? 0) <= args.now - MIN_INTERVAL_MS)
    .sort((a, b) => (a.learning?.at ?? 0) - (b.learning?.at ?? 0));
  return { user_id: userId, instances: due.slice(0, PASS_BATCH).map((row) => row._id as Id<"org_template_instances">), remaining: Math.max(0, due.length - PASS_BATCH) };
}

/** The instance as a pass may read it, or null: gone, retired, not Codecast's template, or its workspace is not opted in. */
async function readable(ctx: Ctx, instanceId: Id<"org_template_instances">): Promise<{ row: any; role: any; manifest: OrgTemplate } | null> {
  const row = await ctx.db.get(instanceId);
  if (!row || row.phase !== "ready" || !row.role_id || !(await learningEnabled(ctx, row.workspace))) return null;
  const template = await visibleTemplate(ctx, row.template_id, row.workspace);
  const release = template?.workspace === CODECAST_TEMPLATE_ACCESS ? template.releases.find((r: any) => r.version === row.version && r.digest === row.digest) : null;
  const role = await ctx.db.get(row.role_id);
  return release && role ? { row, role, manifest: release.manifest as OrgTemplate } : null;
}

/** What a person typed, or null for anything a machine delivered. One definition of typed: lib/userSend. */
function typed(message: any): string | null {
  const raw = message.content;
  if (typeof raw !== "string" || message.is_encrypted || isToolResultCarrier(message) || isUserMessageNoise(raw)) return null;
  const text = (parseUserMessage(raw)?.body ?? stripMessageTags(raw)).trim();
  return text.length >= 8 ? text : null;
}

/** What people typed to the role since `since`, newest first, each with the role's line before it: its standing session and its latest hands. */
async function redirectsOf(ctx: Ctx, role: any, since: number): Promise<Redirect[]> {
  const standing = await standingConversationOf(ctx, role);
  const hands: any[] = (await ctx.db.query("conversations").withIndex("by_org_role", (q: any) => q.eq("org_role_id", role._id)).collect())
    .filter((c: any) => !c.standing_role_id && String(c._id) !== String(standing?._id) && (c.updated_at ?? c._creationTime) > since)
    .sort((a: any, b: any) => (b.updated_at ?? b._creationTime) - (a.updated_at ?? a._creationTime))
    .slice(0, HANDS);
  const found: Array<Redirect & { at: number }> = [];
  for (const [conversation, take] of [...(standing ? [[standing, STANDING_MESSAGES] as const] : []), ...hands.map((c) => [c, HAND_MESSAGES] as const)]) {
    const rows: any[] = await ctx.db.query("messages").withIndex("by_conversation_role_timestamp", (q: any) => q.eq("conversation_id", conversation._id).eq("role", "user").gt("timestamp", since)).order("desc").take(take);
    for (const message of rows) {
      const said = typed(message);
      if (!said) continue;
      const before: any[] = await ctx.db.query("messages").withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conversation._id).lt("timestamp", message.timestamp)).order("desc").take(6);
      const line = before.find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim())?.content.trim();
      found.push({ at: message.timestamp, said, ...(line ? { before: line } : {}) });
    }
  }
  return found.sort((a, b) => b.at - a.at).slice(0, LEARNING.redirects).map(({ at, ...redirect }) => redirect);
}

/**
 * The one read of an opted-in instance's sessions (H12): what people typed to
 * the role since its last pass, and where its record shows a stall or a
 * failure, as the request the model answers. Null when the instance may not
 * be read; `request` null when there is nothing to learn from.
 */
export async function performDigest(ctx: Ctx, args: { instance_id: Id<"org_template_instances">; now: number }) {
  const found = await readable(ctx, args.instance_id);
  if (!found) return null;
  const { row, role, manifest } = found;
  const since = row.learning?.at ?? Math.max(row.created_at, args.now - LEARNING.first_window_ms);
  const state = stateOf(row, role);
  const routines = await routineRows(ctx, row, manifest);
  const signals = structuralSignals(manifest, { state, readiness: readiness(manifest, state, role.trust ?? "understand", args.now), routines, hired_at: row.created_at, seen: row.learning?.seen }, args.now);
  for (const signal of signals) {
    // A failed run's own summary is the role's words about it: the model reads it, the lesson never carries it.
    const routine = signal.key.includes(":failed:") ? routines.find((r) => r.id === signal.about) : null;
    if (routine?.trigger) signal.detail = (await ctx.db.get(routine.trigger.id as Id<"agent_tasks">))?.last_run_summary;
  }
  // The rules the role wrote in its own playbook (org-staffing.md S38), each
  // read once: its key joins the instance's `seen` with the structural ones.
  const brief = role.brief_doc_id ? await ctx.db.get(role.brief_doc_id) : null;
  const rules = playbookRuleSignals(parsePlaybook(brief?.content).rules, row.learning?.seen);
  const digest: LearningDigest = { redirects: await redirectsOf(ctx, role, since), signals, rules };
  return { request: digest.redirects.length || signals.length || rules.length ? learningRequest(manifest, digest) : null, signal_keys: [...signals.map((s) => s.key), ...rules.map((r) => r.key)] };
}

/** The names a lesson from this instance's workspace must not carry. */
async function workspaceFacts(ctx: Ctx, row: any, role: any): Promise<WorkspaceFacts> {
  const ws = parseWorkspaceKey(row.workspace);
  const users: any[] = [];
  let team: string | null = null;
  if (ws?.type === "team") {
    team = (await ctx.db.get(ws.teamId))?.name ?? null;
    const memberships: any[] = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", ws.teamId)).collect();
    for (const m of memberships) users.push(await ctx.db.get(m.user_id));
  } else if (ws) users.push(await ctx.db.get(ws.userId));
  const projects: any[] = await ctx.db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", row.workspace)).take(200);
  return { people: users.filter(Boolean).map((u) => ({ name: u.name, email: u.email, github_username: u.github_username })), team, projects: projects.map((p) => p.title), instance: row.instance, handle: role?.handle, config: row.config, host: row.host };
}

export type LearnedResult = { read: boolean; failed: boolean; filed: Array<{ id: string; kind: string; about: string; body: string }>; refused: Partial<Record<LeakKind, number>> };
/**
 * The model's reply becomes lesson rows, each through the leak check first: a
 * lesson that carries an email, a link, an id, a quotation, code or a name
 * from the workspace is dropped and counted by its reason, and its text goes
 * nowhere. The cursor then moves, so the same sessions are not read twice. A
 * reply of null (the model call failed) leaves the cursor for the next pass.
 */
export async function performFileLearned(ctx: Ctx, args: { instance_id: Id<"org_template_instances">; user_id: Id<"users">; reply: string | null; signal_keys: string[]; now: number }): Promise<LearnedResult> {
  const found = await readable(ctx, args.instance_id);
  if (!found) return { read: false, failed: false, filed: [], refused: {} };
  if (args.reply === null) return { read: true, failed: true, filed: [], refused: {} };
  const { row, role, manifest } = found;
  const terms = workspaceTerms(await workspaceFacts(ctx, row, role), manifest);
  const result: LearnedResult = { read: true, failed: false, filed: [], refused: {} };
  for (const lesson of parseLessons(parseJsonBlock(args.reply), manifest)) {
    const leaks = lessonLeaks(lesson.lesson, terms);
    if (leaks.length) { for (const kind of leaks) result.refused[kind] = (result.refused[kind] ?? 0) + 1; continue; }
    const filed = await fileLessonRow(ctx, args.user_id, row, { body: lesson.lesson, source: "learning", kind: lesson.kind, about: lesson.about });
    result.filed.push({ id: String(filed.id), kind: lesson.kind, about: lesson.about, body: lesson.lesson });
  }
  await ctx.db.patch(row._id, { learning: { at: args.now, seen: [...(row.learning?.seen ?? []), ...args.signal_keys].slice(-LEARNING.seen_cap) } });
  return result;
}

// ── What the publisher reads: lessons, the draft, the canary ────────────────

/** The newest canary release above the newest stable one: the release in trial. */
function canaryOf(template: any): any | null {
  const newest = (status: string) => template.releases.filter((r: any) => r.status === status).sort((a: any, b: any) => compareVersions(a.version, b.version)).at(-1) ?? null;
  const stable = newest("stable"), canary = newest("canary");
  return canary && (!stable || compareVersions(canary.version, stable.version) > 0) ? canary : null;
}
const onRelease = (row: any, release: any) => row.version === release.version && row.digest === release.digest;

async function learnStatus(ctx: Ctx, template: any, now: number) {
  const lessons: any[] = (await ctx.db.query("org_template_lessons").withIndex("by_template_status", (q: any) => q.eq("template_id", template.template_id)).collect()).filter((l: any) => l.workspace === CODECAST_TEMPLATE_ACCESS);
  const rows = await codecastInstances(ctx, template.template_id);
  const reading = await optedIn(ctx, rows);
  const release = canaryOf(template);
  const followers = rows.filter((row) => row.update_policy === "canary");
  let canary: { version: string; digest: string; published_at: number; instances: Array<CanaryInstance & { pending: boolean }>; lessons_since: number; clean: boolean; why: string } | null = null;
  if (release) {
    const instances: Array<CanaryInstance & { pending: boolean }> = [];
    for (const row of followers) {
      const since = row.version_at ?? row.updated_at;
      const runs = (await routineRows(ctx, row, release.manifest)).filter((r) => !r.external && !r.retired && (r.trigger?.last_run_at ?? 0) > since);
      instances.push({ on_release: onRelease(row, release), ran: runs.length > 0, failed: runs.some((r) => r.trigger?.last_run_failed), pending: row.pending_upgrade?.to === release.version });
    }
    const lessons_since = lessons.filter((l) => l.source === "learning" && l.release.version === release.version).length;
    canary = { version: release.version, digest: release.digest, published_at: release.published_at, instances, lessons_since, ...canaryVerdict({ published_at: release.published_at, instances, lessons_since }, now) };
  }
  const draft = draftDue(lessons, now);
  // A canary that taught a lesson or failed a run is fixed by the next draft; one still soaking is not drafted over.
  const superseded = !!canary && (canary.lessons_since > 0 || canary.instances.some((i) => i.on_release && i.failed));
  const count = (status: string) => lessons.filter((l) => l.status === status).length;
  return {
    template_id: template.template_id as string, name: template.name as string, latest: template.latest.version as string,
    stable: template.releases.filter((r: any) => r.status === "stable").map((r: any) => r.version).sort(compareVersions).at(-1) ?? null,
    canary,
    lessons: { open: count("open"), accepted: count("accepted"), released: count("released"), declined: count("declined") },
    draft: { ...draft, next_version: nextPatch(template.releases.map((r: any) => r.version)) },
    instances: { total: rows.length, opted_in: reading.length, canary: followers.length },
    due: {
      pass: reading.some((row) => (row.learning?.at ?? 0) <= now - PASS_DUE_MS),
      draft: draft.due && (!canary || superseded),
      rollout: !!canary && canary.instances.some((i) => !i.on_release && !i.pending),
      promote: !!canary?.clean,
    },
  };
}
export async function performLearnStatus(ctx: Ctx, userId: Id<"users">, args: { template_id: string; now?: number }) {
  await requireCodecastPublisher(ctx, userId);
  return learnStatus(ctx, await codecastTemplate(ctx, args.template_id), args.now ?? Date.now());
}
/** Whether the scheduled run has anything to do, across every template Codecast publishes: its precheck. */
export async function performLearnDue(ctx: Ctx, userId: Id<"users">, args: { now?: number } = {}) {
  await requireCodecastPublisher(ctx, userId);
  const templates: any[] = await ctx.db.query("org_templates").withIndex("by_workspace", (q: any) => q.eq("workspace", CODECAST_TEMPLATE_ACCESS)).collect();
  const out: Array<{ template_id: string; due: string[] }> = [];
  for (const template of templates) {
    const status = await learnStatus(ctx, template, args.now ?? Date.now());
    const due = Object.entries(status.due).filter(([, on]) => on).map(([what]) => what);
    if (due.length) out.push({ template_id: status.template_id, due });
  }
  return { due: out.length > 0, templates: out };
}

/**
 * Move the canary instances to the release in trial (H9: canary instances are
 * updated by their publisher, which is what "the publisher updates it" chose
 * at hire). Each gets the upgrade as `pending_upgrade` and its host step
 * queued; the host's bind performs it and refuses a change to the role's
 * identity or caps. The workspace's change log records it, so it can be seen
 * and withdrawn there.
 */
export async function performRollout(ctx: Ctx, userId: Id<"users">, args: { template_id: string }) {
  await requireCodecastPublisher(ctx, userId);
  const template = await codecastTemplate(ctx, args.template_id);
  const release = canaryOf(template);
  if (!release) throw new Error(`No canary release of ${args.template_id} to roll out: publish one with --status canary`);
  const result = { version: release.version as string, on_release: 0, queued: 0, already_pending: 0, unreachable: 0 };
  for (const row of (await codecastInstances(ctx, args.template_id)).filter((r) => r.update_policy === "canary")) {
    if (onRelease(row, release) || compareVersions(release.version, row.version) <= 0) { result.on_release++; continue; }
    const now = Date.now();
    if (row.pending_upgrade?.to !== release.version) {
      await ctx.db.patch(row._id, { pending_upgrade: { to: release.version, digest: release.digest, accepted_at: now, accepted_by: userId }, updated_at: now });
      const role = await ctx.db.get(row.role_id);
      if (role) await noteOrgChange(ctx, userId, whereOfRole(role), { kind: "upgrade", subject: roleSubject(role), before: { upgrade: null }, after: { upgrade: { instance: row.instance, template_id: row.template_id, to: release.version } } });
    }
    try {
      const queued = await enqueueBind(ctx, userId, await ctx.db.get(row._id));
      if (queued.already_pending) result.already_pending++; else result.queued++;
    } catch { result.unreachable++; }
  }
  return result;
}

// ── Wrappers ────────────────────────────────────────────────────────────────

export const learning = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, { api_token, ...args }): Promise<any> => performLearning(ctx, await requireCaller(ctx, api_token), args),
});
export const setLearning = mutation({
  args: { api_token: v.optional(v.string()), from_session: v.optional(v.string()), team_id: v.optional(v.id("teams")), enabled: v.boolean() },
  handler: async (ctx, { api_token, from_session, ...args }): Promise<any> => {
    if (from_session) throw new Error("Letting Codecast learn from a workspace is a person's choice: an agent session may not make it. A team admin sets it from the role page, or from their own terminal with cast org template learning on");
    return performSetLearning(ctx, await requireCaller(ctx, api_token), args);
  },
});
export const learnStatusOf = query({
  args: { api_token: v.optional(v.string()), template_id: v.string() },
  handler: async (ctx, { api_token, ...args }): Promise<any> => performLearnStatus(ctx, await requireCaller(ctx, api_token), args),
});
export const learnDue = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, { api_token }): Promise<any> => performLearnDue(ctx, await requireCaller(ctx, api_token)),
});
export const rollout = mutation({
  args: { api_token: v.optional(v.string()), template_id: v.string() },
  handler: async (ctx, { api_token, ...args }): Promise<any> => performRollout(ctx, await requireCaller(ctx, api_token), args),
});

export const passPlan = internalQuery({
  args: { api_token: v.optional(v.string()), template_id: v.string(), now: v.number() },
  handler: async (ctx, { api_token, ...args }): Promise<any> => performPassPlan(ctx, await requireCaller(ctx, api_token), args),
});
export const passDigest = internalQuery({
  args: { instance_id: v.id("org_template_instances"), now: v.number() },
  handler: async (ctx, args): Promise<any> => performDigest(ctx, args),
});
export const fileLearned = internalMutation({
  args: { instance_id: v.id("org_template_instances"), user_id: v.id("users"), reply: v.union(v.string(), v.null()), signal_keys: v.array(v.string()), now: v.number() },
  handler: async (ctx, args): Promise<LearnedResult> => performFileLearned(ctx, args),
});

/**
 * One call of the pass for one template (Codecast's publishers only): each
 * due instance is read, asked about and filed in its own transactions, a few
 * at a time. The answer carries the lessons that were filed and counts,
 * never a session's words and never which workspace taught what.
 */
export const learnPass = action({
  args: { api_token: v.optional(v.string()), template_id: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const now = Date.now();
    const plan: { user_id: Id<"users">; instances: Id<"org_template_instances">[]; remaining: number } = await ctx.runQuery((internal as any).orgTemplateLearning.passPlan, { ...args, now });
    const totals = { template_id: args.template_id, read: 0, failed: 0, filed: [] as LearnedResult["filed"], refused: {} as Partial<Record<LeakKind, number>>, remaining: plan.remaining };
    const one = async (instance_id: Id<"org_template_instances">): Promise<LearnedResult | null> => {
      const digest: { request: { system: string; prompt: string } | null; signal_keys: string[] } | null = await ctx.runQuery((internal as any).orgTemplateLearning.passDigest, { instance_id, now });
      if (!digest) return null;
      const reply = digest.request ? (await callModel({ ...digest.request, model: LEARNING_MODEL, max_tokens: 2000, label: "template-learning", timeout_ms: 120_000 }))?.text ?? null : "[]";
      return ctx.runMutation((internal as any).orgTemplateLearning.fileLearned, { instance_id, user_id: plan.user_id, reply, signal_keys: digest.signal_keys, now });
    };
    for (let i = 0; i < plan.instances.length; i += 4) {
      for (const result of await Promise.all(plan.instances.slice(i, i + 4).map(one))) {
        if (!result?.read) continue;
        totals.read++;
        if (result.failed) { totals.failed++; totals.remaining++; }
        totals.filed.push(...result.filed);
        for (const [kind, n] of Object.entries(result.refused)) totals.refused[kind as LeakKind] = (totals.refused[kind as LeakKind] ?? 0) + n;
      }
    }
    return totals;
  },
});
