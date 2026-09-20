import { mutation, query, internalMutation } from "./functions";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { canSendProductMessage, enqueuePendingMessage, getAuthenticatedUserId } from "./pendingMessages";
import { nextShortId } from "./counters";
import { resolveSessionConversation } from "./lib/access";
import { resolveActor } from "./lib/actor";
import { computeOrgHealth } from "./orgHealth";
import { userCanAccessRole, userCanAdminRole } from "./lib/orgAccess";
import { refuseUnlessHuman } from "./orgRoles";
import { requireWorkspaceCaller } from "./org";
import { applyOrgChange, type ApplyResult, type Boundary } from "./orgInit";
import { STABILITY } from "@codecast/shared/contracts/orgCapacity";
import { performProvisionRole, rolesInBoundary } from "./orgRoles";
import { askCore, setInboxStatus } from "./sessionDecisions";
import {
  describeOrgChange, orgChangeDependencies,
  editedOrgChange,
  isOrgChangeDecidable,
  orderOrgChanges,
  orgChangeError,
  orgChangeKey,
  orgReviseOpError,
  normalizeOrgSpecChange,
  parseOrgProposalSpec,
  latestOrgRevisionAt,
  orgVerdictSeenFault,
  resolveOrgAsks,
  withAboutAsk,
  withAboutChange,
  type OrgChange,
  type OrgChangeRevision,
  type OrgProposalSpec,
  type OrgReviseOp,
  type OrgRevision,
  type OrgVerdictSeen,
} from "@codecast/shared/contracts/orgProposal";

// Staffing proposals (docs/architecture/org-staffing.md S4): a set of changes
// to the chart with a rationale each, authored by an agent or a person and
// decided change by change. Accepting applies at once through the one apply
// core (orgInit.applyOrgChange); a proposal resolves when every change is
// applied or skipped.
//
// Who may accept: a person, on the server's own evidence: a browser identity
// and no api token (orgRoles.refuseUnlessHuman). A token call, from a shell
// or a session, is refused with the reason.

type Ctx = { db: any; auth?: any; scheduler?: any };
type ProposalRow = any;
type ChangeRow = any;

export const PROPOSAL_LIST_CAP = 50;
export const PROPOSAL_LINK = (shortId: string) => `/org?proposal=${shortId}`;

const hostShape = (p: ProposalRow) => ({ host_user_id: p.created_by, scope_user_id: p.scope_user_id, team_id: p.team_id });
const boundaryOf = (p: ProposalRow): Boundary => (p.team_id ? { team_id: p.team_id } : { scope_user_id: p.scope_user_id });

// Deciding is a person's act, on the server's own evidence (the T4 rule that
// guards trust, caps and scope): a browser identity and no token. A token is a
// terminal's, and a terminal can be a hand's, so `cast org apply` at a shell
// is refused with the reason and the person decides on the org page.
export async function refuseUnlessHumanDecider(ctx: Ctx, args: { api_token?: string; from_session?: string }): Promise<void> {
  if (args.from_session) throw new Error("Deciding a proposal is a person's act: an agent session may not accept or skip a change; use the org page");
  await refuseUnlessHuman(ctx, { api_token: args.api_token, from_session: args.from_session }, "Proposal decision");
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
  args: { team_id?: Id<"teams">; spec: unknown; from_session?: string; evidence_doc_id?: Id<"docs">; supersedes?: string },
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

  // Supersession: the older proposal must be open, in the same workspace,
  // and the author's own: the same session, the same role, the role this
  // session speaks for or a session that spoke for this role, or the same
  // person. Anything else is refused, so a review cannot mark down a
  // proposal it did not write.
  const older = args.supersedes ? await findProposal(ctx, args.supersedes) : null;
  if (args.supersedes) {
    if (!older) throw new Error(`supersedes: proposal not found: ${args.supersedes}`);
    if (older.status !== "open") throw new Error(`supersedes: ${older.short_id} is ${older.status}`);
    const sameWorkspace = args.team_id ? String(older.team_id) === String(args.team_id) : !older.team_id && String(older.scope_user_id) === String(userId);
    if (!sameWorkspace) throw new Error(`supersedes: ${older.short_id} is in another workspace`);
    if (!(await authorOwns(ctx, userId, author, actor, older.author))) throw new Error(`supersedes: ${older.short_id} was not posted by this author, its role or the role's session; only its own author may replace it`);
  }

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
    ...(older ? { supersedes: older._id } : {}),
    // The thread a person talks to about it (S18): the posting session,
    // which for a role is its standing session. A person's proposal has none.
    ...(conversation ? { thread_conversation_id: conversation._id } : {}),
    // The asks (S19), already checked as a partition of the changes and
    // carried through the fold by the parser.
    ...(spec.asks ? { asks: spec.asks } : {}),
    created_at: now,
    updated_at: now,
  });
  if (older) await ctx.db.patch(older._id, { superseded_by: proposalId, updated_at: now });
  // A review is the tick of the stability clock: every role flagged
  // overloaded at this review extends its streak, every other role's resets,
  // so the next review can tell a first breach from a second (S2 STABILITY).
  // The health scan reads tables that change every second (messages), so it
  // runs as a query from a scheduled action, never inside this mutation: a
  // create that read them here could not commit under load.
  if (spec.mode === "review" && ctx.scheduler) {
    await ctx.scheduler.runAfter(0, internal.orgProposals.recordBreaches, { user_id: userId, team_id: args.team_id });
  }

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
    changes.push({ id, seq: i + 1, change: c.change, status: "proposed", line: describeOrgChange(c.change), depends: orgChangeDependencies(spec.changes.map((x, j) => ({ seq: j + 1, change: x.change })))[i + 1] });
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
        // An acknowledgement, worded as one: answering clears the card and
        // opens nothing, so the label must not read as an action that will.
        { label: "Got it, I will review it on the org page", description: `${short_id} stays open there: accept, edit or skip each change. The link is in the card.` },
        { label: "Not now", description: "Leave the proposal open; the org page keeps it" },
      ],
      context_md: `${spec.summary_md}\n\n[Open ${short_id} on the org page](${PROPOSAL_LINK(short_id)})\n\n${spec.changes.map((c) => `- ${describeOrgChange(c.change)}`).join("\n")}`,
      blocking: false,
      default_option: 0,
      category: "allocation",
      // S4: answering does nothing but clear the card. The link in the
      // context is the way in; no "Decision: …" message wakes the author.
      silent: true,
    });
    if (asked?.error) decision_error = asked.error;
    else if (asked?.id) {
      decision = { id: String(asked.id), short_id: asked.short_id };
      await ctx.db.patch(proposalId, { decision_id: asked.id });
    }
  }
  return { id: proposalId, short_id, status: "open", author, changes, link: PROPOSAL_LINK(short_id), decision, decision_error, ...(older ? { supersedes: { id: String(older._id), short_id: older.short_id, status: "open", created_at: older.created_at } } : {}) };
}

/**
 * Does the new author own the older proposal (supersession, S4)? The same
 * session, the same role, the same person; a role over a session that
 * spoke for it (the standing session's own earlier review); a session that
 * speaks for a role over that role's proposal.
 */
async function authorOwns(ctx: Ctx, userId: Id<"users">, author: { kind: string; id: string }, actor: any, olderAuthor: { kind: string; id: string }): Promise<boolean> {
  if (author.kind === olderAuthor.kind && author.id === olderAuthor.id) return true;
  const roleId = actor.kind === "role" && actor.role ? String(actor.role._id) : null;
  if (olderAuthor.kind === "role") return !!roleId && roleId === olderAuthor.id;
  if (olderAuthor.kind === "session") {
    if (!roleId) return false;
    const conv: any = await ctx.db.get(olderAuthor.id as Id<"conversations">);
    if (!conv) return false;
    const older = await resolveActor(ctx as any, userId, conv);
    return older.kind === "role" && !!older.role && String(older.role._id) === roleId;
  }
  return olderAuthor.kind === "user" && olderAuthor.id === String(userId);
}

/** The two supersession pointers, named: id, short id and when the other
 *  was posted, so the pane can say "Replaced by op-6, posted 2 hours ago". */
async function enrichSupersession(ctx: Ctx, row: ProposalRow): Promise<Record<string, unknown>> {
  const name = async (id: unknown) => {
    if (!id) return undefined;
    const p: any = await ctx.db.get(id as Id<"org_proposals">);
    return p ? { id: String(p._id), short_id: p.short_id, status: p.status, created_at: p.created_at } : undefined;
  };
  return { supersedes: await name(row.supersedes), superseded_by: await name(row.superseded_by) };
}

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * The author, named (org-staffing.md S15). The row stores kind and id; every
 * read hands back what the pill draws: a session's title and short id, a
 * role's name, handle, short id and avatar, a person's name. A row whose
 * subject is gone keeps the bare kind and id, so the pill still renders.
 */
async function enrichAuthor(ctx: Ctx, author: ProposalRow["author"]): Promise<Record<string, unknown>> {
  try {
    if (author.kind === "session") {
      const conv: any = await ctx.db.get(author.id as Id<"conversations">);
      return conv ? { ...author, title: conv.title ?? undefined, name: conv.title ?? undefined, short_id: conv.short_id ?? undefined } : author;
    }
    if (author.kind === "role") {
      const role: any = await ctx.db.get(author.id as Id<"org_roles">);
      return role ? { ...author, name: role.name, handle: role.handle, short_id: role.short_id, avatar: role.avatar ?? undefined } : author;
    }
    const user: any = await ctx.db.get(author.id as Id<"users">);
    return user ? { ...author, name: user.name ?? user.email ?? undefined } : author;
  } catch {
    return author;
  }
}

export async function readProposal(ctx: Ctx, userId: Id<"users">, ref: string): Promise<any | null> {
  const proposal = await findProposal(ctx, ref);
  if (!proposal || !(await userCanAccessRole(ctx, userId, hostShape(proposal)))) return null;
  const rows = await changesOf(ctx, proposal._id);
  const depends = orgChangeDependencies(rows.filter((c) => c.status !== "removed").map((c) => ({ seq: c.seq, change: c.change })));
  const changes = rows.map((c) => ({ ...c, line: describeOrgChange(c.change), depends: depends[c.seq] }));
  return { ...proposal, ...(await enrichSupersession(ctx, proposal)), ...(await enrichThread(ctx, proposal)), author: await enrichAuthor(ctx, proposal.author), changes, asks: resolveOrgAsks(proposal.asks, rows), link: PROPOSAL_LINK(proposal.short_id), counts: countsOf(changes) };
}

/** The conversation bound to a proposal (S18): the stored pointer, else,
 *  for a row from before the field, the posting session or the standing
 *  session of the posting role. Null for a person's proposal. */
export async function threadOf(ctx: Ctx, proposal: ProposalRow): Promise<any | null> {
  try {
    if (proposal.thread_conversation_id) return (await ctx.db.get(proposal.thread_conversation_id)) ?? null;
    if (proposal.author.kind === "session") return (await ctx.db.get(proposal.author.id as Id<"conversations">)) ?? null;
    if (proposal.author.kind === "role") {
      const role: any = await ctx.db.get(proposal.author.id as Id<"org_roles">);
      const anchor: any = role?.anchor_id ? await ctx.db.get(role.anchor_id) : null;
      return anchor?.conversation_id ? (await ctx.db.get(anchor.conversation_id)) ?? null : null;
    }
  } catch { /* a gone row is no thread */ }
  return null;
}

async function enrichThread(ctx: Ctx, proposal: ProposalRow): Promise<{ thread: { conversation_id: string; short_id?: string; title?: string } | null; thread_conversation_id?: string }> {
  const conv = await threadOf(ctx, proposal);
  if (!conv) return { thread: null, thread_conversation_id: undefined };
  return { thread: { conversation_id: String(conv._id), short_id: conv.short_id ?? undefined, title: conv.title ?? undefined }, thread_conversation_id: String(conv._id) };
}

// A removed change (S18) is neither to decide nor decided: the page shows
// it struck through, and "N of M decided" shrinks by it.
const countsOf = (all: ChangeRow[]) => ({
  total: all.filter((c) => c.status !== "removed").length,
  decided: all.filter((c) => c.status !== "proposed" && c.status !== "removed").length,
  applied: all.filter((c) => c.status === "applied").length,
  failed: all.filter((c) => c.status === "failed").length,
  skipped: all.filter((c) => c.status === "skipped").length,
});

/** Where a proposal came from (S15), and nothing else: the queue card and
 *  the decision page name the author of a proposal they only link to, and
 *  must not subscribe to its change rows (the first real review had 129) to
 *  do it. Same access rule as the full read; null when unreadable. */
export async function readProposalOrigin(ctx: Ctx, userId: Id<"users">, ref: string): Promise<{ short_id: string; status: string; author: Record<string, unknown> } | null> {
  const proposal = await findProposal(ctx, ref);
  if (!proposal || !(await userCanAccessRole(ctx, userId, hostShape(proposal)))) return null;
  return { short_id: proposal.short_id, status: proposal.status, author: await enrichAuthor(ctx, proposal.author) };
}

export async function listProposals(ctx: Ctx, userId: Id<"users">, args: { team_id?: Id<"teams">; status?: string }): Promise<any[]> {
  const rows: ProposalRow[] = args.team_id
    ? await ctx.db.query("org_proposals").withIndex("by_team", (q: any) => q.eq("team_id", args.team_id)).order("desc").take(PROPOSAL_LIST_CAP * 2)
    : await ctx.db.query("org_proposals").withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId)).order("desc").take(PROPOSAL_LIST_CAP * 2);
  const rank = (s: string) => (s === "open" ? 0 : s === "resolved" ? 1 : 2);
  const kept = rows.filter((p) => !args.status || p.status === args.status).sort((a, b) => rank(a.status) - rank(b.status) || b.created_at - a.created_at).slice(0, PROPOSAL_LIST_CAP);
  const out = [];
  for (const p of kept) {
    const rows = await changesOf(ctx, p._id);
    out.push({ ...p, ...(await enrichSupersession(ctx, p)), ...(await enrichThread(ctx, p)), author: await enrichAuthor(ctx, p.author), asks: resolveOrgAsks(p.asks, rows), link: PROPOSAL_LINK(p.short_id), counts: countsOf(rows) });
  }
  return out;
}

// ── Decide, accept all, withdraw ────────────────────────────────────────────

// A failed change is still open: the person retries it with edits or skips
// it, and the proposal (and its queue card) waits for that. The set is the
// shared contract's, so the web's guards and this file cannot disagree.
const decidable = (c: ChangeRow) => isOrgChangeDecidable(c.status);
async function resolveIfDone(ctx: Ctx, proposal: ProposalRow, now: number): Promise<boolean> {
  const open = (await changesOf(ctx, proposal._id)).some((c) => decidable(c) || c.status === "accepted");
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

/** Merge a person's edits into a change (the shared editedOrgChange: object
 *  valued keys such as caps and scope merge one level deep, so editing one
 *  cap keeps the others) and check the result is still a change. */
export function editedChange(change: OrgChange, edits: unknown): OrgChange {
  if (edits === undefined || edits === null) return change;
  if (typeof edits !== "object" || Array.isArray(edits)) throw new Error("edits is an object patch over the change's own keys");
  const merged = editedOrgChange(change, edits);
  const fault = orgChangeError(merged);
  if (fault) throw new Error(`The edited change is not valid: ${fault}`);
  return merged;
}

// `provision` is a server side option (a created role gets its standing
// session); tests pass false, the mutations never expose it.
async function acceptOne(ctx: Ctx, userId: Id<"users">, proposal: ProposalRow, change: ChangeRow, edits: unknown, now: number, provision = true) {
  const merged = editedChange(change.change, edits);
  await ctx.db.patch(change._id, { status: "accepted", edits: edits ?? undefined, decided_by: userId, decided_at: now });
  // A throw escapes the mutation: Convex then discards every write of this
  // call, the accepted stamp included, so a half applied change never
  // commits and the row stays decidable. Only a refusal the core returns as
  // a value (a handle clash, before any write) lands as `failed`.
  // A role whose proposal also carries its adopt (still open, or accepted in
  // this same pass) is created without a standing session: the adopt seats it.
  let awaitingAdopt: string | undefined;
  if (merged.kind === "role") {
    const handle = merged.handle.trim().replace(/^@/, "").toLowerCase();
    const sibling = (await changesOf(ctx, proposal._id)).find((c) => c.change.kind === "adopt" && c.change.handle.trim().replace(/^@/, "").toLowerCase() === handle && (decidable(c) || c.status === "accepted"));
    if (sibling && sibling.change.kind === "adopt") awaitingAdopt = sibling.change.conversation;
  }
  let result: ApplyResult;
  try {
    result = await applyOrgChange(ctx, userId, boundaryOf(proposal), merged, { provision, human_decision: `proposal:${String(change._id)}`, awaiting_adopt: awaitingAdopt });
  } catch (err) {
    throw new Error(`${proposal.short_id}#${change.seq} (${describeOrgChange(merged)}): ${err instanceof Error ? err.message : String(err)}`);
  }
  const ok = result.status === "applied";
  const note = result.status === "applied" || result.status === "skipped" ? result.note : result.status === "error" ? result.error : "not applied";
  await ctx.db.patch(change._id, { status: ok ? "applied" : "failed", applied_note: note.slice(0, 500), applied_at: now });
  return { change_id: change._id, seq: change.seq, status: ok ? "applied" : "failed", note, role: ok && "role" in result ? result.role : undefined, line: describeOrgChange(merged) };
}

/** Skip one change. Skipping the adopt of a role this proposal created
 *  awaiting it would leave that seat with no standing session for ever, and
 *  only the order of two clicks would decide it. The skip provisions the seat
 *  then, and the note says so; the person who wanted no session retires it. */
async function skipOne(ctx: Ctx, userId: Id<"users">, proposal: ProposalRow, change: ChangeRow, now: number, provision: boolean) {
  let note: string | undefined;
  if (change.change.kind === "adopt") {
    const handle = change.change.handle.trim().replace(/^@/, "").toLowerCase();
    const role = (await rolesInBoundary(ctx, boundaryOf(proposal))).find((r: any) => r.handle === handle);
    if (role && !role.anchor_id && provision) {
      await performProvisionRole(ctx, userId, { role_id: String(role._id) });
      note = `skipped; @${role.handle} was created awaiting this adopt, so a fresh standing session was provisioned for it instead`;
    }
  }
  await ctx.db.patch(change._id, { status: "skipped", decided_by: userId, decided_at: now, ...(note ? { applied_note: note, applied_at: now } : {}) });
  return { change_id: change._id, seq: change.seq, status: "skipped", note, line: describeOrgChange(change.change) };
}

/** A verdict is read against the proposal as the page showed it (`seen`);
 *  one the author revised since is refused whole, and the page shows the
 *  revised list instead (S18). */
function refuseIfRevised(proposal: ProposalRow, rows: ChangeRow[], seen: OrgVerdictSeen | undefined, askSeqs?: number[]): void {
  const fault = orgVerdictSeenFault(proposal.short_id, seen, rows, askSeqs);
  if (fault) throw new Error(fault);
}

export async function performDecideChange(
  ctx: Ctx,
  userId: Id<"users">,
  args: { change_id: string; verdict: "accept" | "skip"; edits?: unknown; seen?: OrgVerdictSeen; from_session?: string; api_token?: string; provision?: boolean },
): Promise<any> {
  await refuseUnlessHumanDecider(ctx, args);
  const found = await findChange(ctx, args.change_id);
  if (!found) throw new Error(`Change not found: ${args.change_id}`);
  const { change, proposal } = found;
  await requireAdmin(ctx, userId, proposal);
  if (proposal.status !== "open") throw new Error(`${proposal.short_id} is ${proposal.status}`);
  if (!decidable(change)) throw new Error(`${proposal.short_id}#${change.seq} is already ${change.status}`);
  // An amend keeps the row's id and replaces what it says (S18), so the id
  // alone does not say which content the person read.
  refuseIfRevised(proposal, await changesOf(ctx, proposal._id), args.seen);
  const now = Date.now();
  const out = args.verdict === "skip"
    ? await skipOne(ctx, userId, proposal, change, now, args.provision ?? true)
    : await acceptOne(ctx, userId, proposal, change, args.edits, now, args.provision ?? true);
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

/**
 * Accept all (S4): every decidable change in apply order, EACH IN ITS OWN
 * SUB-TRANSACTION. One change whose apply throws (a plan the workspace does
 * not have, a role with no standing session, a reports_to nothing answers to)
 * rolls back its own writes only and lands as `failed` with the message; the
 * other changes apply and echo. In one flat transaction the first throw
 * discarded all of them, and 36 accepted cards reverted for one bad row.
 * `ctx.runMutation` is the sub-transaction (Convex rolls a thrown
 * runMutation's writes back); the test harness has no runMutation and runs
 * the change inline, which covers the throws that happen before any write.
 */
export async function performAcceptAll(ctx: Ctx & { runMutation?: (ref: any, args: any) => Promise<any> }, userId: Id<"users">, args: { proposal: string; from_session?: string; api_token?: string; provision?: boolean; kinds?: string[]; seqs?: number[]; seen?: OrgVerdictSeen; tried?: string[]; continuation?: boolean }): Promise<any> {
  // The person's gate runs on the call they made; a continuation is the same
  // act carried on by the server, scheduled only from inside that call.
  if (!args.continuation) await refuseUnlessHumanDecider(ctx, args);
  const proposal = await findProposal(ctx, args.proposal);
  if (!proposal) throw new Error(`Proposal not found: ${args.proposal}`);
  await requireAdmin(ctx, userId, proposal);
  if (proposal.status !== "open") throw new Error(`${proposal.short_id} is ${proposal.status}`);
  const now = Date.now();
  // `kinds` narrows the sweep ("Accept group" on the pane's records card,
  // S9): only decidable changes of those kinds, still in apply order.
  const kinds = args.kinds?.length ? new Set(args.kinds) : null;
  // `seqs` narrows it to one ask (S19): the changes folded inside the card
  // the person accepted, still in apply order.
  const seqs = args.seqs ? new Set(args.seqs) : null;
  const triedSet = new Set(args.tried ?? []);
  const rows = await changesOf(ctx, proposal._id);
  // The person's own call says what it read; a continuation and an ask's
  // accept were checked by the call that started them.
  if (!args.continuation) refuseIfRevised(proposal, rows, args.seen);
  const all = orderForApply(rows.filter(decidable).filter((c) => !kinds || kinds.has(c.change.kind)).filter((c) => !seqs || seqs.has(c.seq)).filter((c) => !triedSet.has(String(c._id))));
  // One call applies one chunk and hands the rest to its own transaction
  // (acceptAllContinue): a hundred records, each plan close cascading over its
  // tasks, do not fit one read and write budget, and a late failure must not
  // cost the earlier applies.
  // Chunk only where a continuation can run; without a scheduler this call is the whole act.
  const pending = (ctx as any).scheduler ? all.slice(0, ACCEPT_ALL_CHUNK) : all;
  const remaining = all.length - pending.length;
  const provision = args.provision ?? true;
  const results = [];
  for (const change of pending) {
    try {
      results.push(ctx.runMutation
        ? await ctx.runMutation(internal.orgProposals.acceptOneInTransaction, { user_id: userId, proposal_id: proposal._id, change_id: change._id, now, provision })
        : await acceptOne(ctx, userId, proposal, change, undefined, now, provision));
    } catch (err) {
      const note = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await ctx.db.patch(change._id, { status: "failed", applied_note: note, applied_at: now, decided_by: userId, decided_at: now });
      results.push({ change_id: change._id, seq: change.seq, status: "failed", note, line: describeOrgChange(change.change) });
    }
  }
  await ctx.db.patch(proposal._id, { updated_at: now });
  // Failed rows stay decidable, so the continuation names what it has already
  // tried: a refusal is reported once, never retried in a loop.
  const tried = [...(args.tried ?? []), ...pending.map((c) => String(c._id))];
  if (remaining > 0 && (ctx as any).scheduler) {
    await (ctx as any).scheduler.runAfter(0, internal.orgProposals.acceptAllContinue, { user_id: userId, proposal_id: proposal._id, kinds: args.kinds, seqs: args.seqs, provision, tried });
  }
  const resolved = await resolveIfDone(ctx, proposal, now);
  return { proposal: proposal.short_id, results, resolved, remaining: (ctx as any).scheduler ? remaining : 0, applied: results.filter((r) => r.status === "applied").length, failed: results.filter((r) => r.status === "failed").length };
}

/**
 * Decide one ask (S19): every undecided change folded inside it. `ask` is the
 * index into the asks the server resolves (stored, else derived), so the page
 * and this call cannot disagree about what an ask holds. Accept is the accept
 * all core narrowed to the ask's seqs: apply order, a sub-transaction per
 * change, the same chunks and continuation. Skip marks each skipped through
 * the skip one change takes. The position is only good against the list the
 * page read, so the call carries what that was (`seen`), and a list the
 * author revised since is refused, never resolved to what sits there now. A change the person already decided inside the
 * fold is left as they decided it.
 */
export async function performDecideAsk(ctx: Ctx & { runMutation?: (ref: any, args: any) => Promise<any> }, userId: Id<"users">, args: { proposal: string; ask: number; verdict: "accept" | "skip"; seen?: OrgVerdictSeen; from_session?: string; api_token?: string; provision?: boolean }): Promise<any> {
  await refuseUnlessHumanDecider(ctx, args);
  const proposal = await findProposal(ctx, args.proposal);
  if (!proposal) throw new Error(`Proposal not found: ${args.proposal}`);
  await requireAdmin(ctx, userId, proposal);
  if (proposal.status !== "open") throw new Error(`${proposal.short_id} is ${proposal.status}`);
  const rows = await changesOf(ctx, proposal._id);
  const asks = resolveOrgAsks(proposal.asks, rows);
  const ask = asks[args.ask];
  // A revise that empties an earlier ask moves every later one up a place,
  // so a position that no longer exists is a moved list before it is a bad
  // index, and the seqs the card held say which ask the person read.
  refuseIfRevised(proposal, rows, args.seen, ask?.seqs ?? []);
  if (!ask) throw new Error(`${proposal.short_id} has ${asks.length} ask${asks.length === 1 ? "" : "s"}; there is no ask ${args.ask}`);
  if (args.verdict === "accept") return { ask: args.ask, title: ask.title, ...(await performAcceptAll(ctx, userId, { proposal: proposal.short_id, seqs: ask.seqs, provision: args.provision, continuation: true })) };
  const now = Date.now();
  const inAsk = new Set(ask.seqs);
  const results = [];
  for (const change of rows.filter(decidable).filter((c) => inAsk.has(c.seq))) results.push(await skipOne(ctx, userId, proposal, change, now, args.provision ?? true));
  await ctx.db.patch(proposal._id, { updated_at: now });
  const resolved = await resolveIfDone(ctx, proposal, now);
  return { ask: args.ask, title: ask.title, proposal: proposal.short_id, results, resolved, remaining: 0, applied: 0, failed: 0, skipped: results.length };
}

/** Changes one accept all call applies before it hands the rest on. */
export const ACCEPT_ALL_CHUNK = 12;

/** The rest of an accept all, in its own transaction (see performAcceptAll). */
export const acceptAllContinue = internalMutation({
  args: { user_id: v.id("users"), proposal_id: v.id("org_proposals"), kinds: v.optional(v.array(v.string())), seqs: v.optional(v.array(v.number())), provision: v.boolean(), tried: v.array(v.string()) },
  handler: async (ctx, args): Promise<any> => {
    const proposal = await ctx.db.get(args.proposal_id);
    if (!proposal || proposal.status !== "open") return null;
    return performAcceptAll(ctx as any, args.user_id, { proposal: proposal.short_id, kinds: args.kinds, seqs: args.seqs, provision: args.provision, tried: args.tried, continuation: true });
  },
});

/** The harness's stand-in for acceptOneInTransaction (no runMutation there). */
export const acceptOneForTest = (ctx: Ctx, userId: Id<"users">, proposal: ProposalRow, change: ChangeRow, now: number, provision: boolean) => acceptOne(ctx, userId, proposal, change, undefined, now, provision);

/** One change of an accept all, as its own transaction (see performAcceptAll). */
export const acceptOneInTransaction = internalMutation({
  args: { user_id: v.id("users"), proposal_id: v.id("org_proposals"), change_id: v.id("org_proposal_changes"), now: v.number(), provision: v.boolean() },
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get(args.proposal_id);
    const change = await ctx.db.get(args.change_id);
    if (!proposal || !change) throw new Error("Change not found");
    return acceptOne(ctx as any, args.user_id, proposal, change, undefined, args.now, args.provision);
  },
});

export async function performWithdrawProposal(ctx: Ctx, userId: Id<"users">, args: { proposal: string; from_session?: string }): Promise<any> {
  const proposal = await findProposal(ctx, args.proposal);
  if (!proposal) throw new Error(`Proposal not found: ${args.proposal}`);
  // A session may withdraw only the proposal it posted itself (the chief of
  // staff taking back its own review); a person decides or withdraws anything
  // else on the org page or at a plain shell. With no session, the author's
  // account or an admin of the boundary may withdraw.
  if (args.from_session) {
    if (!(await callerIsAuthor(ctx, userId, proposal, args.from_session))) throw new Error(`A session may withdraw only the proposal it posted; a person decides or withdraws ${proposal.short_id} on the org page or at a plain shell`);
  } else {
    const isAuthor = String(proposal.created_by) === String(userId);
    if (!isAuthor && !(await userCanAdminRole(ctx, userId, hostShape(proposal)))) throw new Error(`Only ${proposal.short_id}'s author or a team admin can withdraw it`);
  }
  if (proposal.status !== "open") throw new Error(`${proposal.short_id} is already ${proposal.status}`);
  const now = Date.now();
  await ctx.db.patch(proposal._id, { status: "withdrawn", resolved_at: now, updated_at: now });
  await clearDecision(ctx, proposal, now);
  return { proposal: proposal.short_id, status: "withdrawn" };
}

/**
 * Is the caller the proposal's author? From a session: the session that
 * posted it, or the standing session of the role that posted it (the actor
 * a standing session resolves to IS the role). With no session: the person
 * who posted a person's proposal. Withdraw and revise share this one reading.
 */
export async function callerIsAuthor(ctx: Ctx, userId: Id<"users">, proposal: ProposalRow, fromSession: string | undefined): Promise<boolean> {
  if (!fromSession) return proposal.author.kind === "user" && proposal.author.id === String(userId);
  const conversation = await resolveSessionConversation(ctx as any, userId, fromSession);
  if (!conversation) throw new Error("Session not found");
  const actor = await resolveActor(ctx as any, userId, conversation);
  return proposal.author.kind === "session" ? proposal.author.id === String(conversation._id)
    : proposal.author.kind === "role" ? !!(actor.kind === "role" && actor.role && proposal.author.id === String(actor.role._id))
    : false;
}

// ── Revise (S18) ────────────────────────────────────────────────────────────

/**
 * The author removes, amends or adds changes on its own open proposal. That
 * is authoring, never deciding: only a change nobody has decided can be
 * removed or amended, and a decided one is refused by name. Every op is
 * checked before the first write, so a bad list writes nothing. A removed
 * change keeps its row as `removed` (struck through on the page, out of
 * every count); an amend keeps the row and its id, the merged change (the
 * same patch and validator a person's "accept with edits" uses) replaces
 * the old and the stamp keeps it; an add is a new row with the next seq.
 * The proposal's `revisions` journal records each op in order. Removing
 * the last undecided change does not resolve the proposal: resolution is
 * a person's act.
 */
export async function performReviseProposal(ctx: Ctx, userId: Id<"users">, args: { proposal: string; ops: unknown; from_session?: string }): Promise<any> {
  const proposal = await findProposal(ctx, args.proposal);
  if (!proposal) throw new Error(`Proposal not found: ${args.proposal}`);
  if (!(await callerIsAuthor(ctx, userId, proposal, args.from_session))) throw new Error(`Only ${proposal.short_id}'s author may revise it: the session that posted it, or the standing session of the role that posted it`);
  if (proposal.status !== "open") throw new Error(`${proposal.short_id} is ${proposal.status}; only an open proposal can be revised`);
  if (!Array.isArray(args.ops) || !args.ops.length) throw new Error('ops is a non-empty list of { op: "remove" | "amend", seq } or { op: "add", change }');
  const faults = args.ops.map((o, i) => { const f = orgReviseOpError(o); return f ? `ops[${i}]: ${f}` : null; }).filter(Boolean);
  if (faults.length) throw new Error(`The revise ops are not valid:\n- ${faults.join("\n- ")}`);
  const ops = args.ops as OrgReviseOp[];

  const rows = await changesOf(ctx, proposal._id);
  const bySeq = new Map<number, ChangeRow>(rows.map((c) => [c.seq, c]));
  // Strictly after the last revise: a verdict names the revise it read by
  // this stamp, so two revises in one millisecond must not share it.
  const now = Math.max(Date.now(), latestOrgRevisionAt(rows) + 1);
  const by = proposal.author;
  const journal: OrgRevision[] = [];
  const writes: Array<() => Promise<unknown>> = [];
  // One change per subject among the changes still to decide, kept current
  // through the ops (the rule the spec parser applies at create), so an add
  // or an amend cannot put the same act in front of the person twice. A
  // decided row no longer holds its subject: after "trust @growth decide" was
  // skipped, the author may ask again with "trust @growth direct".
  const keys = new Map<string, number>();
  for (const c of rows) if (c.status === "proposed") { const k = orgChangeKey(c.change); if (k) keys.set(k, c.seq); }
  const release = (change: OrgChange, seq: number) => { const k = orgChangeKey(change); if (k && keys.get(k) === seq) keys.delete(k); };
  const claim = (change: OrgChange, seq: number, verb: string) => {
    const k = orgChangeKey(change);
    if (!k) return;
    const other = keys.get(k);
    if (other !== undefined && other !== seq) throw new Error(`${verb}: ${describeOrgChange(change)} repeats #${other}: one change per subject`);
    keys.set(k, seq);
  };
  const undecided = (seq: number, verb: string): ChangeRow => {
    const c = bySeq.get(seq);
    if (!c) throw new Error(`${verb}: ${proposal.short_id}#${seq} does not exist`);
    if (c.status !== "proposed") throw new Error(`${verb}: ${proposal.short_id}#${seq} (${describeOrgChange(c.change)}) is already ${c.status}; a revise never touches a change a person decided`);
    return c;
  };
  let nextSeq = rows.reduce((m, c) => Math.max(m, c.seq), 0) + 1;

  for (const op of ops) {
    if (op.op === "remove") {
      const c = undecided(op.seq, "remove");
      release(c.change, c.seq);
      const line = describeOrgChange(c.change);
      const revision: OrgChangeRevision = { kind: "removed", note: op.note ?? "removed", at: now };
      bySeq.set(c.seq, { ...c, status: "removed", revision });
      journal.push({ op: "removed", seq: c.seq, at: now, by, line, ...(op.note ? { note: op.note } : {}) });
      writes.push(() => ctx.db.patch(c._id, { status: "removed", revision }));
    } else if (op.op === "amend") {
      const c = undecided(op.seq, "amend");
      const merged = editedChange(c.change, op.edits);
      release(c.change, c.seq);
      claim(merged, c.seq, "amend");
      const was = describeOrgChange(c.change);
      const line = describeOrgChange(merged);
      const revision: OrgChangeRevision = { kind: "amended", note: op.note ?? (line === was ? "rationale rewritten" : `was: ${was}`), at: now, before: c.revision?.before ?? c.change };
      const patch = { change: merged, revision, ...(op.rationale ? { rationale: op.rationale } : {}) };
      bySeq.set(c.seq, { ...c, ...patch });
      journal.push({ op: "amended", seq: c.seq, at: now, by, line, was, ...(op.note ? { note: op.note } : {}) });
      writes.push(() => ctx.db.patch(c._id, patch));
    } else {
      const added = normalizeOrgSpecChange(op.change);
      const seq = nextSeq++;
      claim(added.change, seq, "add");
      const line = describeOrgChange(added.change);
      const revision: OrgChangeRevision = { kind: "added", note: op.note ?? "added", at: now };
      const row = { proposal_id: proposal._id, seq, change: added.change, rationale: added.rationale, evidence: added.evidence ?? [], expected_effect: added.expected_effect, risk: added.risk, status: "proposed", revision };
      bySeq.set(seq, row);
      journal.push({ op: "added", seq, at: now, by, line, ...(op.note ? { note: op.note } : {}) });
      writes.push(() => ctx.db.insert("org_proposal_changes", row));
    }
  }
  for (const w of writes) await w();
  await ctx.db.patch(proposal._id, { revisions: [...(proposal.revisions ?? []), ...journal], updated_at: now });
  const after = await changesOf(ctx, proposal._id);
  await refreshDecisionCard(ctx, proposal, after);
  const depends = orgChangeDependencies(after.filter((c) => c.status !== "removed").map((c) => ({ seq: c.seq, change: c.change })));
  return {
    proposal: proposal.short_id,
    status: "open",
    revisions: journal,
    changes: after.map((c) => ({ id: c._id, seq: c.seq, change: c.change, status: c.status, revision: c.revision, line: describeOrgChange(c.change), depends: depends[c.seq] })),
    counts: countsOf(after),
    link: PROPOSAL_LINK(proposal.short_id),
  };
}

/** The queue card names the count and lists the changes; after a revise it
 *  says what the proposal now carries. A card already answered is left. */
async function refreshDecisionCard(ctx: Ctx, proposal: ProposalRow, all: ChangeRow[]): Promise<void> {
  if (!proposal.decision_id) return;
  const d = await ctx.db.get(proposal.decision_id);
  if (d?.status !== "pending") return;
  const live = all.filter((c) => c.status !== "removed");
  const n = live.length;
  const who = String(d.question ?? "").split(" proposes ")[0] || "The author";
  await ctx.db.patch(d._id, {
    question: `${who} proposes ${n} change${n === 1 ? "" : "s"}: ${proposal.title}`,
    context_md: `${proposal.summary_md}\n\n[Open ${proposal.short_id} on the org page](${PROPOSAL_LINK(proposal.short_id)})\n\n${live.map((c) => `- ${describeOrgChange(c.change)}`).join("\n")}`,
  });
}

// ── The thread (S18) ────────────────────────────────────────────────────────

export const PROPOSAL_MESSAGE_TAG = "proposal-message";

/**
 * What a person's words look like when they land in the author's thread:
 * the chat mention's wrapper shape (a tag with the attributes the reader
 * needs, a plain first line naming what this is about, the words, a tail
 * saying how to act), so the agent and the transcript attribute it the
 * same way. The inner text starts with the shared "About op-N change 3"
 * header when a change is named, which the pane parses back.
 */
export function formatProposalMessage(o: { short_id: string; title: string; change: { seq: number; line: string } | null; ask?: { index: number; title: string } | null; from: string; body: string }): string {
  const q = (x: string) => x.replace(/"/g, "'");
  const inner = o.change ? withAboutChange(o.body, o.short_id, o.change.seq, o.change.line) : o.ask ? withAboutAsk(o.body, o.short_id, o.ask.index, o.ask.title) : `About ${o.short_id} ("${q(o.title)}"):\n\n${o.body}`;
  const tail = `(Reply here; the org page shows this thread beside ${o.short_id}. To change the proposal run \`cast org revise ${o.short_id} --remove <n>\`, \`--amend <n> --edits '{...}'\` or \`--add change.json\`. Accepting stays the person's.)`;
  const attrs = `proposal="${o.short_id}"${o.change ? ` change="${o.change.seq}"` : ""}${o.ask ? ` ask="${o.ask.index}"` : ""} from="${q(o.from)}"`;
  return `<${PROPOSAL_MESSAGE_TAG} ${attrs}>\n${inner}\n\n${tail}\n</${PROPOSAL_MESSAGE_TAG}>`;
}

/**
 * A person, reading the proposal on the org page, says something to the
 * agent that wrote it. The words ride the ordinary pending message rail into
 * the bound thread as a turn (the same rail and wrapper shape a chat mention
 * uses), carrying the proposal and the change they were looking at. Refused
 * when the proposal has no thread (a person posted it), when the caller
 * cannot send into that thread, or when the change does not exist.
 */
export async function performSayInThread(ctx: Ctx, userId: Id<"users">, args: { proposal: string; change?: number; ask?: number; body: string; client_id?: string }): Promise<any> {
  const proposal = await findProposal(ctx, args.proposal);
  if (!proposal || !(await userCanAccessRole(ctx, userId, hostShape(proposal)))) throw new Error(`Proposal not found: ${args.proposal}`);
  const body = (args.body ?? "").trim();
  if (!body) throw new Error("Message body is empty");
  const thread = await threadOf(ctx, proposal);
  if (!thread) throw new Error(`${proposal.short_id} was posted by a person, so there is no agent to talk to about it`);
  if (!(await canSendProductMessage(ctx, userId, thread))) throw new Error(`You cannot send into the thread of ${proposal.short_id} (${thread.short_id ?? String(thread._id)})`);
  let change: { seq: number; line: string } | null = null;
  if (args.change !== undefined) {
    const row = (await changesOf(ctx, proposal._id)).find((c) => c.seq === args.change);
    if (!row) throw new Error(`${proposal.short_id}#${args.change} does not exist`);
    change = { seq: row.seq, line: describeOrgChange(row.change) };
  }
  // A reply from an ask's card (S19) names the ask, by the index decideAsk
  // takes, resolved the way the reads resolve it.
  let ask: { index: number; title: string } | null = null;
  if (args.ask !== undefined) {
    const found = resolveOrgAsks(proposal.asks, await changesOf(ctx, proposal._id))[args.ask];
    if (!found) throw new Error(`${proposal.short_id} has no ask ${args.ask}`);
    ask = { index: args.ask, title: found.title };
  }
  const from = (await resolveActor(ctx as any, userId, null)).name ?? "A person";
  const content = formatProposalMessage({ short_id: proposal.short_id, title: proposal.title, change, ask, from, body });
  const message_id = await enqueuePendingMessage(ctx, thread, userId, {
    content,
    client_id: args.client_id ?? `proposal-message:${proposal._id}:${Date.now()}`,
    human: true,
  });
  return { message_id, proposal: proposal.short_id, change: change?.seq, ask: ask?.index, thread: { conversation_id: String(thread._id), short_id: thread.short_id ?? undefined, title: thread.title ?? undefined } };
}

// ── Functions ───────────────────────────────────────────────────────────────

async function requireCaller(ctx: any, apiToken: string | undefined, teamId: Id<"teams"> | undefined): Promise<Id<"users">> {
  const userId = await requireWorkspaceCaller(ctx, apiToken, teamId);
  if (!userId) throw new Error(teamId ? "Not a member of that team" : "Authentication failed: invalid token or session");
  return userId;
}

// ── The breach streak (S2 STABILITY.split_after_breaches) ───────────────────
// One review = one tick. The snapshot is a query (health reads hot tables and
// a query never conflicts); the write is a mutation that touches org_roles
// only. `breaches` on org.health reads the result at the next review.

/** Per role, the streak a review posted now records. Pure over health. */
/** One review window: a streak ticks at most once inside it, so a review
 *  withdrawn and reposted the same day, or two sessions posting in one week,
 *  is still one review. A tick older than two windows is a broken run, and
 *  the streak restarts at 1 rather than counting reviews months apart as
 *  consecutive. */
export const BREACH_WINDOW_MS = STABILITY.move_cooldown_days.value * 86_400_000;

export async function performBreachSnapshot(ctx: any, userId: Id<"users">, teamId: Id<"teams"> | undefined, now: number): Promise<Array<{ role_id: Id<"org_roles">; overload_streak: number }>> {
  const health = await computeOrgHealth(ctx, userId, teamId, now);
  const out: Array<{ role_id: Id<"org_roles">; overload_streak: number }> = [];
  for (const row of health.roles as any[]) {
    const role = await ctx.db.get(row.role_id);
    const earlier = row.breaches ?? 0;
    const at: number | undefined = role?.overload_streak_at;
    if (!row.overloaded_now) { out.push({ role_id: row.role_id, overload_streak: 0 }); continue; }
    if (at !== undefined && earlier > 0 && now - at < BREACH_WINDOW_MS) { out.push({ role_id: row.role_id, overload_streak: earlier }); continue; }
    out.push({ role_id: row.role_id, overload_streak: at !== undefined && now - at > 2 * BREACH_WINDOW_MS ? 1 : earlier + 1 });
  }
  return out;
}

export async function performWriteBreaches(ctx: Ctx, rows: Array<{ role_id: Id<"org_roles">; overload_streak: number }>, now = Date.now()): Promise<number> {
  let written = 0;
  for (const row of rows) {
    const role = await ctx.db.get(row.role_id);
    if (!role || (role.overload_streak ?? 0) === row.overload_streak) continue;
    await ctx.db.patch(row.role_id, { overload_streak: row.overload_streak, overload_streak_at: row.overload_streak > 0 ? now : undefined });
    written++;
  }
  return written;
}

export const breachSnapshot = internalQuery({
  args: { user_id: v.id("users"), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => performBreachSnapshot(ctx, args.user_id, args.team_id, Date.now()),
});

export const writeBreaches = internalMutation({
  args: { rows: v.array(v.object({ role_id: v.id("org_roles"), overload_streak: v.number() })) },
  handler: async (ctx, args) => performWriteBreaches(ctx as any, args.rows),
});

export const recordBreaches = internalAction({
  args: { user_id: v.id("users"), team_id: v.optional(v.id("teams")) },
  // Annotated: an action that calls its own module's functions through
  // `internal` is a circular type without an explicit return.
  handler: async (ctx, args): Promise<number> => {
    const rows: Array<{ role_id: Id<"org_roles">; overload_streak: number }> = await ctx.runQuery(internal.orgProposals.breachSnapshot, args);
    return await ctx.runMutation(internal.orgProposals.writeBreaches, { rows });
  },
});

export const create = mutation({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    from_session: v.optional(v.string()),
    evidence_doc_id: v.optional(v.id("docs")),
    /** "op-N": the proposal this one replaces (S4 supersession). */
    supersedes: v.optional(v.string()),
    title: v.string(),
    summary_md: v.string(),
    mode: v.string(),
    changes: v.array(v.any()),
    /** The asks (S19); the parser checks them as a partition of the changes. */
    asks: v.optional(v.array(v.any())),
  },
  handler: async (ctx, { api_token, team_id, from_session, evidence_doc_id, supersedes, ...spec }) => {
    const userId = await requireCaller(ctx, api_token, team_id);
    return performCreateProposal(ctx, userId, { team_id, spec, from_session, evidence_doc_id, supersedes });
  },
});

export const origin = query({
  args: { api_token: v.optional(v.string()), proposal: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    return userId ? readProposalOrigin(ctx, userId, args.proposal) : null;
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

/** What the page showed when the verdict was pressed (OrgVerdictSeen). */
const verdictSeen = v.optional(v.object({ revised_at: v.number(), seqs: v.optional(v.array(v.number())) }));

export const decide = mutation({
  args: {
    api_token: v.optional(v.string()),
    from_session: v.optional(v.string()),
    change_id: v.string(),
    verdict: v.union(v.literal("accept"), v.literal("skip")),
    edits: v.optional(v.any()),
    seen: verdictSeen,
  },
  handler: async (ctx, { api_token, ...args }) => performDecideChange(ctx, await requireCaller(ctx, api_token, undefined), { ...args, api_token }),
});

export const decideAsk = mutation({
  args: { api_token: v.optional(v.string()), from_session: v.optional(v.string()), proposal: v.string(), ask: v.number(), verdict: v.union(v.literal("accept"), v.literal("skip")), seen: verdictSeen },
  handler: async (ctx, { api_token, ...args }) => performDecideAsk(ctx, await requireCaller(ctx, api_token, undefined), { ...args, api_token }),
});

export const acceptAll = mutation({
  args: { api_token: v.optional(v.string()), from_session: v.optional(v.string()), proposal: v.string(), kinds: v.optional(v.array(v.string())), seen: verdictSeen },
  handler: async (ctx, { api_token, ...args }) => performAcceptAll(ctx, await requireCaller(ctx, api_token, undefined), { ...args, api_token }),
});

/** A one-off stamp for proposals posted before supersession existed (the
 *  analyzer's op-6 replacing op-4 on 2026-09-16): the same two pointers
 *  create writes, with the same workspace check and none of the author
 *  check, because it runs only from `npx convex run` by an operator. */
export const backfillSupersession = internalMutation({
  args: { proposal: v.string(), supersedes: v.string() },
  handler: async (ctx, args) => {
    const newer = await findProposal(ctx, args.proposal);
    const older = await findProposal(ctx, args.supersedes);
    if (!newer || !older) throw new Error("proposal not found");
    if (String(newer.team_id ?? "") !== String(older.team_id ?? "") || String(newer.scope_user_id ?? "") !== String(older.scope_user_id ?? "")) throw new Error("not the same workspace");
    const now = Date.now();
    await ctx.db.patch(newer._id, { supersedes: older._id, updated_at: now });
    await ctx.db.patch(older._id, { superseded_by: newer._id, updated_at: now });
    return { newer: newer.short_id, older: older.short_id };
  },
});

export const withdraw = mutation({
  args: { api_token: v.optional(v.string()), from_session: v.optional(v.string()), proposal: v.string() },
  handler: async (ctx, { api_token, ...args }) => performWithdrawProposal(ctx, await requireCaller(ctx, api_token, undefined), args),
});

/** The author revises its own open proposal (S18): authoring, so no human
 *  gate; the session that posted it or the role's standing session. */
export const revise = mutation({
  args: { api_token: v.optional(v.string()), from_session: v.optional(v.string()), proposal: v.string(), ops: v.array(v.any()) },
  handler: async (ctx, { api_token, ...args }) => performReviseProposal(ctx, await requireCaller(ctx, api_token, undefined), args),
});

/** A person's words into the proposal's thread (S18), naming the change
 *  they were looking at. */
export const say = mutation({
  args: { api_token: v.optional(v.string()), proposal: v.string(), change: v.optional(v.number()), ask: v.optional(v.number()), body: v.string(), client_id: v.optional(v.string()) },
  handler: async (ctx, { api_token, ...args }) => performSayInThread(ctx, await requireCaller(ctx, api_token, undefined), args),
});
