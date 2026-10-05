// A project's expectations (docs/architecture/the-line-model.md LM5): one
// living document per project, versioned, changed only through proposals.
//
// - `show` / `forProject`: a version of the document with its history, the
//   recent proposals and the routine's cursor (the CLI, the Line tab).
// - `brief`: the active lines as compact text under the version to cite, the
//   route a judge calls.
// - `propose`: store a proposal. One that only adds well-cited lines applies
//   on its own; anything else waits for the project's person, as a card in
//   their queue when an agent session proposed it.
// - `resolve`: a person applies or drops a proposal (the CLI, the web). The
//   card's answer takes the same path (lib/expectationsApply).
//
// Access is the project's: a caller resolves the project inside the
// workspace its data context names, and a proposal is read through its
// project (canAccessProject).
import { v } from "convex/values";
import { mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { createWorkContext } from "./data";
import { canAccessProject, computeWorkspaceKey } from "./lib/access";
import { notFound } from "./lib/auth";
import { resolveWorkspaceProject } from "./lib/projectRef";
import { nextShortId } from "./counters";
import { askCore, withdrawCore } from "./sessionDecisions";
import { allRolesInBoundary } from "./lib/orgAccess";
import { answererOf } from "./orgLine";
import { personName } from "./sessionOwnership";
import { expectationOpValidator } from "./expectationsSchema";
import { EXPECTATION_CARD_OPTIONS, latestExpectations, performApply } from "./lib/expectationsApply";
import {
  applyOps,
  autoApplies,
  LIMITS,
  normalizeOp,
  opErrors,
  renderExpectations,
  renderProposal,
  type ExpectationOp,
  type ExpectationsVersion,
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
    items: row.items,
    applied_at: row.created_at,
    applied_by: personName(await ctx.db.get(row.user_id)),
    how: row.how,
    summary: row.summary,
    ...(proposal ? { proposal: proposal.short_id } : {}),
  };
}

function proposalView(p: any, decision: any) {
  return {
    short_id: p.short_id,
    status: p.status,
    summary: p.summary,
    changes: p.ops.length,
    base_version: p.base_version,
    ...(p.applied_version ? { applied_version: p.applied_version } : {}),
    ...(decision?.short_id ? { card: decision.short_id } : {}),
    ...(p.refused ? { refused: p.refused } : {}),
    ...(p.since ? { since: p.since } : {}),
    ...(p.until ? { until: p.until } : {}),
    created_at: p.created_at,
  };
}

/** The read every surface shares: one version (the current one by default), the history, recent proposals, the cursor. */
async function readExpectations(ctx: Ctx, project: Doc<"projects">, version?: number) {
  const byVersion = () => ctx.db.query("project_expectations").withIndex("by_project_version", (q: any) => (version === undefined ? q.eq("project_id", project._id) : q.eq("project_id", project._id).eq("version", version)));
  const versions: any[] = await ctx.db.query("project_expectations").withIndex("by_project_version", (q: any) => q.eq("project_id", project._id)).order("desc").take(VERSIONS_LISTED);
  const row = version === undefined ? versions[0] ?? null : versions.find((r) => r.version === version) ?? (await byVersion().first());
  if (version !== undefined && !row) notFound(`${project.title} has no expectations version ${version}`);
  const proposals: any[] = await ctx.db.query("expectation_proposals").withIndex("by_project_created", (q: any) => q.eq("project_id", project._id)).order("desc").take(PROPOSALS_READ);
  const shown = proposals.slice(0, PROPOSALS_SHOWN);
  const decisions = await Promise.all(shown.map((p) => (p.decision_id ? ctx.db.get(p.decision_id) : null)));
  const cursor = proposals.reduce((max: number | null, p) => (p.until && (max === null || p.until > max) ? p.until : max), null);
  return {
    project: { id: String(project._id), title: project.title },
    current_version: versions[0]?.version ?? 0,
    doc: row ? await versionView(ctx, project, row) : null,
    versions: await Promise.all(versions.map(async (r) => ({ version: r.version, summary: r.summary, how: r.how, applied_at: r.created_at, applied_by: personName(await ctx.db.get(r.user_id)), active: r.items.filter((e: any) => e.status === "active").length }))),
    proposals: shown.map((p, i) => proposalView(p, decisions[i])),
    cursor,
  };
}

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
    return readExpectations(ctx, project, args.version);
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
    if (autoApplies(ops) && !args.hold) {
      const applied = await performApply(ctx, proposal, userId, "auto", now);
      if (applied.ok) return { short_id, status: "applied", version: applied.version, auto: true };
    }
    const card = conversation ? await postCard(ctx, userId, conversation, project, proposal, latest?.items ?? []) : {};
    return { short_id, status: "open", version: base, ...card };
  },
});

/**
 * A person applies or drops a proposal (LM5): from a terminal or the web,
 * never from an agent session, which proposes and leaves the answer to the
 * person. The proposal's open card, if any, is withdrawn: it was answered here.
 */
export const resolve = mutation({
  args: { api_token: v.optional(v.string()), proposal: v.string(), action: v.union(v.literal("apply"), v.literal("drop")), conversation_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.conversation_id) throw new Error("Applying or dropping expectations is a person's act: an agent session proposes (cast expectations propose) and the project's person answers the card");
    const userId = await requireUser(ctx, args.api_token);
    const ref = args.proposal.trim();
    const proposal = (await ctx.db.query("expectation_proposals").withIndex("by_short_id", (q) => q.eq("short_id", ref)).first())
      ?? (ctx.db.normalizeId("expectation_proposals", ref) ? await ctx.db.get(ctx.db.normalizeId("expectation_proposals", ref)!) : null);
    const project = proposal ? await ctx.db.get(proposal.project_id) : null;
    if (!proposal || !project || !(await canAccessProject(ctx, userId, project))) notFound(`Proposal ${ref} not found`);
    if (proposal!.status !== "open") throw new Error(`${proposal!.short_id} is already ${proposal!.status}`);
    const now = Date.now();
    let result: { status: string; version?: number };
    if (args.action === "apply") {
      const applied = await performApply(ctx, proposal, userId, "person", now);
      if (!applied.ok) throw new Error(`${proposal!.short_id} cannot apply:\n${applied.error}`);
      result = { status: "applied", version: applied.version };
    } else {
      await ctx.db.patch(proposal!._id, { status: "dropped", resolved_by: userId, resolved_at: now, updated_at: now });
      result = { status: "dropped" };
    }
    const decision = proposal!.decision_id ? await ctx.db.get(proposal!.decision_id) : null;
    if (decision?.status === "pending") await withdrawCore(ctx as any, decision, now);
    return { short_id: proposal!.short_id, ...result };
  },
});
