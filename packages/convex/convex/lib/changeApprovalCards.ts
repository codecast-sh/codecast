// The person codecast's approval status waits on, and the one approval card it posts them (ct-100350 items 5, 6, 8).
// Cards go to a person, never a role:
//   judged files   the person whose Ship press did not list them; else the work's Requested-by person, else the
//                  session's owner; else the area's owner by main's owners file; else the pull request's author.
//   a mechanism    the presser when main's engineers file lists them; else the area's owner; else the author.
//   no review      (no codecast run behind it) the area's owner, else the author.
//   Cam's changes  the engineer whose yes came before the build; else the area's owner, else the first engineer;
//                  never Cam.
// A review that gave no mechanism answer is asked again, never carded. One card per judged diff and question.
// Approval cards count against no open-card cap: codecast has none per person (a role's caps.cards counts runs).
import type { Doc, Id } from "../_generated/dataModel";
import { nextShortId } from "../counters";
import { syncDecisionInbox } from "./decisionInbox";
import { enqueuePendingMessage } from "../pendingMessages";
import { findConversationByAnyRef } from "../conversationSessionLookup";
import { isCam } from "./changeApprovalRows";

export type CardReason = "judged" | "mechanism" | "review" | "unreadable";
export type Person = { user_id: Id<"users"> | null; name: string };

const firstName = (name: string | null | undefined) => String(name ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
const nameOfUser = (u: any): string => u?.name || u?.github_username || u?.email?.split("@")[0] || "a person";

async function personOf(ctx: { db: any }, userId: Id<"users"> | string | null | undefined): Promise<Person | null> {
  const id = userId ? (ctx.db.normalizeId?.("users", String(userId)) ?? userId) : null;
  const u: any = id ? await ctx.db.get(id) : null;
  return u ? { user_id: u._id, name: nameOfUser(u) } : null;
}

/** A member of the team by first name (the owners file and Requested-by name people that way). */
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

async function githubUser(ctx: { db: any }, login: string | null | undefined): Promise<Person | null> {
  if (!login) return null;
  const u: any = await ctx.db.query("users").withIndex("by_github_username", (q: any) => q.eq("github_username", login)).first();
  return u ? { user_id: u._id, name: nameOfUser(u) } : { user_id: null, name: login };
}

/** Who each question goes to, as people (an unresolved name keeps its words and no user, so it is said, never carded). */
export async function cardPeople(ctx: { db: any }, a: {
  teamId: Id<"teams"> | undefined;
  run: any | null;
  /** Cam asked for it, by codecast's own record (changeApprovalRows.askerOf), never a commit trailer. */
  camAsked: boolean;
  requested_by?: string;
  area_owner?: string;
  author_login?: string;
  engineers: Array<{ user_id: string; name: string }>;
  engineerYes: { user_id: Id<"users"> } | null;
}): Promise<Record<CardReason, Person>> {
  const owner = a.area_owner ? (await memberNamed(ctx, a.teamId, a.area_owner)) ?? { user_id: null, name: a.area_owner } : null;
  const author = await githubUser(ctx, a.author_login);
  const nobody: Person = { user_id: null, name: "a person" };
  const press: any = a.run?.pressed_approval_id ? await ctx.db.get(a.run.pressed_approval_id) : null;
  const presser = press ? await personOf(ctx, press.user_id) : null;
  const engineer = (p: Person | null) => !!p?.user_id && a.engineers.some((e) => e.user_id === String(p.user_id));
  const area = owner ?? author ?? nobody;
  if (a.camAsked) {
    const firstEngineer = a.engineers.length ? (await personOf(ctx, a.engineers[0].user_id)) ?? { user_id: null, name: a.engineers[0].name } : null;
    const camOwner = owner && !isCam(owner) ? owner : null;
    const to = (a.engineerYes ? await personOf(ctx, a.engineerYes.user_id) : null) ?? camOwner ?? firstEngineer ?? { user_id: null, name: "an engineer" };
    return { judged: to, mechanism: to, review: to, unreadable: to };
  }
  const spawner: any = a.run?.spawner_conversation_id ? await ctx.db.get(a.run.spawner_conversation_id) : null;
  const asker = a.requested_by ? (await memberNamed(ctx, a.teamId, a.requested_by)) ?? { user_id: null, name: a.requested_by } : null;
  const judged = presser ?? asker ?? (spawner ? await personOf(ctx, spawner.user_id) : null) ?? area;
  const mechanism = engineer(presser) ? presser! : area;
  return { judged, mechanism, review: area, unreadable: area };
}

/** The review's own words on the run's task, newest first, cut to fit a card. */
async function reviewWords(ctx: { db: any }, run: any | null): Promise<string | null> {
  if (!run?.task_id) return null;
  const rows: any[] = await ctx.db.query("task_comments").withIndex("by_task_created", (q: any) => q.eq("task_id", run.task_id)).order("desc").take(30);
  const review = rows.find((c) => c.comment_type === "review" && /^verdict\b/i.test(String(c.text ?? "").trim()))
    ?? rows.find((c) => c.comment_type === "review");
  return review ? String(review.text).slice(0, 1500) : null;
}

/** Where the card is asked from: the run's own log, else the pull request's session, else the team's agent's session. */
async function askingConversation(ctx: { db: any }, run: any | null, pr: any | null): Promise<any | null> {
  for (const id of [run?.primary_conversation_id, pr?.shepherd_conversation_id, ...(pr?.linked_session_ids ?? [])]) {
    const c = id ? await ctx.db.get(id) : null;
    if (c) return c;
  }
  const teamId = pr?.team_id ?? run?.team_id;
  const anchor: any = teamId ? await ctx.db.query("anchors").withIndex("by_team", (q: any) => q.eq("team_id", teamId)).first() : null;
  return anchor?.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
}

const WHY: Record<CardReason, string> = {
  judged: "It edits files that judge changes, so nothing it touches can vouch for it.",
  mechanism: "The review called it a mechanism: a mistake here reaches many people and cannot be undone.",
  review: "No codecast run reviewed it, so nothing has said whether it is a mechanism; you read it.",
  unreadable: "Codecast could not read enough of it to tell, so a person approves.",
};

/**
 * Posts the one approval card a pending status owes `to`, unless one was already posted for this judged diff and
 * question (`card_key`). Returns the key and card, or null when nothing was posted (no such person, nowhere to ask,
 * or already asked).
 */
export async function postApprovalCard(ctx: { db: any }, a: {
  repository: string; pr_number: number; head_sha: string; key: string | undefined; judged: string[];
  reason: CardReason; to: Person; run: any | null; pr: Doc<"pull_requests"> | null; title: string; before_key?: string; now: number;
}): Promise<{ card_key: string; card_id: Id<"session_decisions"> } | null> {
  const card_key = `${a.key ?? a.head_sha}:${a.reason}`;
  if (!a.to.user_id || a.before_key === card_key) return null;
  const conversation = await askingConversation(ctx, a.run, a.pr);
  if (!conversation) return null;
  const review = await reviewWords(ctx, a.run);
  const files = a.judged.length ? a.judged.map((f) => `- \`${f}\``).join("\n") : "_(no judged files)_";
  const context_md = [
    WHY[a.reason],
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
    blocking: false,
    silent: true,
    status: "pending",
    holder: { kind: "user", id: String(a.to.user_id) },
    holder_key: `user:${a.to.user_id}`,
    asked_user_ids: [a.to.user_id],
    addressed: true,
    hops: [],
    ...(a.run?.task_id ? { task_id: a.run.task_id } : {}),
    ...(a.pr?.team_id ? { team_id: a.pr.team_id } : {}),
    approval: { repository: a.repository, pr_number: a.pr_number, judged_key: a.key ?? `head:${a.head_sha}`, files: a.judged, ...(a.run ? { run_id: a.run._id } : {}), reason: a.reason },
    approval_card: true,
    created_at: a.now,
    session_title: conversation.title,
    project_path: conversation.project_path,
  });
  await syncDecisionInbox(ctx as any, card_id, [a.to.user_id], a.now);
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
