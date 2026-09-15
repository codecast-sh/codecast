import { mutation, query } from "./functions";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { nextShortId } from "./counters";
import { resolveSessionConversation } from "./lib/access";
import { resolveActor } from "./lib/actor";
import { userCanAccessRole, userCanAdminRole } from "./lib/orgAccess";
import { requireWorkspaceCaller } from "./org";
import { applyOrgChange, type ApplyResult, type Boundary } from "./orgInit";
import { askCore, setInboxStatus } from "./sessionDecisions";
import {
  describeOrgChange,
  orderOrgChanges,
  orgChangeError,
  parseOrgProposalSpec,
  type OrgChange,
  type OrgProposalSpec,
} from "@codecast/shared/contracts/orgProposal";

// Staffing proposals (docs/architecture/org-staffing.md S4): a set of changes
// to the chart with a rationale each, authored by an agent or a person and
// decided change by change. Accepting applies at once through the one apply
// core (orgInit.applyOrgChange); a proposal resolves when every change is
// applied or skipped.
//
// Who may accept: a person. The web caller (browser identity, no token) and
// a plain shell (a token, no session) are the person; a call that names the
// session it runs in is an agent's and is refused, whatever token it holds.

type Ctx = { db: any; auth?: any; scheduler?: any };
type ProposalRow = any;
type ChangeRow = any;

export const PROPOSAL_LIST_CAP = 50;
export const PROPOSAL_LINK = (shortId: string) => `/org?proposal=${shortId}`;

const hostShape = (p: ProposalRow) => ({ host_user_id: p.created_by, scope_user_id: p.scope_user_id, team_id: p.team_id });
const boundaryOf = (p: ProposalRow): Boundary => (p.team_id ? { team_id: p.team_id } : { scope_user_id: p.scope_user_id });

export function refuseSessionCaller(args: { from_session?: string }): void {
  if (args.from_session) throw new Error("Deciding a proposal is a person's act: an agent session may not accept or skip a change; use the org page or a plain shell");
}

export async function findProposal(ctx: Ctx, ref: string): Promise<ProposalRow | null> {
  const trimmed = ref.trim();
  const byShort = await ctx.db.query("org_proposals").withIndex("by_short_id", (q: any) => q.eq("short_id", trimmed)).first();
  if (byShort) return byShort;
  const id = typeof ctx.db.normalizeId === "function" ? ctx.db.normalizeId("org_proposals", trimmed) : trimmed;
  return id ? await ctx.db.get(id).catch(() => null) : null;
}

export async function changesOf(ctx: Ctx, proposalId: Id<"org_proposals">): Promise<ChangeRow[]> {
  return ctx.db.query("org_proposal_changes").withIndex("by_proposal", (q: any) => q.eq("proposal_id", proposalId)).collect();
}

/** A change by its row id, or "op-N#<seq>". */
export async function findChange(ctx: Ctx, ref: string): Promise<{ change: ChangeRow; proposal: ProposalRow } | null> {
  const m = /^(op-\d+)#(\d+)$/.exec(ref.trim());
  if (m) {
    const proposal = await findProposal(ctx, m[1]);
    if (!proposal) return null;
    const change = (await changesOf(ctx, proposal._id)).find((c) => c.seq === Number(m[2]));
    return change ? { change, proposal } : null;
  }
  const id = typeof ctx.db.normalizeId === "function" ? ctx.db.normalizeId("org_proposal_changes", ref.trim()) : ref.trim();
  const change = id ? await ctx.db.get(id).catch(() => null) : null;
  if (!change?.proposal_id) return null;
  const proposal = await ctx.db.get(change.proposal_id);
  return proposal ? { change, proposal } : null;
}

async function requireAdmin(ctx: Ctx, userId: Id<"users">, proposal: ProposalRow): Promise<void> {
  if (!(await userCanAdminRole(ctx, userId, hostShape(proposal)))) throw new Error(`Only ${proposal.short_id}'s author, the workspace owner or a team admin can decide it`);
}

// ── Create ──────────────────────────────────────────────────────────────────

export async function performCreateProposal(
  ctx: Ctx,
  userId: Id<"users">,
  args: { team_id?: Id<"teams">; spec: unknown; from_session?: string; evidence_doc_id?: Id<"docs"> },
): Promise<any> {
  const parsed = parseOrgProposalSpec(args.spec);
  if (!parsed.spec) throw new Error(`The proposal spec is not valid:\n- ${parsed.errors.join("\n- ")}`);
  const spec: OrgProposalSpec = parsed.spec;

  // The author: the role the calling session speaks for, else the session,
  // else the person. Identity follows the token (lib/actor).
  const conversation = args.from_session ? await resolveSessionConversation(ctx as any, userId, args.from_session) : null;
  if (args.from_session && !conversation) throw new Error("Session not found");
  const actor = await resolveActor(ctx as any, userId, conversation);
  const author = actor.kind === "role" && actor.role
    ? { kind: "role" as const, id: String(actor.role._id) }
    : conversation
      ? { kind: "session" as const, id: String(conversation._id) }
      : { kind: "user" as const, id: String(userId) };

  const now = Date.now();
  const short_id = await nextShortId(ctx.db, "op");
  const proposalId: Id<"org_proposals"> = await ctx.db.insert("org_proposals", {
    short_id,
    team_id: args.team_id,
    scope_user_id: args.team_id ? undefined : userId,
    author,
    created_by: userId,
    title: spec.title,
    summary_md: spec.summary_md,
    mode: spec.mode,
    status: "open",
    evidence_doc_id: args.evidence_doc_id,
    created_at: now,
    updated_at: now,
  });
  const changes = [];
  for (const [i, c] of spec.changes.entries()) {
    const id = await ctx.db.insert("org_proposal_changes", {
      proposal_id: proposalId,
      seq: i + 1,
      change: c.change,
      rationale: c.rationale,
      evidence: c.evidence ?? [],
      expected_effect: c.expected_effect,
      risk: c.risk,
      status: "proposed",
    });
    changes.push({ id, seq: i + 1, change: c.change, status: "proposed", line: describeOrgChange(c.change) });
  }

  // The queue: one advisory decision for the person the author reports to,
  // through the ask core so it rides the ladder and the inbox like any other.
  // A person proposing for themself gets no card.
  let decision: { id: string; short_id?: string } | undefined;
  let decision_error: string | undefined;
  if (conversation) {
    const who = actor.kind === "role" ? actor.role?.name ?? "A role" : conversation.title || "A session";
    const n = spec.changes.length;
    const asked = await askCore(ctx as any, { userId }, {
      session_id: conversation.session_id,
      question: `${who} proposes ${n} change${n === 1 ? "" : "s"}: ${spec.title}`,
      options: [
        { label: "Review on the org page", description: `Open ${short_id} and accept, edit or skip each change` },
        { label: "Not now", description: "Leave the proposal open; the org page keeps it" },
      ],
      context_md: `${spec.summary_md}\n\n[Open ${short_id} on the org page](${PROPOSAL_LINK(short_id)})\n\n${spec.changes.map((c) => `- ${describeOrgChange(c.change)}`).join("\n")}`,
      blocking: false,
      default_option: 0,
      category: "org",
    });
    if (asked?.error) decision_error = asked.error;
    else if (asked?.id) {
      decision = { id: String(asked.id), short_id: asked.short_id };
      await ctx.db.patch(proposalId, { decision_id: asked.id });
    }
  }
  return { id: proposalId, short_id, status: "open", author, changes, link: PROPOSAL_LINK(short_id), decision, decision_error };
}

// ── Read ────────────────────────────────────────────────────────────────────

export async function readProposal(ctx: Ctx, userId: Id<"users">, ref: string): Promise<any | null> {
  const proposal = await findProposal(ctx, ref);
  if (!proposal || !(await userCanAccessRole(ctx, userId, hostShape(proposal)))) return null;
  const changes = (await changesOf(ctx, proposal._id)).map((c) => ({ ...c, line: describeOrgChange(c.change) }));
  return { ...proposal, changes, link: PROPOSAL_LINK(proposal.short_id), counts: countsOf(changes) };
}

const countsOf = (changes: ChangeRow[]) => ({
  total: changes.length,
  decided: changes.filter((c) => c.status !== "proposed").length,
  applied: changes.filter((c) => c.status === "applied").length,
  failed: changes.filter((c) => c.status === "failed").length,
  skipped: changes.filter((c) => c.status === "skipped").length,
});

export async function listProposals(ctx: Ctx, userId: Id<"users">, args: { team_id?: Id<"teams">; status?: string }): Promise<any[]> {
  const rows: ProposalRow[] = args.team_id
    ? await ctx.db.query("org_proposals").withIndex("by_team", (q: any) => q.eq("team_id", args.team_id)).order("desc").take(PROPOSAL_LIST_CAP * 2)
    : await ctx.db.query("org_proposals").withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId)).order("desc").take(PROPOSAL_LIST_CAP * 2);
  const rank = (s: string) => (s === "open" ? 0 : s === "resolved" ? 1 : 2);
  const kept = rows.filter((p) => !args.status || p.status === args.status).sort((a, b) => rank(a.status) - rank(b.status) || b.created_at - a.created_at).slice(0, PROPOSAL_LIST_CAP);
  const out = [];
  for (const p of kept) out.push({ ...p, link: PROPOSAL_LINK(p.short_id), counts: countsOf(await changesOf(ctx, p._id)) });
  return out;
}

// ── Decide, accept all, withdraw ────────────────────────────────────────────

async function resolveIfDone(ctx: Ctx, proposal: ProposalRow, now: number): Promise<boolean> {
  const open = (await changesOf(ctx, proposal._id)).some((c) => c.status === "proposed" || c.status === "accepted");
  if (open) return false;
  await ctx.db.patch(proposal._id, { status: "resolved", resolved_at: now, updated_at: now });
  await clearDecision(ctx, proposal, now);
  return true;
}

// The queue card exists to point at the org page; once the proposal is
// settled there, the card leaves the queue.
async function clearDecision(ctx: Ctx, proposal: ProposalRow, now: number): Promise<void> {
  if (!proposal.decision_id) return;
  const d = await ctx.db.get(proposal.decision_id);
  if (d?.status !== "pending") return;
  await ctx.db.patch(d._id, { status: "withdrawn", resolved_at: now });
  await setInboxStatus(ctx as any, d._id, "done");
}

/** Merge a person's edits into a change and check the result is still one. */
export function editedChange(change: OrgChange, edits: unknown): OrgChange {
  if (edits === undefined || edits === null) return change;
  if (typeof edits !== "object" || Array.isArray(edits)) throw new Error("edits is an object patch over the change's own keys");
  const merged = { ...change, ...(edits as object), kind: change.kind } as OrgChange;
  const fault = orgChangeError(merged);
  if (fault) throw new Error(`The edited change is not valid: ${fault}`);
  return merged;
}

async function acceptOne(ctx: Ctx, userId: Id<"users">, proposal: ProposalRow, change: ChangeRow, edits: unknown, now: number) {
  const merged = editedChange(change.change, edits);
  await ctx.db.patch(change._id, { status: "accepted", edits: edits ?? undefined, decided_by: userId, decided_at: now });
  let result: ApplyResult | { status: "error"; error: string };
  try {
    result = await applyOrgChange(ctx, userId, boundaryOf(proposal), merged, { provision: true, human_decision: `proposal:${String(change._id)}` });
  } catch (err) {
    result = { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
  const ok = result.status === "applied";
  const note = ok ? result.note : result.status === "error" ? result.error : result.status === "skipped" ? result.note : "not applied";
  await ctx.db.patch(change._id, { status: ok ? "applied" : "failed", applied_note: note.slice(0, 500), applied_at: now });
  return { change_id: change._id, seq: change.seq, status: ok ? "applied" : "failed", note, role: ok && "role" in result ? result.role : undefined, line: describeOrgChange(merged) };
}

export async function performDecideChange(
  ctx: Ctx,
  userId: Id<"users">,
  args: { change_id: string; verdict: "accept" | "skip"; edits?: unknown; from_session?: string },
): Promise<any> {
  refuseSessionCaller(args);
  const found = await findChange(ctx, args.change_id);
  if (!found) throw new Error(`Change not found: ${args.change_id}`);
  const { change, proposal } = found;
  await requireAdmin(ctx, userId, proposal);
  if (proposal.status !== "open") throw new Error(`${proposal.short_id} is ${proposal.status}`);
  if (change.status !== "proposed") throw new Error(`${proposal.short_id}#${change.seq} is already ${change.status}`);
  const now = Date.now();
  let out: any;
  if (args.verdict === "skip") {
    await ctx.db.patch(change._id, { status: "skipped", decided_by: userId, decided_at: now });
    out = { change_id: change._id, seq: change.seq, status: "skipped", line: describeOrgChange(change.change) };
  } else {
    out = await acceptOne(ctx, userId, proposal, change, args.edits, now);
  }
  await ctx.db.patch(proposal._id, { updated_at: now });
  const resolved = await resolveIfDone(ctx, proposal, now);
  return { ...out, proposal: proposal.short_id, resolved };
}

/** Roles whose parent is another role in the same batch go after it, so the
 *  handle resolves when the child is created. Within a rank the spec's order
 *  holds (orderOrgChanges); this only moves a child below its parent. */
export function orderForApply(rows: ChangeRow[]): ChangeRow[] {
  const ordered = orderOrgChanges(rows, (r) => r.change as OrgChange);
  const handleOf = (r: ChangeRow) => (r.change?.kind === "role" ? String(r.change.handle).replace(/^@/, "").toLowerCase() : null);
  const parentOf = (r: ChangeRow) => (r.change?.kind === "role" && typeof r.change.reports_to === "string" && r.change.reports_to.startsWith("@") ? r.change.reports_to.slice(1).toLowerCase() : null);
  const out = [...ordered];
  for (let pass = 0; pass < out.length; pass++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      const parent = parentOf(out[i]);
      if (!parent) continue;
      const j = out.findIndex((r) => handleOf(r) === parent);
      if (j > i) { const [child] = out.splice(i, 1); out.splice(j, 0, child); moved = true; break; }
    }
    if (!moved) break;
  }
  return out;
}

export async function performAcceptAll(ctx: Ctx, userId: Id<"users">, args: { proposal: string; from_session?: string }): Promise<any> {
  refuseSessionCaller(args);
  const proposal = await findProposal(ctx, args.proposal);
  if (!proposal) throw new Error(`Proposal not found: ${args.proposal}`);
  await requireAdmin(ctx, userId, proposal);
  if (proposal.status !== "open") throw new Error(`${proposal.short_id} is ${proposal.status}`);
  const now = Date.now();
  const pending = orderForApply((await changesOf(ctx, proposal._id)).filter((c) => c.status === "proposed"));
  const results = [];
  for (const change of pending) results.push(await acceptOne(ctx, userId, proposal, change, undefined, now));
  await ctx.db.patch(proposal._id, { updated_at: now });
  const resolved = await resolveIfDone(ctx, proposal, now);
  return { proposal: proposal.short_id, results, resolved, applied: results.filter((r) => r.status === "applied").length, failed: results.filter((r) => r.status === "failed").length };
}

export async function performWithdrawProposal(ctx: Ctx, userId: Id<"users">, args: { proposal: string; from_session?: string }): Promise<any> {
  const proposal = await findProposal(ctx, args.proposal);
  if (!proposal) throw new Error(`Proposal not found: ${args.proposal}`);
  // The author's account may take its proposal back; so may an admin of the
  // boundary. A session may withdraw only what its own account authored.
  const isAuthor = String(proposal.created_by) === String(userId);
  if (!isAuthor && !(await userCanAdminRole(ctx, userId, hostShape(proposal)))) throw new Error(`Only ${proposal.short_id}'s author or a team admin can withdraw it`);
  if (proposal.status !== "open") throw new Error(`${proposal.short_id} is already ${proposal.status}`);
  const now = Date.now();
  await ctx.db.patch(proposal._id, { status: "withdrawn", resolved_at: now, updated_at: now });
  await clearDecision(ctx, proposal, now);
  return { proposal: proposal.short_id, status: "withdrawn" };
}

// ── Functions ───────────────────────────────────────────────────────────────

async function requireCaller(ctx: any, apiToken: string | undefined, teamId: Id<"teams"> | undefined): Promise<Id<"users">> {
  const userId = await requireWorkspaceCaller(ctx, apiToken, teamId);
  if (!userId) throw new Error(teamId ? "Not a member of that team" : "Authentication failed: invalid token or session");
  return userId;
}

export const create = mutation({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    from_session: v.optional(v.string()),
    evidence_doc_id: v.optional(v.id("docs")),
    title: v.string(),
    summary_md: v.string(),
    mode: v.string(),
    changes: v.array(v.any()),
  },
  handler: async (ctx, { api_token, team_id, from_session, evidence_doc_id, ...spec }) => {
    const userId = await requireCaller(ctx, api_token, team_id);
    return performCreateProposal(ctx, userId, { team_id, spec, from_session, evidence_doc_id });
  },
});

export const get = query({
  args: { api_token: v.optional(v.string()), proposal: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    return readProposal(ctx, userId, args.proposal);
  },
});

export const list = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireWorkspaceCaller(ctx, args.api_token, args.team_id);
    if (!userId) return null;
    return { proposals: await listProposals(ctx, userId, args) };
  },
});

export const decide = mutation({
  args: {
    api_token: v.optional(v.string()),
    from_session: v.optional(v.string()),
    change_id: v.string(),
    verdict: v.union(v.literal("accept"), v.literal("skip")),
    edits: v.optional(v.any()),
  },
  handler: async (ctx, { api_token, ...args }) => performDecideChange(ctx, await requireCaller(ctx, api_token, undefined), args),
});

export const acceptAll = mutation({
  args: { api_token: v.optional(v.string()), from_session: v.optional(v.string()), proposal: v.string() },
  handler: async (ctx, { api_token, ...args }) => performAcceptAll(ctx, await requireCaller(ctx, api_token, undefined), args),
});

export const withdraw = mutation({
  args: { api_token: v.optional(v.string()), from_session: v.optional(v.string()), proposal: v.string() },
  handler: async (ctx, { api_token, ...args }) => performWithdrawProposal(ctx, await requireCaller(ctx, api_token, undefined), args),
});
