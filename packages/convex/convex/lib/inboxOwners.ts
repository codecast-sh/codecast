// The inbox's read of the owners model (team feature session_owners, shared
// contracts/sessionOwners). A conversation the model applies to (convex
// sessionOwners ownersModelOn: its team's flag, or for a personal session any
// team of the account that runs it) gets the fields every inbox reader
// places by: owners_model (the marker, shared underOwnersModel), its implicit
// starter and the session that owns it. A conversation the model does not
// apply to is left exactly as it was.
//
// A row carries no owner list. The scan reads this for every row of every
// execution, so it reads no session_owners rows at all: owner_user_id caches
// the primary owner exactly while rows exist (syncPrimaryOwnerCache), which is
// all the implicit starter rule needs, and whether the viewer owns it is one
// point lookup of their own row (stampInboxViewerFields' owned_by_me). Who
// hears a wait reads the full owner rows, off the hot path.
import type { Id } from "../_generated/dataModel";
import { ownersOf, waitAudience, type SessionOwnerFacts, type WaitAudience } from "@codecast/shared/contracts/sessionOwners";
import { buildLadder, workspaceAdmins } from "./roleLadder";
import { checkConversationAccess } from "../privacy";
import { internal } from "../_generated/api";
import { waitReachedPeople, workspaceFeatureEnabled } from "@codecast/shared/contracts";
import { deadParentAt, humanStarterUser, ownersModelOn, sessionOwnerFactsOf } from "../sessionOwners";

export type InboxOwnerFields = { owners_model: true; implicit_owner: string | null; owner_session_id: string | null };

type Memo = {
  get: (id: any) => Promise<any>;
  teams: Map<string, Promise<boolean>>;
  memberships: Map<string, Promise<any[]>>;
  fields: Map<string, Promise<InboxOwnerFields | null>>;
};
const memos = new WeakMap<object, Memo>();

function memoOf(ctx: { db: any }): Memo {
  let m = memos.get(ctx);
  if (!m) {
    const docs = new Map<string, Promise<any>>();
    m = {
      get: (id: any) => {
        const key = String(id);
        let hit = docs.get(key);
        if (!hit) docs.set(key, (hit = Promise.resolve(ctx.db.get(id)).catch(() => null)));
        return hit;
      },
      teams: new Map(),
      memberships: new Map(),
      fields: new Map(),
    };
    memos.set(ctx, m);
  }
  return m;
}

/** The memoized db.get the owners read uses for one call (one ctx): an
 *  inbox recompute reads its per-row references through it too, so a doc is
 *  read once whichever asked first. Queries only: it never sees a write. */
export function inboxMemoGet(ctx: { db: any }): (id: any) => Promise<any> {
  return memoOf(ctx).get;
}

/** A user's team memberships, read once per call: the scan's team window
 *  (teamOwnerRowsForUser) and the personal owners check share the one read. */
export function userMembershipsMemo(ctx: { db: any }, userId: Id<"users">): Promise<any[]> {
  const m = memoOf(ctx);
  let hit = m.memberships.get(String(userId));
  if (!hit) {
    hit = ctx.db.query("team_memberships").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect() as Promise<any[]>;
    m.memberships.set(String(userId), hit);
  }
  return hit;
}

/** ownersModelOn for a conversation, read once per team (or per runner, for
 *  a personal session: workspaceHasFeature's personal rule over the
 *  memoized memberships) per call. */
export function ownersModelOnMemo(ctx: { db: any }, conv: { team_id?: Id<"teams">; user_id?: Id<"users"> }): Promise<boolean> {
  const m = memoOf(ctx);
  const key = conv.team_id ? `team:${conv.team_id}` : `user:${conv.user_id}`;
  let hit = m.teams.get(key);
  if (!hit) m.teams.set(key, (hit = conv.team_id || !conv.user_id
    ? ownersModelOn(ctx, { team_id: conv.team_id, user_id: conv.user_id })
    : userMembershipsMemo(ctx, conv.user_id)
      .then((ms) => Promise.all(ms.map((x: any) => m.get(x.team_id))))
      .then((teams) => workspaceFeatureEnabled(teams, null, "session_owners"))));
  return hit;
}

/** The owner fields of a conversation under the model, else null: the
 *  shared rule over what the row itself says (whether owner rows exist, its
 *  role, its parent link and the human who started it), with no owner read. */
export function inboxOwnersOf(ctx: { db: any }, conv: any): Promise<InboxOwnerFields | null> {
  const m = memoOf(ctx);
  const key = String(conv._id);
  let hit = m.fields.get(key);
  if (!hit) {
    hit = (async () => {
      if (!(await ownersModelOnMemo(ctx, conv))) return null;
      const starter = await humanStarterUser({ db: { get: m.get } }, conv);
      const o = ownersOf({
        // Some person owns it exactly while owner_user_id is set; who does is
        // the owners read's to say.
        rows: conv.owner_user_id ? [{ user_id: String(conv.owner_user_id), added_at: 0 }] : [],
        starter: starter ? String(starter._id) : null,
        user_id: conv.user_id,
        org_role_id: conv.org_role_id,
        parent_conversation_id: conv.parent_conversation_id,
        // A deleted or killed parent no longer owns it (sessionOwnerFactsOf's rule).
        parent_released_at: conv.parent_released_at ?? await deadParentAt({ db: { get: m.get } }, conv),
        role_started: conv.role_started ?? null,
      });
      return { owners_model: true as const, implicit_owner: o.implicitStarter, owner_session_id: o.parentSession };
    })();
    m.fields.set(key, hit);
  }
  return hit;
}

/** The conversation with its owner fields laid on when the model applies, so
 *  the shared membership and placement (which read the row) see them; the
 *  same doc when it does not. */
export async function withInboxOwners<T extends { _id: any }>(ctx: { db: any }, conv: T): Promise<T> {
  const fields = await inboxOwnersOf(ctx, conv);
  return fields ? { ...conv, ...fields } : conv;
}

/** The agent accounts among these people (never anyone's audience). */
export async function botsAmong(ctx: { db: any }, ids: ReadonlyArray<string>): Promise<string[]> {
  const m = memoOf(ctx);
  const docs = await Promise.all(ids.map((id) => m.get(id)));
  return ids.filter((_, i) => !!docs[i]?.is_bot);
}

/** The person can open the session (checkConversationAccess, the
 *  conversation page's own rule): the only people a wait may reach. */
async function canOpen(ctx: { db: any }, userId: string, conv: any): Promise<boolean> {
  return (await checkConversationAccess(ctx, userId as Id<"users">, conv)) !== "denied";
}

/** The person a wait reaches when nobody owns the session and no human
 *  started it: where its role's line ends, else a workspace admin, else the
 *  account that runs it when a person does. Only someone who can open the
 *  session, and never one of `exclude` (agent accounts, people who left its
 *  team). */
export async function fallbackPersonFor(ctx: { db: any }, conv: any, exclude: ReadonlyArray<string> = []): Promise<string | null> {
  const out = new Set(exclude.map(String));
  const m = memoOf(ctx);
  const reaches = async (id: unknown) => !!id && !out.has(String(id)) && (await canOpen(ctx, String(id), conv));
  const role = conv.org_role_id ? await m.get(conv.org_role_id) : null;
  const ladder = role ? await buildLadder({ db: { get: m.get } }, role, Date.now()) : null;
  if (await reaches(ladder?.firstPersonId)) return String(ladder!.firstPersonId);
  for (const admin of await workspaceAdmins(ctx, conv.team_id)) if (await reaches(admin)) return String(admin);
  const runner = await m.get(conv.user_id);
  return runner && !runner.is_bot && !out.has(String(conv.user_id)) ? String(conv.user_id) : null;
}

/** The shared waitAudience for a conversation under the model, else null:
 *  its full owner rows, agent accounts never hearing it, nobody who cannot
 *  open the session, and the fallback person resolved only when the rule
 *  gets that far. An owner row grants access, and so does running it; a
 *  starter who is neither (its author, before a move) is checked. */
export async function waitAudienceOf(ctx: { db: any }, conv: any, opts: { agentReachable: boolean; exclude?: ReadonlyArray<string> }): Promise<WaitAudience | null> {
  if (!(await ownersModelOnMemo(ctx, conv))) return null;
  const facts: SessionOwnerFacts = await sessionOwnerFactsOf(ctx, conv);
  const owners = new Set(facts.rows.map((r) => String(r.user_id)));
  const starterShut = !!facts.starter && facts.starter !== String(conv.user_id) && !owners.has(facts.starter) && !(await canOpen(ctx, facts.starter, conv));
  const exclude = [...(opts.exclude ?? []).map(String), ...(await botsAmong(ctx, [...owners])), ...(starterShut ? [facts.starter!] : [])];
  const first = waitAudience(facts, { agentReachable: opts.agentReachable, fallbackPerson: null, exclude });
  if (first.agent || first.people.length) return first;
  return waitAudience(facts, { agentReachable: opts.agentReachable, fallbackPerson: await fallbackPersonFor(ctx, conv, exclude), exclude });
}

/** A child no inbox window seats for its person, so its waits escalate
 *  (wait_up_person) and the escalated window lists it:
 *  - its parent died (killed or deleted) and the release is not written yet
 *    (notifications.releaseDeadParentChildren writes it);
 *  - a released subagent its runner did not start (one moved to another
 *    account): the nested seat is its runner's, and the runner is not who
 *    owns it. */
export async function unseatedChild(ctx: { db: any }, conv: any): Promise<boolean> {
  if (conv.parent_released_at == null) return (await deadParentAt(ctx, conv)) != null;
  if (conv.is_subagent !== true) return false;
  const owners = await inboxOwnersOf(ctx, conv);
  return !!owners?.implicit_owner && owners.implicit_owner !== String(conv.user_id);
}

/** The wait reaches its people (waitAudienceOf, never one of `exclude`):
 *  stamped on the row, so the inbox lists it for them in Needs You, and on
 *  `conv` in memory, for the push that follows. The stamped person is the
 *  one no other window lists: the audience's fallback, or the person of a
 *  child no window seats (unseatedChild). */
export async function escalateWait(ctx: { db: any }, conv: any, opts: { now?: number; exclude?: ReadonlyArray<string> } = {}): Promise<WaitAudience | null> {
  const audience = await waitAudienceOf(ctx, conv, { agentReachable: false, exclude: opts.exclude });
  const person = audience?.person ?? (audience?.people.length === 1 && await unseatedChild(ctx, conv) ? audience.people[0] : null);
  // The episode key stays: it is stamped only when this episode's people
  // were rung, and a wait its agent owner answered rang nobody, so the check
  // that follows rings them once and stamps it.
  const stamp = { wait_up_at: opts.now ?? Date.now(), wait_up_count: conv.message_count ?? 0, wait_up_person: (person ?? undefined) as Id<"users"> | undefined };
  await ctx.db.patch(conv._id, stamp);
  Object.assign(conv, stamp);
  return audience;
}

/** A standing escalation whose person can no longer open the session (its
 *  visibility changed, or they left: `exclude`) goes on to whom its audience
 *  names now, never back to them, and the needs-input check rings that
 *  person: their push is a new episode. False when the person still can,
 *  and always off the model. */
export async function rerouteEscalatedWait(ctx: { db: any; scheduler?: any }, conv: any, opts: { exclude?: ReadonlyArray<string> } = {}): Promise<boolean> {
  if (!conv.wait_up_person || !waitReachedPeople(conv)) return false;
  // Off the model a stamp left from before the flag went off means nothing:
  // the main rule decides who hears its waits, and the key is main's.
  if (!(await ownersModelOnMemo(ctx, conv))) return false;
  const person = String(conv.wait_up_person);
  const gone = (opts.exclude ?? []).map(String);
  if (!gone.includes(person) && (await canOpen(ctx, person, conv))) return false;
  await escalateWait(ctx, conv, { exclude: [...new Set([person, ...gone])] });
  // The person who was rung is gone; the episode's new people were not.
  await ctx.db.patch(conv._id, { needs_input_notified_key: undefined });
  conv.needs_input_notified_key = undefined;
  if (ctx.scheduler) await ctx.scheduler.runAfter(0, internal.notifications.checkNeedsInput, { conversation_id: conv._id });
  return true;
}

/** A session handed to a new agent owner (an adopt, or its undo): the wait
 *  it stands in was settled for the owners it had. Its escalation and the old
 *  parent's ask (hand_wake_notified_key) come off, and the needs-input check
 *  runs again, so the new owner hears it, or its people do when it cannot.
 *  The episode key stays: the agent path never reads it, and a wait that
 *  already rang its people does not ring them again (the check's `dup`). */
export async function rehandWait(ctx: { db: any; scheduler?: any }, conv: any): Promise<void> {
  const stale = ["wait_up_at", "wait_up_count", "wait_up_person", "hand_wake_notified_key"].filter((k) => conv[k] !== undefined);
  if (stale.length) {
    await ctx.db.patch(conv._id, Object.fromEntries(stale.map((k) => [k, undefined])));
    for (const k of stale) conv[k] = undefined;
  }
  if (ctx.scheduler) await ctx.scheduler.runAfter(0, internal.notifications.checkNeedsInput, { conversation_id: conv._id });
}
