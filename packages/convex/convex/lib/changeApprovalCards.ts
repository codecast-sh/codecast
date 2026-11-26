// The person codecast's approval status waits on, and the one approval card it posts them (ct-100350 items 5, 6, 8).
// Cards go to a person, never a role:
//   judged files   the person whose Ship press did not list them; else the work's Requested-by person, else the
//                  session's owner; else the area's owner by main's owners file (judgedDiff parseOwners); else the
//                  pull request's author.
//   a mechanism    the presser when main's engineers file lists them; else the area's owner; else the author.
//   no run         codecast's automatic review read it (changeApprovals.ts): judged files, a mechanism, an objection
//                  (changes or rejected) or no answer at all go to the area's owner, never a commit's Requested-by;
//                  a run that ended with no mechanism answer: whoever a mechanism goes to.
//   the area       the owners file's person for it (an id this deployment does not know is no owner); else the pull
//                  request's author when they are a person on the team; else the workspace's admins; else whoever
//                  installed codecast's app. On a pull request no run is behind, the author is asked nothing, whatever
//                  the question: an owner who is the author is no owner, and admins and the installer count without
//                  them. A card always lands: with no session to ask from, it is asked from its person's own, else they
//                  are notified.
//   Cam's changes  the engineer whose yes came before the build; else the area's owner, else the first engineer;
//                  never Cam.
// A review that gave no mechanism answer is asked again, never carded. One card per judged diff and question, and at
// most one open per pull request: a card whose diff or question no longer stands is withdrawn.
// Approval cards count against no open-card cap: codecast has none per person (a role's caps.cards counts runs).
import type { Doc, Id } from "../_generated/dataModel";
import { nextShortId } from "../counters";
import { syncDecisionInbox } from "./decisionInbox";
import { enqueuePendingMessage } from "../pendingMessages";
import { findConversationByAnyRef } from "../conversationSessionLookup";
import { isCam } from "./changeApprovalRows";
import { withdrawCore } from "../sessionDecisions";
import { emitNotification } from "../notificationRouter";

export type CardReason = "judged" | "mechanism" | "review" | "unreadable" | "objection";
/** `also`: others asked the same card beside the holder (a workspace's admins, when no one person owns the area). */
export type Person = { user_id: Id<"users"> | null; name: string; also?: Id<"users">[] };

const firstName = (name: string | null | undefined) => String(name ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
const nameOfUser = (u: any): string => u?.name || u?.github_username || u?.email?.split("@")[0] || "a person";

async function personOf(ctx: { db: any }, userId: Id<"users"> | string | null | undefined): Promise<Person | null> {
  // A user id read from a file may be no id at all here: get() would throw on it.
  const id = userId ? ctx.db.normalizeId("users", String(userId)) : null;
  const u: any = id ? await ctx.db.get(id) : null;
  return u ? { user_id: u._id, name: nameOfUser(u) } : null;
}

/** A member of the team by first name (Requested-by names people that way). */
async function memberNamed(ctx: { db: any }, teamId: Id<"teams"> | undefined, name: string | null | undefined): Promise<Person | null> {
  const want = firstName(name);
  if (!teamId || !want) return null;
  const memberships: any[] = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect();
  for (const m of memberships) {
    const u: any = await ctx.db.get(m.user_id);
    if (u && !u.is_bot && firstName(u.name) === want) return { user_id: u._id, name: nameOfUser(u) };
  }
  return null;
}

/** Any codecast user the login names, a bot's included: who wrote the pull request, to keep them off its cards. */
async function anyUserByLogin(ctx: { db: any }, login: string | null | undefined): Promise<Id<"users"> | null> {
  if (!login) return null;
  const u: any = await ctx.db.query("users").withIndex("by_github_username", (q: any) => q.eq("github_username", login)).first();
  return u?._id ?? null;
}

/** The pull request's author, when codecast knows them as a person on the team: never a bot, never a stranger. */
async function teamAuthor(ctx: { db: any }, teamId: Id<"teams"> | undefined, login: string | null | undefined): Promise<Person | null> {
  if (!login || !teamId) return null;
  const u: any = await ctx.db.query("users").withIndex("by_github_username", (q: any) => q.eq("github_username", login)).first();
  if (!u || u.is_bot) return null;
  const member = await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", u._id).eq("team_id", teamId)).first();
  return member ? { user_id: u._id, name: nameOfUser(u) } : null;
}

/** The workspace's admins, people only, oldest member first. */
async function workspaceAdmins(ctx: { db: any }, teamId: Id<"teams"> | undefined): Promise<Person[]> {
  if (!teamId) return [];
  const rows: any[] = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect();
  const people: Person[] = [];
  for (const m of rows.filter((r) => r.role === "admin").sort((x, y) => (x.joined_at ?? 0) - (y.joined_at ?? 0))) {
    const u: any = await ctx.db.get(m.user_id);
    if (u && !u.is_bot) people.push({ user_id: u._id, name: nameOfUser(u) });
  }
  return people;
}

/** Who each question goes to, as people: someone who can be carded whenever the workspace has one (`nobody` only when it has no admin). */
export async function cardPeople(ctx: { db: any }, a: {
  teamId: Id<"teams"> | undefined;
  run: any | null;
  /** Cam asked for it, by codecast's own record (changeApprovalRows.askerOf), never a commit trailer. */
  camAsked: boolean;
  requested_by?: string;
  area_owner?: { user_id: string; name: string };
  author_login?: string;
  engineers: Array<{ user_id: string; name: string }>;
  engineerYes: { user_id: Id<"users"> } | null;
  /** Who installed codecast's app for the repository: the last one asked, so a card always reaches someone. */
  installer?: Id<"users">;
}): Promise<Record<CardReason, Person>> {
  // The owners file names its person by codecast user id: one this deployment does not know is no owner.
  const owner = a.area_owner ? await personOf(ctx, a.area_owner.user_id) : null;
  const author = await teamAuthor(ctx, a.teamId, a.author_login);
  const nobody: Person = { user_id: null, name: "a person" };
  const press: any = a.run?.pressed_approval_id ? await ctx.db.get(a.run.pressed_approval_id) : null;
  const presser = press ? await personOf(ctx, press.user_id) : null;
  const engineer = (p: Person | null) => !!p?.user_id && a.engineers.some((e) => e.user_id === String(p.user_id));
  // On a pull request no run is behind, or about its hold, the author is asked nothing: whoever wrote it, codecast's user or not.
  const writer = await anyUserByLogin(ctx, a.author_login);
  const notWriter = (p: Person | null) => (p && writer && String(p.user_id) === String(writer) ? null : p);
  const areaOwner = notWriter(owner);
  // No owner: the author when they are on the team (with a run behind it), else the workspace's admins (a bot's pull
  // request, a stranger's), else the installer.
  const admins = areaOwner ? [] : (await workspaceAdmins(ctx, a.teamId)).filter((p) => notWriter(p));
  const adminCard: Person | null = admins.length ? { ...admins[0], also: admins.slice(1).map((p) => p.user_id!) } : null;
  const installer = notWriter(a.installer ? await personOf(ctx, a.installer) : null);
  const runless = areaOwner ?? adminCard ?? installer ?? nobody;
  const area = a.run ? owner ?? author ?? adminCard ?? installer ?? nobody : runless;
  if (a.camAsked) {
    const firstEngineer = a.engineers.length ? (await personOf(ctx, a.engineers[0].user_id)) ?? { user_id: null, name: a.engineers[0].name } : null;
    const camOwner = owner && !isCam(owner) ? owner : null;
    const to = (a.engineerYes ? await personOf(ctx, a.engineerYes.user_id) : null) ?? camOwner ?? firstEngineer ?? { user_id: null, name: "an engineer" };
    return { judged: to, mechanism: to, review: to, unreadable: to, objection: to };
  }
  const spawner: any = a.run?.spawner_conversation_id ? await ctx.db.get(a.run.spawner_conversation_id) : null;
  const asker = a.requested_by ? (await memberNamed(ctx, a.teamId, a.requested_by)) ?? { user_id: null, name: a.requested_by } : null;
  const judged = presser ?? asker ?? (spawner ? await personOf(ctx, spawner.user_id) : null) ?? area;
  const mechanism = engineer(presser) ? presser! : area;
  // The change read whole: with no run, the area's owner; a run whose review never answered, whoever reads a mechanism.
  // A hold (an objection) is the automatic review's, so it goes by the rule for a pull request no run is behind.
  return { judged, mechanism, review: a.run ? mechanism : area, unreadable: area, objection: runless };
}

/** The review's own words on the run's task, newest first, cut to fit a card. */
async function reviewWords(ctx: { db: any }, run: any | null): Promise<string | null> {
  if (!run?.task_id) return null;
  const rows: any[] = await ctx.db.query("task_comments").withIndex("by_task_created", (q: any) => q.eq("task_id", run.task_id)).order("desc").take(30);
  const review = rows.find((c) => c.comment_type === "review" && /^verdict\b/i.test(String(c.text ?? "").trim()))
    ?? rows.find((c) => c.comment_type === "review");
  return review ? String(review.text).slice(0, 1500) : null;
}

/** How many of a person's newest sessions are read for one in the repository's team. */
const OWN_SESSION_SCAN = 50;

/**
 * Where the card is asked from: the run's own log, else the pull request's session, else the team's agent's session;
 * else its person's own agent, else their newest session. A card the author must not answer (`own`: a pull request no
 * run is behind, or its hold) is asked only from its person's own, never a session the author can read.
 */
async function askingConversation(ctx: { db: any }, run: any | null, pr: any | null, holder: Id<"users">, own: boolean, teamId: Id<"teams"> | undefined): Promise<any | null> {
  if (own) {
    // Their own session in the repository's workspace (its team's, or a personal install's own), never one of another:
    // else nothing, and they are told.
    const inTeam = (c: any) => !!c && String(c.team_id ?? "") === String(teamId ?? "");
    const anchor: any = await ctx.db.query("anchors").withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", holder)).first();
    const mine = anchor?.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
    if (inTeam(mine)) return mine;
    let scanned = 0;
    for await (const c of ctx.db.query("conversations").withIndex("by_user_updated", (q: any) => q.eq("user_id", holder)).order("desc")) {
      if (inTeam(c)) return c;
      if (++scanned >= OWN_SESSION_SCAN) break;
    }
    return null;
  }
  for (const id of [run?.primary_conversation_id, pr?.shepherd_conversation_id, ...(pr?.linked_session_ids ?? [])]) {
    const c = id ? await ctx.db.get(id) : null;
    if (c) return c;
  }
  for (const anchor of [
    teamId ? await ctx.db.query("anchors").withIndex("by_team", (q: any) => q.eq("team_id", teamId)).first() : null,
    await ctx.db.query("anchors").withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", holder)).first(),
  ]) {
    const c = anchor?.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
    if (c) return c;
  }
  return await ctx.db.query("conversations").withIndex("by_user_updated", (q: any) => q.eq("user_id", holder)).order("desc").first();
}

const WHY: Record<CardReason, string> = {
  judged: "It edits files that judge changes, so nothing it touches can vouch for it.",
  mechanism: "The review called it a mechanism: a mistake here reaches many people and cannot be undone.",
  review: "No review said whether it is a mechanism (a mistake that reaches many people and cannot be undone), and none can now; you read the change whole.",
  unreadable: "Codecast could not read enough of it to tell, so a person approves.",
  objection: "Codecast's automatic review called this pull request a mechanism or objected to it, on this head or an earlier one, and no person has approved it since; you read the change whole.",
};

/** What a card asks about: the diff it binds to (the judged diff's key or the whole diff's) and the question. */
export const cardKeyOf = (diff: string, reason: CardReason) => `${diff}:${reason}`;
const diffOfCardKey = (cardKey: string) => cardKey.slice(0, cardKey.lastIndexOf(":"));

/**
 * Whether the card a pull request holds open stops standing: it asked another question or about another diff, or the
 * status no longer waits on a person. While the status waits only on the review's mechanism answer, a card about a
 * diff the pull request still has (`diffs`: the one the asked question binds to, else either of its keys) stays.
 */
export function cardStale(held: string | undefined, now: { diffs: string[]; reason: CardReason | null; success: boolean }): boolean {
  if (!held) return false;
  if (now.reason) return held !== cardKeyOf(now.diffs[0], now.reason);
  return now.success || !now.diffs.includes(diffOfCardKey(held));
}

/**
 * Takes back a pending approval card that no longer stands. Its answer could approve nothing new (an approval binds to
 * the diff the card showed), but nobody is asked about a diff the pull request no longer has.
 */
export async function withdrawApprovalCard(ctx: { db: any; scheduler: any }, cardId: Id<"session_decisions">, now: number, why: string): Promise<void> {
  const row: any = await ctx.db.get(cardId);
  if (row?.status === "pending") await withdrawCore(ctx as any, row, now, undefined, why);
}

/**
 * Posts the one approval card a pending status owes `to`, unless one was already posted for this judged diff and
 * question (`card_key`). Returns the key and card, or null when no card was posted (no such person, already asked, or
 * no session of theirs in the repository's team to ask from, when they are notified and the next evaluation asks again).
 */
export async function postApprovalCard(ctx: { db: any }, a: {
  repository: string; pr_number: number; head_sha: string; /** The diff its yes approves (changeApprovals.settle). */ key: string; judged: string[];
  reason: CardReason; to: Person; run: any | null; pr: Doc<"pull_requests"> | null; title: string; before_key?: string; now: number;
  /** The review's words when no run holds them (codecast's automatic review). */
  words?: string;
  /** What holds the pull request for a person (changeApprovals.settle), shown first. */
  held?: string;
  /** The repository's team, when no pull request row names it (the installation's). */
  teamId?: Id<"teams">;
}): Promise<{ card_key: string; card_id: Id<"session_decisions"> } | null> {
  const card_key = cardKeyOf(a.key, a.reason);
  if (!a.to.user_id || a.before_key === card_key) return null;
  // With no pull request row to remember the card on, the open card it would repeat is found among its person's own.
  if (!a.pr) {
    const open: any[] = await ctx.db.query("session_decisions").withIndex("by_holder_status", (q: any) => q.eq("holder_key", `user:${a.to.user_id}`).eq("status", "pending")).take(200);
    if (open.some((d) => d.approval_card && d.approval?.repository === a.repository && d.approval?.pr_number === a.pr_number && cardKeyOf(d.approval.judged_key, d.approval.reason) === card_key)) return null;
  }
  const asked = [a.to.user_id, ...(a.to.also ?? [])];
  const conversation = await askingConversation(ctx, a.run, a.pr, a.to.user_id, !a.run || a.reason === "objection", a.pr?.team_id ?? a.run?.team_id ?? a.teamId);
  if (!conversation) {
    // Nowhere to ask from (its person has no session at all): they are told, once per question, so it still lands.
    // No card_key is kept for a notification: the next evaluation posts the card once they have a session. They are
    // told once a head, read or not, whatever else they have, and whatever their notification switches say: only
    // they can act on it.
    const entity = `${a.repository}#${a.pr_number}@${a.head_sha}`;
    for (const id of asked) {
      const notices: any[] = await ctx.db.query("notifications").withIndex("by_recipient_entity", (q: any) => q.eq("recipient_user_id", id).eq("entity_id", entity)).take(5);
      if (notices.some((n) => n.type === "card_waiting")) return null;
    }
    await emitNotification(ctx as any, {
      always: true,
      event_type: "card_waiting", actor_name: "Codecast", entity_type: "code", entity_id: entity,
      message: `${a.repository}#${a.pr_number} waits for your approval: ${WHY[a.reason]}`,
      link: `https://github.com/${a.repository}/pull/${a.pr_number}`, recipient_ids: asked,
    });
    return null;
  }
  const review = a.words ?? await reviewWords(ctx, a.run);
  const files = a.judged.length ? a.judged.map((f) => `- \`${f}\``).join("\n") : "_(no judged files)_";
  const context_md = [
    WHY[a.reason],
    a.held ? `**Held:** ${a.held}.` : null,
    `**Judged files** in ${a.repository}#${a.pr_number} at \`${a.head_sha.slice(0, 10)}\`:\n${files}`,
    review ? `**The review**\n\n${review}` : null,
    `https://github.com/${a.repository}/pull/${a.pr_number}`,
  ].filter(Boolean).join("\n\n");
  const short_id = await nextShortId(ctx.db as any, "sd");
  const card_id: Id<"session_decisions"> = await ctx.db.insert("session_decisions", {
    conversation_id: conversation._id,
    session_id: conversation.session_id,
    user_id: conversation.user_id,
    short_id,
    question: `Approve merging ${a.repository}#${a.pr_number}${a.title ? `: ${a.title}` : ""}?`.slice(0, 300),
    context_md,
    kind: "single",
    category: "review",
    options: [
      { label: "Approve merge", description: "Merges it; it goes live with the next deploy" },
      { label: "Revise", description: "It stays unmerged; say what to change" },
      { label: "Drop", description: "It stays unmerged" },
    ],
    // Blocking: an answered approval card is never answered again (the web's resolution patch re-opens only advisory asks).
    blocking: true,
    silent: true,
    status: "pending",
    holder: { kind: "user", id: String(a.to.user_id) },
    holder_key: `user:${a.to.user_id}`,
    asked_user_ids: asked,
    addressed: true,
    hops: [],
    ...(a.run?.task_id ? { task_id: a.run.task_id } : {}),
    ...(a.pr?.team_id ? { team_id: a.pr.team_id } : {}),
    approval: { repository: a.repository, pr_number: a.pr_number, judged_key: a.key, files: a.judged, ...(a.run ? { run_id: a.run._id } : {}), reason: a.reason, asked },
    approval_card: true,
    created_at: a.now,
    session_title: conversation.title,
    project_path: conversation.project_path,
  });
  await syncDecisionInbox(ctx as any, card_id, asked, a.now);
  return { card_key, card_id };
}

/**
 * The review finished on this head without saying whether the change is a mechanism: it is asked again, in its own
 * session, once per head (the status waits on its answer, never on a person). True when asked.
 */
export async function askReviewForMechanism(ctx: { db: any; scheduler?: any }, run: any, head: string, where: string, attempt: number): Promise<boolean> {
  const r = run?.review_verdict;
  if (!r || r.attempt !== attempt || typeof r.mechanism === "boolean") return false;
  const station = (run.node_statuses ?? []).find((n: any) => n.node_id === r.node_id);
  if (!station || station.status !== "completed" || !station.session_id) return false;
  const conversation = await findConversationByAnyRef(ctx as any, String(station.session_id), run.user_id);
  if (!conversation) return false;
  await enqueuePendingMessage(ctx as any, conversation, run.user_id, {
    content: `Your review of ${where} at ${head.slice(0, 10)} gave no mechanism answer, so its approval status waits on it. Say whether it is a mechanism (a mistake that reaches many people and cannot be undone): \`cast flow review-verdict --verdict ${r.verdict} --head ${r.head_sha} --mechanism true\` or \`--mechanism false\`.`,
    client_id: `approval-mechanism:${run._id}:${head}`,
  });
  return true;
}
