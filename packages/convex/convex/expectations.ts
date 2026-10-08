// A project's expectations (docs/architecture/the-line-model.md LM5): one
// living document per project, versioned, changed only through proposals.
//
// - `show` / `forProject`: a version of the document with its history, the
//   recent proposals and the routine's cursor (the CLI, the Line tab).
// - `brief`: the active lines as compact text under the version to cite, the
//   route a judge calls.
// - `propose`: store a proposal. One that only adds lines a person said, each
//   with the quote the record holds and about what that quote says, applies
//   on its own; anything else waits
//   for the project's person, as a card in their queue when an agent session
//   proposed it.
// - `resolve`: a person applies or drops a proposal (the CLI, the web). When
//   the proposal has a card the person holds, that card is answered, so the
//   queue and the Line tab settle one decision (lib/expectationsApply).
// - `personEditCore` / `resolveProposalCore`: the web's two writes (line-map.md
//   LX3, LX5), reached through dispatch: a person's own line or retirement,
//   and Apply / Drop on an open proposal.
//
// Access is the project's: a caller resolves the project inside the
// workspace its data context names, and a proposal is read through its
// project (canAccessProject).
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { createWorkContext } from "./data";
import { canAccessProject, computeWorkspaceKey } from "./lib/access";
import { notFound } from "./lib/auth";
import { resolveWorkspaceProject } from "./lib/projectRef";
import { nextShortId } from "./counters";
import { askCore, finalizeAnswer, personMayResolve, withdrawCore } from "./sessionDecisions";
import { allRolesInBoundary } from "./lib/orgAccess";
import { answererOf } from "./orgLine";
import { personName } from "./sessionOwnership";
import { expectationOpValidator } from "./expectationsSchema";
import { EXPECTATION_CARD_OPTIONS, latestExpectations, performApply } from "./lib/expectationsApply";
import {
  applyOps,
  autoApplies,
  expectationIdPrefix,
  groundingCandidates,
  holdsQuote,
  isExpectationId,
  LIMITS,
  normalizeOp,
  opErrors,
  personEditApplies,
  personEditSummary,
  personOp,
  renderExpectations,
  renderProposal,
  type ExpectationCitation,
  type ExpectationOp,
  type ExpectationsVersion,
  type PersonEdit,
} from "@codecast/shared/contracts/expectations";

type Ctx = { db: any; auth?: any };

const scopeArgs = {
  workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  team_id: v.optional(v.id("teams")),
  project_path: v.optional(v.string()),
  conversation_id: v.optional(v.string()),
  project: v.optional(v.string()),
};

// A version row carries the whole document, and convex reads whole rows, so
// the history lists the recent versions only; any version is still readable
// by number.
const VERSIONS_LISTED = 30;
const PROPOSALS_READ = 50;
const PROPOSALS_SHOWN = 30;
// The ids one story reads at once.
const LINES_READ = 20;

async function requireUser(ctx: Ctx, apiToken?: string): Promise<Id<"users">> {
  const userId = await getAuthenticatedUserId(ctx, apiToken);
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

/** The project a CLI call names, inside the workspace its scope resolves to, and the calling session if any. */
async function projectInScope(ctx: Ctx, userId: Id<"users">, args: { workspace?: "personal" | "team"; team_id?: Id<"teams">; project_path?: string; conversation_id?: string; project?: string }) {
  const { db, conversation } = await createWorkContext(ctx, { userId, workspace: args.workspace, team_id: args.team_id, project_path: args.project_path, conversation_id: args.conversation_id });
  if (!args.project?.trim()) throw new Error("Name the project (--project), or run from a repo whose .codecast/line.toml names one");
  const project = await resolveWorkspaceProject(ctx, db.workspaceKey, args.project);
  if (!project || !(await canAccessProject(ctx, userId, project))) notFound("Project not found");
  return { project: project as Doc<"projects">, conversation };
}

async function versionView(ctx: Ctx, project: Doc<"projects">, row: any): Promise<ExpectationsVersion> {
  const proposal = row.proposal_id ? await ctx.db.get(row.proposal_id) : null;
  return {
    project: { id: String(project._id), title: project.title },
    version: row.version,
    prefix: row.prefix,
    next_n: row.next_n,
    items: row.items,
    applied_at: row.created_at,
    applied_by: personName(await ctx.db.get(row.user_id)),
    how: row.how,
    summary: row.summary,
    ...(proposal ? { proposal: proposal.short_id } : {}),
  };
}

/** A proposal as the lists show it. `web` adds what the Line tab answers it
 *  from: its changes in full and its card's id, so Apply there answers the
 *  same card the queue holds. */
function proposalView(p: any, decision: any, web = false) {
  return {
    short_id: p.short_id,
    status: p.status,
    summary: p.summary,
    changes: p.ops.length,
    base_version: p.base_version,
    ...(p.applied_version ? { applied_version: p.applied_version } : {}),
    ...(decision?.short_id ? { card: decision.short_id } : {}),
    ...(p.refused ? { refused: p.refused } : {}),
    ...(p.retracted_reason ? { retracted_reason: p.retracted_reason } : {}),
    ...(p.since ? { since: p.since } : {}),
    ...(p.until ? { until: p.until } : {}),
    created_at: p.created_at,
    ...(p.resolved_at ? { resolved_at: p.resolved_at } : {}),
    ...(web ? { ops: p.ops, ...(decision ? { card_id: String(decision._id), card_status: decision.status } : {}) } : {}),
  };
}

/** What changed in a version, read off its lines: added in it, changed in it, retired in it. */
function versionChanges(items: any[], version: number) {
  let added = 0, changed = 0, retired = 0;
  for (const e of items) {
    if (e.added_in === version) added++;
    else if (e.changed_in === version) { if (e.status === "retired") retired++; else changed++; }
  }
  return { added, changed, retired };
}

/** The read every surface shares: one version (the current one by default), the history, recent proposals, the cursor. */
async function readExpectations(ctx: Ctx, project: Doc<"projects">, version?: number, web = false) {
  const byVersion = () => ctx.db.query("project_expectations").withIndex("by_project_version", (q: any) => (version === undefined ? q.eq("project_id", project._id) : q.eq("project_id", project._id).eq("version", version)));
  const versions: any[] = await ctx.db.query("project_expectations").withIndex("by_project_version", (q: any) => q.eq("project_id", project._id)).order("desc").take(VERSIONS_LISTED);
  const row = version === undefined ? versions[0] ?? null : versions.find((r) => r.version === version) ?? (await byVersion().first());
  if (version !== undefined && !row) notFound(`${project.title} has no expectations version ${version}`);
  const proposals: any[] = await ctx.db.query("expectation_proposals").withIndex("by_project_created", (q: any) => q.eq("project_id", project._id)).order("desc").take(PROPOSALS_READ);
  const shown = proposals.slice(0, PROPOSALS_SHOWN);
  const decisions = await Promise.all(shown.map((p) => (p.decision_id ? ctx.db.get(p.decision_id) : null)));
  const cursor = proposals.reduce((max: number | null, p) => (p.status !== "retracted" && p.until && (max === null || p.until > max) ? p.until : max), null);
  const names = new Map<string, string>();
  const nameOf = async (id: any) => {
    const key = String(id);
    if (!names.has(key)) names.set(key, personName(await ctx.db.get(id)));
    return names.get(key)!;
  };
  return {
    project: { id: String(project._id), title: project.title },
    current_version: versions[0]?.version ?? 0,
    doc: row ? await versionView(ctx, project, row) : null,
    versions: await Promise.all(versions.map(async (r) => {
      const proposal = r.proposal_id ? await ctx.db.get(r.proposal_id) : null;
      return {
        version: r.version, summary: r.summary, how: r.how, applied_at: r.created_at, applied_by: await nameOf(r.user_id),
        active: r.items.filter((e: any) => e.status === "active").length,
        ...versionChanges(r.items, r.version),
        ...(proposal ? { proposal: proposal.short_id, proposed_by: await nameOf(proposal.user_id), ...(proposal.conversation_id ? { from_session: true } : {}) } : {}),
      };
    })),
    proposals: await Promise.all(shown.map(async (p, i) => {
      const view = proposalView(p, decisions[i], web && p.status === "open");
      return web && p.status === "open" ? { ...view, proposed_by: await nameOf(p.user_id), ...(p.conversation_id ? { from_session: true } : {}) } : view;
    })),
    cursor,
  };
}

/** The opening of a finding's detail, as plain words: what the judge saw. */
const firstWords = (md: string) => md.replace(/[#*_`>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 220);

// How far back a line's breaks are counted, and how many findings one line lists.
const USAGE_DAYS = 30;
const USAGE_READ = 200;
const FINDINGS_LISTED = 6;
// The sources whose speaker the web names, at most, per read.
const SOURCES_NAMED = 150;

/**
 * How often findings cite each line (LM5): a finder that judges behavior files
 * the line's id as its signal's subject, so a line's breaks are the signals
 * with that subject. Counted over the last 7 and 30 days, with the newest
 * findings and the causes they opened.
 */
async function lineUsage(ctx: Ctx, project: Doc<"projects">, items: any[], now: number, listFindings = true) {
  const workspace = project.workspace ?? computeWorkspaceKey(project, null);
  const since = now - USAGE_DAYS * 86_400_000;
  const week = now - 7 * 86_400_000;
  const tasks = new Map<string, any>();
  const lines: Record<string, { d7: number; d30: number; last_at?: number; findings: any[] }> = {};
  for (const e of items) {
    const signals: any[] = await ctx.db.query("signals")
      .withIndex("by_workspace_subject", (q: any) => q.eq("workspace", workspace).eq("subject", e.id).gte("created_at", since))
      .order("desc").take(USAGE_READ);
    if (!signals.length) continue;
    const findings = [];
    for (const sg of listFindings ? signals.slice(0, FINDINGS_LISTED) : []) {
      const key = String(sg.task_id);
      if (!tasks.has(key)) tasks.set(key, await ctx.db.get(sg.task_id));
      const t = tasks.get(key);
      findings.push({
        short_id: sg.short_id, title: sg.title, kind: sg.kind, source: sg.source, created_at: sg.created_at,
        ...(sg.detail_md ? { detail: firstWords(sg.detail_md) } : {}),
        ...(sg.evidence_url ? { evidence_url: sg.evidence_url } : {}),
        ...(t ? { cause: { id: String(t._id), short_id: t.short_id, title: t.title, status: t.status } } : {}),
      });
    }
    lines[e.id] = { d7: signals.filter((sg) => sg.created_at >= week).length, d30: signals.length, last_at: signals[0].created_at, findings };
  }
  return { since, lines };
}

/**
 * Who said each source's words, where the record names them: the person who
 * typed a chat line, who answered a decision, who spoke on a call, a
 * person's own words. Keyed `<kind>:<ref>`. Only records in
 * the project's own team are read.
 */
async function sourceSpeakers(ctx: Ctx, project: Doc<"projects">, citations: ExpectationCitation[]) {
  const out: Record<string, { who?: string }> = {};
  const seen = new Set<string>();
  for (const c of citations) {
    const key = `${c.kind}:${c.ref}`;
    if (seen.has(key) || seen.size >= SOURCES_NAMED) continue;
    seen.add(key);
    if (c.kind === "person") {
      const id = ctx.db.normalizeId("users", c.ref);
      if (id) out[key] = { who: personName(await ctx.db.get(id)) };
    } else if (c.kind === "chat") {
      const id = ctx.db.normalizeId("chat_messages", c.ref.slice(c.ref.lastIndexOf("/") + 1));
      const m = id ? await ctx.db.get(id) : null;
      if (m && m.team_id === project.team_id) out[key] = { who: m.author_kind === "agent" ? "an agent" : personName(await ctx.db.get(m.user_id)) };
    } else if (c.kind === "decision") {
      const d = await ctx.db.query("session_decisions").withIndex("by_short_id", (q: any) => q.eq("short_id", c.ref.split(/[:/]/)[0])).first();
      const answerer = d?.answered_by?.kind === "user" ? d.answered_by.id : d?.resolved_by;
      if (answerer && (await inProjectWorkspace(ctx, project, String(answerer)))) out[key] = { who: personName(await ctx.db.get(answerer)) };
    } else if (c.kind === "call") {
      const [short, at] = c.ref.split(":");
      const t = await ctx.db.query("transcripts").withIndex("by_short_id", (q: any) => q.eq("short_id", short)).first();
      if (!t || t.team_id !== project.team_id) continue;
      const seg = at && /^\d+$/.test(at) ? await ctx.db.query("transcript_segments").withIndex("by_transcript_seq", (q: any) => q.eq("transcript_id", t._id).eq("seq", Number(at))).first() : null;
      if (seg?.speaker_name) out[key] = { who: seg.speaker_name };
    }
  }
  return out;
}

/** The routine that proposes changes from the team's context, when the project has one installed (LM5): its trigger, so a person can run it now. */
async function proposerRoutine(ctx: Ctx, project: Doc<"projects">) {
  const workspace = project.workspace ?? computeWorkspaceKey(project, null);
  const instances: any[] = await ctx.db.query("org_template_instances").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).take(50);
  for (const inst of instances) {
    if (String(inst.project_id) !== String(project._id) || inst.phase === "retired") continue;
    const bound = inst.routines?.[EXPECTATIONS_ROUTINE];
    const id = bound?.triggerId && !bound.retired ? ctx.db.normalizeId("agent_tasks", bound.triggerId) : null;
    const t = id ? await ctx.db.get(id) : null;
    if (t) return { trigger_id: String(t._id), ...(t.short_id ? { short_id: t.short_id } : {}), status: t.status, ...(t.run_at ? { run_at: t.run_at } : {}), ...(t.last_run_at ? { last_run_at: t.last_run_at } : {}) };
  }
  return null;
}

/** The line template's routine that proposes expectation changes (org-templates/line). */
const EXPECTATIONS_ROUTINE = "expectations-daily";

/** `cast expectations show`: a version of the project's document with its history. */
export const show = query({
  args: { api_token: v.string(), version: v.optional(v.number()), ...scopeArgs },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx, args.api_token);
    const { project } = await projectInScope(ctx, userId, args);
    return readExpectations(ctx, project, args.version);
  },
});

/** The Line tab's read (LM7): the same document, history and proposals, for a signed-in person. */
export const forProject = query({
  args: { project_id: v.id("projects"), version: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx);
    if (!userId) return null;
    const project = await ctx.db.get(args.project_id);
    if (!project || !(await canAccessProject(ctx, userId, project))) return null;
    // `you_answer`: the viewer is the project's person (LM4), whose own edits
    // apply as they make them (personEditApplies). `usage` is how often
    // findings cite each line; `sources` names who said each source's words;
    // `routine` is the proposer routine, when one is installed.
    const read = await readExpectations(ctx, project, args.version, true);
    const items: any[] = read.doc?.items ?? [];
    const openOps = read.proposals.flatMap((p: any) => p.ops ?? []);
    const citations: ExpectationCitation[] = [...items.flatMap((e) => e.citations), ...openOps.flatMap((op: any) => op.citations)];
    const person = await projectPerson(ctx, project);
    return {
      ...read,
      you_answer: String(person) === String(userId),
      person: personName(await ctx.db.get(person)),
      usage: await lineUsage(ctx, project, items, Date.now()),
      sources: await sourceSpeakers(ctx, project, citations),
      routine: await proposerRoutine(ctx, project),
    };
  },
});

// The projects one overview reads, at most.
const OVERVIEW_PROJECTS = 80;
const CLOSED_PROJECT = new Set(["done", "archived", "cancelled", "canceled"]);

/**
 * Every project's document in a workspace, as one summary row each (the
 * /expectations overview): how many lines, how many proposals wait, how often
 * findings broke a line in the last 7 and 30 days, and the lines broken most.
 * A live project with no document yet is listed too, so starting one is a
 * click away. Rows carry the workspace key the store filters by.
 */
export const overview = query({
  args: { team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx);
    if (!userId) return [];
    let key: string;
    try {
      key = (await createWorkContext(ctx, { userId, workspace: args.team_id ? "team" : "personal", team_id: args.team_id })).db.workspaceKey;
    } catch {
      return [];
    }
    const projects: any[] = await ctx.db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", key)).take(OVERVIEW_PROJECTS);
    const now = Date.now();
    const rows = [];
    for (const project of projects) {
      if (!(await canAccessProject(ctx, userId, project))) continue;
      const doc = await latestExpectations(ctx, project._id);
      if (!doc && CLOSED_PROJECT.has(project.status)) continue;
      const items: any[] = doc?.items ?? [];
      const active = items.filter((e) => e.status === "active");
      const open = await ctx.db.query("expectation_proposals").withIndex("by_project_created", (q: any) => q.eq("project_id", project._id)).order("desc").take(PROPOSALS_READ);
      const usage = active.length ? await lineUsage(ctx, project, active, now, false) : { lines: {} as Record<string, { d7: number; d30: number }> };
      const counts = active.map((e) => ({ id: e.id, text: e.text, part: e.part, d7: usage.lines[e.id]?.d7 ?? 0, d30: usage.lines[e.id]?.d30 ?? 0 }));
      rows.push({
        _id: String(project._id),
        workspace: key,
        project: { id: String(project._id), short_id: project.short_id, title: project.title, status: project.status },
        version: doc?.version ?? 0,
        applied_at: doc?.created_at ?? null,
        active: active.length,
        retired: items.length - active.length,
        parts: new Set(active.map((e) => e.part)).size,
        open_proposals: open.filter((p) => p.status === "open").length,
        breaks7: counts.reduce((n, c) => n + c.d7, 0),
        breaks30: counts.reduce((n, c) => n + c.d30, 0),
        broken: counts.filter((c) => c.d30 > 0).length,
        most_broken: counts.filter((c) => c.d30 > 0).sort((a, b) => b.d30 - a.d30).slice(0, 3),
      });
    }
    return rows;
  },
});

/**
 * The lines some ids name (LM5, LM7): what a cause's story shows for the
 * expectation its signals cite. An id's prefix names one project in the
 * workspace, and each line is read through that project, so a person sees a
 * line exactly when they can open its project. An id nothing answers to is
 * left out.
 */
export const lines = query({
  args: { workspace: v.string(), ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx);
    if (!userId) return [];
    const out: Array<{ id: string; text: string; status: "active" | "retired"; version: number; project_id: Id<"projects">; project_short_id?: string; project_title: string }> = [];
    for (const id of [...new Set(args.ids)].filter(isExpectationId).slice(0, LINES_READ)) {
      const any = await ctx.db.query("project_expectations").withIndex("by_workspace_prefix", (q: any) => q.eq("workspace", args.workspace).eq("prefix", expectationIdPrefix(id))).first();
      const project = any ? await ctx.db.get(any.project_id) : null;
      if (!project || !(await canAccessProject(ctx, userId, project))) continue;
      const doc = await latestExpectations(ctx, project._id);
      const line = doc?.items.find((e: any) => e.id === id);
      if (line) out.push({ id, text: line.text, status: line.status, version: doc.version, project_id: project._id, project_short_id: (project as any).short_id, project_title: project.title });
    }
    return out;
  },
});

/**
 * What a judge reads (LM5): the active lines with their ids, grouped by part,
 * under the version a finding cites. `version` reads an earlier one, so a
 * finding can be traced to the words it was graded against.
 */
export const brief = query({
  args: { api_token: v.string(), version: v.optional(v.number()), ...scopeArgs },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx, args.api_token);
    const { project } = await projectInScope(ctx, userId, args);
    const { doc } = await readExpectations(ctx, project, args.version);
    return {
      project: { id: String(project._id), title: project.title },
      version: doc?.version ?? 0,
      text: doc ? renderExpectations(doc, { brief: true }) : `${project.title} has no expectations yet.\n`,
    };
  },
});

/** The person a project's cards go to (LM4): the head of its owning role's chain, else the project's owner. */
async function projectPerson(ctx: Ctx, project: Doc<"projects">): Promise<Id<"users">> {
  const role = project.owner_role_id ? await ctx.db.get(project.owner_role_id) : null;
  if (!role) return project.user_id;
  return answererOf(role, await allRolesInBoundary(ctx, role)) as Id<"users">;
}

/** A person in the project's workspace: a member of its team, or its owner when it has none. */
async function inProjectWorkspace(ctx: Ctx, project: Doc<"projects">, userId: string): Promise<boolean> {
  const id = ctx.db.normalizeId("users", userId);
  if (!id) return false;
  if (!project.team_id) return id === project.user_id;
  return !!(await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", id).eq("team_id", project.team_id)).first());
}

/** The longest run of one speaker's segments a quote is matched across. */
const CALL_SEGMENTS_READ = 4000;

/**
 * Whether the record shows a person said the citation's quote: the chat line
 * it names was typed by a person (no agent wrote it, it is no call digest),
 * the decision was answered by a person with those words, or a person said
 * them on the call (one speaker's consecutive segments, around the segment
 * the ref names when it names one). Each record must sit in the project's
 * workspace, so a citation cannot borrow another team's words.
 */
async function personSaid(ctx: Ctx, project: Doc<"projects">, c: ExpectationCitation): Promise<boolean> {
  const quote = c.quote ?? "";
  if (c.kind === "chat") {
    const id = ctx.db.normalizeId("chat_messages", c.ref.slice(c.ref.lastIndexOf("/") + 1));
    const m = id ? await ctx.db.get(id) : null;
    return !!m && m.team_id === project.team_id && m.author_kind !== "agent" && m.origin !== "agent" && !m.call && holdsQuote(m.content ?? "", quote);
  }
  if (c.kind === "decision") {
    const d = await ctx.db.query("session_decisions").withIndex("by_short_id", (q: any) => q.eq("short_id", c.ref.split(/[:/]/)[0])).first();
    if (!d || d.status !== "answered" || (d.answered_by && d.answered_by.kind !== "user")) return false;
    const answerer = d.answered_by?.id ?? d.resolved_by;
    if (!answerer || !(await inProjectWorkspace(ctx, project, String(answerer)))) return false;
    const chosen = typeof d.answer_index === "number" ? d.options?.[d.answer_index] : null;
    return [d.answer_text, chosen?.label, chosen?.description].some((t) => typeof t === "string" && holdsQuote(t, quote));
  }
  if (c.kind === "call") {
    const [short, at] = c.ref.split(":");
    const t = await ctx.db.query("transcripts").withIndex("by_short_id", (q: any) => q.eq("short_id", short)).first();
    if (!t || t.team_id !== project.team_id) return false;
    const seq = at && /^\d+$/.test(at) ? Number(at) : null;
    const segments: any[] = (await ctx.db.query("transcript_segments").withIndex("by_transcript_seq", (q: any) => q.eq("transcript_id", t._id)).take(CALL_SEGMENTS_READ))
      .filter((s: any) => seq === null || Math.abs(s.seq - seq) <= 3);
    const runs: Array<{ speaker: string; text: string }> = [];
    for (const s of segments) {
      const last = runs[runs.length - 1];
      if (last && last.speaker === s.speaker_id) last.text += ` ${s.text}`;
      else runs.push({ speaker: s.speaker_id, text: s.text });
    }
    for (const r of runs) if (holdsQuote(r.text, quote) && (await inProjectWorkspace(ctx, project, r.speaker))) return true;
    return false;
  }
  return false;
}

/** The citations of a proposal's additions that the record shows a person said. */
async function citationsPersonSaid(ctx: Ctx, project: Doc<"projects">, ops: ExpectationOp[]): Promise<Set<ExpectationCitation>> {
  const said = new Set<ExpectationCitation>();
  for (const op of ops) {
    if (op.op !== "add") continue;
    for (const c of groundingCandidates(op)) if (await personSaid(ctx, project, c)) said.add(c);
  }
  return said;
}

/** Put an open proposal in the project's person's queue from the session that proposed it. */
async function postCard(ctx: Ctx, userId: Id<"users">, conversation: any, project: Doc<"projects">, proposal: any, current: any[]): Promise<{ card?: string; card_error?: string }> {
  const person = await projectPerson(ctx, project);
  const n = proposal.ops.length;
  const asked = await askCore(ctx as any, { userId }, {
    session_id: conversation.session_id,
    question: `Apply ${n} change${n === 1 ? "" : "s"} to ${project.title}'s expectations (${proposal.short_id})?`,
    options: [
      { label: EXPECTATION_CARD_OPTIONS[0], description: `They become version ${proposal.base_version + 1}, which judges grade against from then on.` },
      { label: EXPECTATION_CARD_OPTIONS[1], description: `The proposal closes; the expectations stay at version ${proposal.base_version}.` },
    ],
    context_md: renderProposal(proposal, current),
    blocking: false,
    silent: true,
    to: [String(person)],
  });
  if (asked?.error) return { card_error: asked.error };
  await ctx.db.patch(proposal._id, { decision_id: asked.id });
  return { card: asked.short_id };
}

/**
 * `cast expectations propose`: store a proposal against the current version.
 * Every change is checked against the document now, so a proposal that cannot
 * apply is refused with the reason instead of waiting on a person. With no
 * changes it records the harvest window alone (the routine's cursor).
 */
export const propose = mutation({
  args: {
    api_token: v.string(),
    summary: v.string(),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
    ops: v.array(expectationOpValidator),
    // Wait for a person even when the proposal could apply on its own.
    hold: v.optional(v.boolean()),
    ...scopeArgs,
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx, args.api_token);
    const { project, conversation } = await projectInScope(ctx, userId, args);
    return proposeCore(ctx, userId, project, conversation, args);
  },
});

/**
 * Store a proposal and apply it when it may apply now. `applyAs` is the web's
 * verdict on a person's own edit (personEditApplies), decided before the call;
 * without it the record is checked for the words of a person (personSaid).
 */
async function proposeCore(
  ctx: Ctx,
  userId: Id<"users">,
  project: Doc<"projects">,
  conversation: any,
  args: { summary: string; since?: number; until?: number; ops: any[]; hold?: boolean },
  applyAs?: "person" | "auto" | null,
) {
  if (args.ops.length > LIMITS.ops) throw new Error(`At most ${LIMITS.ops} changes in one proposal`);
  const ops: ExpectationOp[] = args.ops.map(normalizeOp);
  const shapeErrors = ops.flatMap((op, i) => opErrors(op).map((e) => `op ${i + 1}: ${e}`));
  if (shapeErrors.length) throw new Error(`The proposal cannot apply:\n${shapeErrors.join("\n")}`);
  const latest = await latestExpectations(ctx, project._id);
  const base = latest?.version ?? 0;
  const trial = applyOps({ items: latest?.items ?? [], prefix: latest?.prefix ?? "x", next_n: latest?.next_n ?? 1 }, ops, base + 1, base);
  if (!trial.ok) throw new Error(`The proposal cannot apply to version ${base}:\n${trial.errors.join("\n")}`);

  const now = Date.now();
  const short_id = await nextShortId(ctx.db as any, "xp");
  const id = await ctx.db.insert("expectation_proposals", {
    short_id,
    project_id: project._id,
    user_id: userId,
    team_id: project.team_id,
    workspace: project.workspace ?? computeWorkspaceKey(project, null),
    ...(conversation ? { conversation_id: conversation._id } : {}),
    summary: args.summary.trim().slice(0, LIMITS.summary) || `${ops.length} changes`,
    ...(args.since !== undefined ? { since: args.since } : {}),
    ...(args.until !== undefined ? { until: args.until } : {}),
    base_version: base,
    ops,
    status: ops.length ? "open" : "empty",
    created_at: now,
    updated_at: now,
  });
  const proposal = await ctx.db.get(id);
  if (!ops.length) return { short_id, status: "empty", version: base };
  const said = args.hold || applyAs !== undefined ? new Set<ExpectationCitation>() : await citationsPersonSaid(ctx, project, ops);
  const how = applyAs !== undefined ? applyAs : !args.hold && autoApplies(ops, (c) => said.has(c)) ? "auto" : null;
  if (how) {
    const applied = await performApply(ctx, proposal, userId, how, now);
    if (applied.ok) return { short_id, status: "applied", version: applied.version, auto: how === "auto" };
  }
  const card = conversation ? await postCard(ctx, userId, conversation, project, proposal, latest?.items ?? []) : {};
  return { short_id, status: "open", version: base, ...card };
}

/** The project a web write names, when the signed-in person can open it. */
async function webProject(ctx: Ctx, userId: Id<"users">, projectId: string): Promise<Doc<"projects">> {
  const id = ctx.db.normalizeId("projects", projectId);
  const project = id ? await ctx.db.get(id) : null;
  if (!project || !(await canAccessProject(ctx, userId, project))) notFound("Project not found");
  return project as Doc<"projects">;
}

/**
 * A person's own edit from the web (line-map.md LX3, LX5): a line in their
 * words (with a source they name), a change to a line, or a retirement with
 * the reason, cited as them (personOp). It is a
 * proposal like any other and applies by personEditApplies: at once for the
 * project's person, on the rule for anyone else's line, and otherwise it
 * waits open on the Line tab.
 */
export async function personEditCore(ctx: Ctx, userId: Id<"users">, projectId: string, edit: PersonEdit) {
  if (edit?.op !== "add" && edit?.op !== "edit" && edit?.op !== "retire") throw new Error("A person adds, changes or retires a line here");
  const project = await webProject(ctx, userId, projectId);
  const op = personOp(edit, String(userId), Date.now());
  const youAnswer = String(await projectPerson(ctx, project)) === String(userId);
  const summary = personEditSummary(edit, personName(await ctx.db.get(userId)));
  const applyAs = personEditApplies(op, youAnswer) ? (youAnswer ? "person" : "auto") : null;
  return proposeCore(ctx, userId, project, null, { summary, ops: [op] }, applyAs);
}

/**
 * A person applies or drops a proposal (LM5): from a terminal or the web,
 * never from an agent session, which proposes and leaves the answer to the
 * person (resolveProposalCore).
 */
export const resolve = mutation({
  args: { api_token: v.optional(v.string()), proposal: v.string(), action: v.union(v.literal("apply"), v.literal("drop")), conversation_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.conversation_id) throw new Error("Applying or dropping expectations is a person's act: an agent session proposes (cast expectations propose) and the project's person answers the card");
    const userId = await requireUser(ctx, args.api_token);
    return resolveProposalCore(ctx, userId, args.proposal, args.action);
  },
});

/**
 * Apply or drop an open proposal as a person. A card the person holds is
 * answered rather than withdrawn: the card is the same decision, and its
 * settle path applies or drops the proposal (settleExpectationCard). An apply
 * the document refuses throws, which takes the answer back with it. `settled`
 * accepts a proposal already where the person asked it to go: the web's
 * dispatch may follow the queue's own answer to the card.
 */
export async function resolveProposalCore(ctx: Ctx, userId: Id<"users">, proposalRef: string, action: "apply" | "drop", opts: { settled?: boolean } = {}) {
  const ref = proposalRef.trim();
  const proposal = (await ctx.db.query("expectation_proposals").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first())
    ?? (ctx.db.normalizeId("expectation_proposals", ref) ? await ctx.db.get(ctx.db.normalizeId("expectation_proposals", ref)!) : null);
  const project = proposal ? await ctx.db.get(proposal.project_id) : null;
  if (!proposal || !project || !(await canAccessProject(ctx, userId, project))) notFound(`Proposal ${ref} not found`);
  const want = action === "apply" ? "applied" : "dropped";
  if (opts.settled && proposal!.status === want) return { short_id: proposal!.short_id, status: want, ...(proposal!.applied_version ? { version: proposal!.applied_version } : {}) };
  if (proposal!.status !== "open") throw new Error(`${proposal!.short_id} is already ${proposal!.status}`);
  const now = Date.now();
  const card = proposal!.decision_id ? await ctx.db.get(proposal!.decision_id) : null;
  if (card?.status === "pending" && personMayResolve(card, userId)) {
    await finalizeAnswer(ctx as any, card, { status: "answered", answer_index: EXPECTATION_CARD_OPTIONS.indexOf(action === "apply" ? "Apply" : "Drop") }, { kind: "user", id: String(userId), user_id: userId }, { deliver: false, now });
    const after = await ctx.db.get(proposal!._id);
    if (after?.status !== want) throw new Error(`${proposal!.short_id} cannot apply:\n${after?.refused ?? "the document changed under it"}`);
    return { short_id: proposal!.short_id, status: want, ...(after.applied_version ? { version: after.applied_version } : {}) };
  }
  let result: { status: string; version?: number };
  if (action === "apply") {
    const applied = await performApply(ctx, proposal, userId, "person", now);
    if (!applied.ok) throw new Error(`${proposal!.short_id} cannot apply:\n${applied.error}`);
    result = { status: "applied", version: applied.version };
  } else {
    await ctx.db.patch(proposal!._id, { status: "dropped", resolved_by: userId, resolved_at: now, updated_at: now });
    result = { status: "dropped" };
  }
  if (card?.status === "pending") await withdrawCore(ctx as any, card, now);
  return { short_id: proposal!.short_id, ...result };
}

/**
 * An operator withdraws a proposal that should never have been made (a test
 * run that reached prod, a pass outside the routine), with the reason. It
 * moves no cursor afterwards, so the next pass reads its window again. An
 * applied proposal is not retracted: its lines are in a version judges may
 * have graded against, and they leave only through a retirement a person
 * applies. Run with packages/convex/run.sh expectations:retract.
 */
export const retract = internalMutation({
  args: { proposal: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const proposal = await ctx.db.query("expectation_proposals").withIndex("by_short_id", (q) => q.eq("short_id", args.proposal.trim())).first();
    if (!proposal) throw new Error(`Proposal ${args.proposal} not found`);
    if (proposal.status !== "open" && proposal.status !== "empty") throw new Error(`${proposal.short_id} is ${proposal.status}; only an open or empty proposal is retracted (an applied one leaves through a retirement)`);
    if (!args.reason.trim()) throw new Error("Say why it is retracted");
    const now = Date.now();
    await ctx.db.patch(proposal._id, { status: "retracted", retracted_reason: args.reason.trim().slice(0, LIMITS.reason), updated_at: now });
    const decision = proposal.decision_id ? await ctx.db.get(proposal.decision_id) : null;
    if (decision?.status === "pending") await withdrawCore(ctx as any, decision, now);
    return { short_id: proposal.short_id, status: "retracted" };
  },
});
