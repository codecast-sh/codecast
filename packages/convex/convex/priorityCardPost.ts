// Posting a priority change card (shared/contracts/priorityCard.ts): behind
// the person's priority_cards experiment, a pass run that proposes merges
// posts them on one silent multi-select decision, in the same write as the
// rest of its changes (priorityPassRun applyPlan). The decision row is the
// proposal's one home (session_decisions.priority_card); answering it is
// lib/priorityCardApply.ts. No Convex functions here.

import type { Doc, Id } from "./_generated/dataModel";
import { changeLine, type PriorityCard, type PriorityWordsRow } from "@codecast/shared/contracts/priorityCard";
import { effectivePriorityOrder } from "@codecast/shared/contracts/priorities";
import { wallClock, wallTimeIn } from "@codecast/shared/time";
import { isClosedSession, isHostedAgentType, isNestedIdentity, isRunLog } from "@codecast/shared/contracts";
import { nextShortId } from "./counters";
import { syncDecisionInbox } from "./lib/decisionInbox";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { activeGroup } from "./lib/priorityGroup";
import { sessionVisibility } from "./lib/prioritySessionVisibility";
import { cardContext, cardQuestion, declinedMerges, dropRepeats, type CardDraft } from "./lib/priorityCardPass";
import { inWorkspace } from "./priorityPassInputs";

type Ctx = { db: any };

/** How many of one person's open decisions are read to find their open cards. */
const OPEN_READ = 1_000;
/** How many of a pair's newest ok runs are read for the cards they posted, and so the merges the person declined (two small index ranges each). */
const DECLINED_RUNS_READ = 1_000;
/** How many of a pair's ok runs are counted for a card's run facts. */
const RUNS_READ = 1_000;
/** How many runs back a card looks for the previous card's run (four small index ranges each); past it, it counts this many. */
const RUNS_SINCE_CARD_READ = 200;
/** How many of the person's newest conversations are read for one in the workspace to ask from. */
const CONVERSATIONS_READ = 100;

const isCardOf = (d: Doc<"session_decisions">, workspace: string) => (d.priority_card as PriorityCard | undefined)?.workspace === workspace;

/** The person's priority cards in this workspace still waiting on an answer, read from their newest open decisions. */
export async function openCards(ctx: Ctx, userId: Id<"users">, workspace: string): Promise<Doc<"session_decisions">[]> {
  const pending: Doc<"session_decisions">[] = await ctx.db.query("session_decisions").withIndex("by_user_status_created", (q: any) => q.eq("user_id", userId).eq("status", "pending")).order("desc").take(OPEN_READ);
  return pending.filter((d) => isCardOf(d, workspace));
}

/**
 * Whether the person answered a priority card of this workspace at or after
 * `since`. A pass run that started before then read the priorities as they
 * were before the answer wrote, so its plan would undo what the person just
 * accepted: applyPlan treats it as superseded, as it does a newer run. One
 * index range: the person's answers since the run started.
 */
export async function cardAnsweredSince(ctx: Ctx, userId: Id<"users">, workspace: string, since: number): Promise<boolean> {
  const answered: Doc<"session_decisions">[] = await ctx.db.query("session_decisions").withIndex("by_user_status_resolved", (q: any) => q.eq("user_id", userId).eq("status", "answered").gte("resolved_at", since)).collect();
  return answered.some((d) => isCardOf(d, workspace));
}

/**
 * The merges the person declined on their priority cards in this workspace
 * (unticked on an answered card, or on a dismissed one): a run never proposes
 * one again, and its prompt says so. A card is posted in its run's own write,
 * so each is found by the run that posted it: the pair's ok runs newest first,
 * and for each, the person's answered and dismissed decisions created within
 * it (two small index ranges), however many other decisions they answered.
 */
export async function declinedMergesFor(ctx: Ctx, userId: Id<"users">, workspace: string): Promise<Array<{ absorbed: string; into: string }>> {
  const runs: Doc<"priority_pass_runs">[] = await ctx.db.query("priority_pass_runs").withIndex("by_user_workspace_status", (q: any) => q.eq("user_id", userId).eq("workspace", workspace).eq("status", "ok")).order("desc").take(DECLINED_RUNS_READ);
  const cards: Array<{ status: string; card: PriorityCard }> = [];
  for (const r of runs) {
    for (const status of ["answered", "dismissed"] as const) {
      const rows: Doc<"session_decisions">[] = await ctx.db.query("session_decisions")
        .withIndex("by_user_status_created", (q: any) => q.eq("user_id", userId).eq("status", status).gte("created_at", r.started_at).lte("created_at", r.finished_at))
        .collect();
      for (const d of rows) if (isCardOf(d, workspace) && (d.priority_card as PriorityCard).run_id === String(r._id)) cards.push({ status, card: d.priority_card as PriorityCard });
    }
  }
  return declinedMerges(cards);
}


/**
 * How many of `runs` (the pair's ok runs, newest first, this one first) came
 * after the previous card's run, this one included. A card is posted in its
 * run's own write, so its created_at lies within that run's started_at and
 * finished_at: each earlier run is checked by one small index range per
 * status, newest first, however many other decisions the person answered
 * between cards. No card among them: every run counts.
 */
async function runsSinceLastCard(ctx: Ctx, userId: Id<"users">, workspace: string, runs: Doc<"priority_pass_runs">[]): Promise<number> {
  for (let i = 1; i < Math.min(runs.length, RUNS_SINCE_CARD_READ); i++) {
    const r = runs[i];
    for (const status of ["pending", "answered", "dismissed", "withdrawn"]) {
      const posted: Doc<"session_decisions">[] = await ctx.db.query("session_decisions")
        .withIndex("by_user_status_created", (q: any) => q.eq("user_id", userId).eq("status", status).gte("created_at", r.started_at).lte("created_at", r.finished_at))
        .collect();
      if (posted.some((d) => isCardOf(d, workspace) && (d.priority_card as PriorityCard).run_id === String(r._id))) return i;
    }
  }
  return Math.min(runs.length, RUNS_SINCE_CARD_READ);
}

/** Midnight today on the person's clock (users.timezone), else UTC's. */
function startOfToday(now: number, timeZone: string | undefined): number {
  try {
    const w = wallClock(now, timeZone ?? "UTC");
    return wallTimeIn(Date.UTC(w.year, w.month - 1, w.day), timeZone ?? "UTC");
  } catch {
    return now - (now % 86_400_000);
  }
}

/**
 * The session the card sits in: the person's own most recently active one in
 * the workspace, else one the run read (theirs, in the workspace, by how
 * passInputs read them). Never another person's (a team agent's session is
 * its teammates' to read too), and never one whose decisions draw as
 * something else or reach nobody: a hosted assistant's (its asks are
 * approvals, and a dismissal wakes it), a run's own (its log, or a station
 * or subagent nested under another session), or a killed or closed one. A
 * session the person launched a run from keeps that run's pointer
 * (workflow_run_id) but stays theirs, so it qualifies. The card is not that
 * session's question: it lifts nothing and its agent neither lists nor takes it back.
 */
async function askingConversation(ctx: Ctx, userId: Id<"users">, workspace: string, read: Record<string, Id<"conversations">> = {}): Promise<Doc<"conversations"> | null> {
  const vis = sessionVisibility(ctx);
  const fits = async (c: Doc<"conversations"> | null): Promise<boolean> =>
    !!c && !isHostedAgentType(c.agent_type) && !isRunLog(c) && !isNestedIdentity(c) && !c.inbox_killed_at && !isClosedSession(c) && (await inWorkspace(vis, c, userId, workspace));
  const recent: Doc<"conversations">[] = await ctx.db.query("conversations").withIndex("by_user_updated", (q: any) => q.eq("user_id", userId)).order("desc").take(CONVERSATIONS_READ);
  for (const c of recent) if (await fits(c)) return c;
  for (const id of Object.values(read)) {
    const c: Doc<"conversations"> | null = await ctx.db.get(id);
    if (await fits(c)) return c;
  }
  return null;
}

export type PostedCard = { posted: Id<"session_decisions"> } | { skipped: string } | null;

/**
 * Posts the run's card, once its direct changes are written and its run row
 * settled ok (`run_id`). Changes an open card of the person's already
 * proposes are left off; a card left with none is not posted (null). With no
 * session in the workspace to ask from, the changes stay unwritten and the
 * reason comes back for the run's record. `open` is the person's open cards
 * here (openCards).
 * The card holds only merges (sd-5035): the run wrote everything else. A
 * merge into a priority the run would create names it by its plan ref
 * ("new-1"), and the card holds that create until the merge is accepted.
 */
export async function postPriorityCard(
  ctx: Ctx,
  run: { user_id: Id<"users">; workspace: string; run_id: Id<"priority_pass_runs">; cost_usd?: number; from: number; to: number; conversations?: Record<string, Id<"conversations">> },
  raw: CardDraft,
  now: number,
  open: ReadonlyArray<Doc<"session_decisions">>,
): Promise<PostedCard> {
  const order = effectivePriorityOrder(await activeGroup(ctx, run.user_id, run.workspace));
  const rankOf = new Map(order.map((p, i) => [p.short_id, i + 1]));
  // Each survivor as it stands once the run wrote (it may have renamed or moved it); a new one, as the run would make it.
  const groups = [];
  for (const g of raw.groups) {
    const p: Doc<"priorities"> | null = await ctx.db.query("priorities").withIndex("by_short_id", (q: any) => q.eq("short_id", g.priority)).first();
    groups.push(p && String(p.user_id) === String(run.user_id) && p.workspace === run.workspace ? { ...g, title: p.title, rank: rankOf.get(p.short_id) ?? null } : g);
  }
  const draft = dropRepeats({ ...raw, groups }, open.map((d) => d.priority_card as PriorityCard));
  if (!draft.changes.length) return null;
  const asker = await askingConversation(ctx, run.user_id, run.workspace, run.conversations);
  if (!asker) return { skipped: `card not posted: no session in this workspace to ask from (${draft.changes.length} changes left unwritten)` };

  // Run facts: the runs that wrote a plan, today and since the last card's.
  const person: Doc<"users"> | null = await ctx.db.get(run.user_id);
  const okRuns: Doc<"priority_pass_runs">[] = await ctx.db.query("priority_pass_runs").withIndex("by_user_workspace_status", (q: any) => q.eq("user_id", run.user_id).eq("workspace", run.workspace).eq("status", "ok")).order("desc").take(RUNS_READ);
  const today = startOfToday(now, person?.timezone);
  const thisRun = okRuns.find((r) => String(r._id) === String(run.run_id));
  const runsNewestFirst = [...(thisRun ? [thisRun] : []), ...okRuns.filter((r) => r !== thisRun).sort((a, b) => b.started_at - a.started_at)];
  const sinceLastCard = await runsSinceLastCard(ctx, run.user_id, run.workspace, runsNewestFirst);

  // Where the person's words went: by the priority each session sits on now, ranked as the priorities stand now.
  const total = draft.typed.reduce((sum, t) => sum + t.chars, 0);
  const words: PriorityWordsRow[] = [];
  for (const t of total ? draft.typed : []) {
    const p: Doc<"priorities"> | null = t.priority ? await ctx.db.query("priorities").withIndex("by_short_id", (q: any) => q.eq("short_id", t.priority)).first() : null;
    const mine = p && String(p.user_id) === String(run.user_id) && p.workspace === run.workspace ? p : null;
    words.push({ priority: mine?.short_id ?? null, rank: mine ? rankOf.get(mine.short_id) ?? null : null, title: mine?.title ?? "Not on a priority", share: t.chars / total });
  }
  words.sort((a, b) => b.share - a.share);

  // The sessions the card may still place, with the conversations the run read them as.
  const conversations = Object.fromEntries(draft.held.sessions.flatMap((s) => (run.conversations?.[s.session] ? [[s.session, run.conversations[s.session]]] : [])));
  const window = { from: run.from, to: run.to };
  const card: PriorityCard = {
    v: 1,
    workspace: run.workspace,
    run_id: String(run.run_id),
    run: {
      at: now,
      window,
      sessions: draft.sessions,
      calls: draft.calls,
      cost_usd: run.cost_usd ?? 0,
      runs_since_last_card: sinceLastCard,
      runs_today: okRuns.filter((r) => r.started_at >= today).length,
    },
    groups: draft.groups,
    changes: draft.changes,
    words,
    suggested: draft.changes.map((c) => c.id),
    held: { ...draft.held, conversations },
  };

  const titleOf = (priority: string) => draft.groups.find((g) => g.priority === priority)?.title ?? priority;
  const ws = parseWorkspaceKey(run.workspace);
  const short_id = await nextShortId(ctx.db, "sd");
  const id: Id<"session_decisions"> = await ctx.db.insert("session_decisions", {
    conversation_id: asker._id,
    session_id: asker.session_id,
    user_id: run.user_id,
    short_id,
    question: cardQuestion(draft.changes, titleOf),
    context_md: cardContext({ ...draft, window }),
    kind: "multi",
    category: "unknown",
    options: draft.changes.map((c) => ({ label: changeLine(c, titleOf), ...(c.kind === "new_priority" ? {} : { description: titleOf(c.priority) }) })),
    // Blocking puts it in the person's queue (isStackedAsk), where an advisory ask never shows; silent keeps it from
    // ringing a phone (ringsPhone) or delivering anything into the session it hangs on, and it never lifts that
    // session as asking (liftsAskingSession).
    blocking: true,
    silent: true,
    status: "pending",
    holder: { kind: "user", id: String(run.user_id) },
    holder_key: `user:${run.user_id}`,
    asked_user_ids: [run.user_id],
    hops: [],
    ...(ws?.type === "team" ? { team_id: ws.teamId } : {}),
    created_at: now,
    session_title: asker.title,
    priority_card: card,
  });
  await syncDecisionInbox(ctx, id, [run.user_id], now);
  return { posted: id };
}
