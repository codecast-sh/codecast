// Posting a priority change card (shared/contracts/priorityCard.ts): behind
// the person's priority_cards experiment, a pass run that proposes changes
// posts them on one silent multi-select decision, in the same write as its
// direct changes (priorityPassRun applyPlan). The decision row is the
// proposal's one home (session_decisions.priority_card); answering it is
// lib/priorityCardApply.ts. No Convex functions here.

import type { Doc, Id } from "./_generated/dataModel";
import { changeLine, type PriorityCard, type PriorityWordsRow } from "@codecast/shared/contracts/priorityCard";
import { effectivePriorityOrder } from "@codecast/shared/contracts/priorities";
import { wallClock, wallTimeIn } from "@codecast/shared/time";
import { nextShortId } from "./counters";
import { syncDecisionInbox } from "./lib/decisionInbox";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { activeGroup } from "./lib/priorityGroup";
import { sessionVisibility } from "./lib/prioritySessionVisibility";
import { cardContext, cardQuestion, dropRepeats, type CardDraft } from "./lib/priorityCardPass";
import { inWorkspace } from "./priorityPassInputs";

type Ctx = { db: any };

/** How many of one person's decisions per status are read to find their cards, newest first. */
const CARD_SCAN = 200;
/** How many of a pair's ok runs are counted for a card's run facts. */
const RUNS_READ = 1_000;
/** How many of the person's newest conversations are read for one in the workspace to ask from. */
const CONVERSATIONS_READ = 100;

const isCardOf = (d: Doc<"session_decisions">, workspace: string) => (d.priority_card as PriorityCard | undefined)?.workspace === workspace;

/** The person's priority cards in this workspace still waiting on an answer. */
export async function openCards(ctx: Ctx, userId: Id<"users">, workspace: string): Promise<Doc<"session_decisions">[]> {
  const pending: Doc<"session_decisions">[] = await ctx.db.query("session_decisions").withIndex("by_user_status", (q: any) => q.eq("user_id", userId).eq("status", "pending")).take(CARD_SCAN * 5);
  return pending.filter((d) => isCardOf(d, workspace));
}

/** The person's newest priority card in this workspace, answered or not. */
async function lastCard(ctx: Ctx, userId: Id<"users">, workspace: string): Promise<Doc<"session_decisions"> | null> {
  let best: Doc<"session_decisions"> | null = null;
  for (const status of ["pending", "answered", "dismissed", "withdrawn"]) {
    const rows: Doc<"session_decisions">[] = await ctx.db.query("session_decisions").withIndex("by_user_status_created", (q: any) => q.eq("user_id", userId).eq("status", status)).order("desc").take(CARD_SCAN);
    const hit = rows.find((d) => isCardOf(d, workspace));
    if (hit && (!best || hit.created_at > best.created_at)) best = hit;
  }
  return best;
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

/** The session the card is asked from: the workspace's agent's, else the person's most recently active one in the workspace. */
async function askingConversation(ctx: Ctx, userId: Id<"users">, workspace: string): Promise<Doc<"conversations"> | null> {
  const ws = parseWorkspaceKey(workspace);
  const anchors: Doc<"anchors">[] = ws?.type === "team"
    ? await ctx.db.query("anchors").withIndex("by_team", (q: any) => q.eq("team_id", ws.teamId)).take(50)
    : await ctx.db.query("anchors").withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId)).take(50);
  const anchor = anchors.find((a) => !a.org_role_id && a.status !== "decommissioned" && a.conversation_id);
  const anchored: Doc<"conversations"> | null = anchor ? await ctx.db.get(anchor.conversation_id!) : null;
  if (anchored) return anchored;
  const vis = sessionVisibility(ctx);
  const recent: Doc<"conversations">[] = await ctx.db.query("conversations").withIndex("by_user_updated", (q: any) => q.eq("user_id", userId)).order("desc").take(CONVERSATIONS_READ);
  for (const c of recent) if (await inWorkspace(vis, c, userId, workspace)) return c;
  return null;
}

export type PostedCard = { posted: Id<"session_decisions"> } | { skipped: string } | null;

/**
 * Posts the run's card, once its direct changes are written and its run row
 * settled ok (`run_id`). Changes an open card of the person's already
 * proposes are left off; a card left with none is not posted (null). With no
 * session in the workspace to ask from, the changes stay unwritten and the
 * reason comes back for the run's record.
 */
export async function postPriorityCard(
  ctx: Ctx,
  run: { user_id: Id<"users">; workspace: string; run_id: Id<"priority_pass_runs">; cost_usd?: number; from: number; to: number; conversations?: Record<string, Id<"conversations">> },
  raw: CardDraft,
  now: number,
): Promise<PostedCard> {
  const open = await openCards(ctx, run.user_id, run.workspace);
  const draft = dropRepeats(raw, open.map((d) => d.priority_card as PriorityCard));
  if (!draft.changes.length) return null;
  const asker = await askingConversation(ctx, run.user_id, run.workspace);
  if (!asker) return { skipped: `card not posted: no session in this workspace to ask from (${draft.changes.length} changes left unwritten)` };

  // Run facts: the runs that wrote a plan, today and since the last card's.
  const person: Doc<"users"> | null = await ctx.db.get(run.user_id);
  const okRuns: Doc<"priority_pass_runs">[] = await ctx.db.query("priority_pass_runs").withIndex("by_user_workspace_status", (q: any) => q.eq("user_id", run.user_id).eq("workspace", run.workspace).eq("status", "ok")).order("desc").take(RUNS_READ);
  const today = startOfToday(now, person?.timezone);
  const previous = await lastCard(ctx, run.user_id, run.workspace);
  const previousRun: Doc<"priority_pass_runs"> | null = previous ? await ctx.db.get((previous.priority_card as PriorityCard).run_id as Id<"priority_pass_runs">) : null;
  const since = previousRun?.started_at ?? -Infinity;

  // Where the person's words went: by the priority each session sits on now, ranked as the priorities stand now.
  const order = effectivePriorityOrder(await activeGroup(ctx, run.user_id, run.workspace));
  const rankOf = new Map(order.map((p, i) => [p.short_id, i + 1]));
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
      runs_since_last_card: okRuns.filter((r) => r.started_at > since).length,
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
    question: cardQuestion(window),
    context_md: cardContext(draft.changes.length, draft),
    kind: "multi",
    category: "unknown",
    options: draft.changes.map((c) => ({ label: changeLine(c, titleOf), ...(c.kind === "new_priority" ? {} : { description: titleOf(c.priority) }) })),
    // Blocking puts it in the person's queue (isStackedAsk), where an advisory ask never shows; silent keeps it from
    // ringing a phone (ringsPhone) or delivering anything into the session it hangs on. The approval cards do the same.
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
