// Who hears of a red main (docs/architecture/main-red.md): the event a culprit
// raises in its workspace, and the brief to the session or person it may tell,
// at most once per culprit commit. convex/mainRed.ts judges and places reds;
// this tells them.
import type { Doc, Id } from "../_generated/dataModel";
import { parseWorkspaceKey, workspaceGrantsAccess } from "./accessKeys";
import { commitRecordedBy, conversationFromSessionTrailer } from "./gitRefs";
import { scheduleTriggerMatch } from "./triggerMatch";
import { recordExternalEventOnce } from "../externalEvents";
import { enqueuePendingMessage } from "../pendingMessages";
import { createTaskAs } from "../tasks";
import { commitBySha } from "../deployTargetsState";
import { formatSessionMessage } from "@codecast/shared/contracts";
import { mainRedBrief, type MainRedPayload } from "@codecast/shared/contracts/mainRed";

const DAY = 86_400_000;

/** The change run whose merge put `sha` on the branch: a merged run's recorded sha is the commit on main. */
export async function runThatMerged(ctx: any, workspace: string, sha: string, around: number): Promise<Doc<"workflow_runs"> | null> {
  const runs: Doc<"workflow_runs">[] = await ctx.db
    .query("workflow_runs")
    .withIndex("by_workspace_merged", (q: any) => q.eq("workspace", workspace).gte("merge.at", around - DAY).lte("merge.at", around + DAY))
    .take(100);
  return runs.find((r) => r.merge && r.merge.sha.length >= 7 && (sha.startsWith(r.merge.sha.toLowerCase()) || r.merge.sha.toLowerCase().startsWith(sha))) ?? null;
}

/** Who may read and act in a workspace, as a link scope for a commit's trailer. */
export function linkScope(row: Pick<Doc<"main_ci_runs">, "workspace" | "team_id">) {
  const ws = parseWorkspaceKey(row.workspace);
  return row.team_id ? { teamId: row.team_id, current: undefined } : { userId: ws?.type === "personal" ? ws.userId : undefined, current: undefined };
}

/** The event's row (cast events ls) and its triggers, in the workspace it belongs to. */
export async function announce(
  ctx: any,
  to: { workspace: string; team_id?: Id<"teams">; repository: string; branch: string },
  kind: string,
  dedupe: string,
  title: string,
  url: string | undefined,
  sha: string,
  payload: MainRedPayload,
  now: number,
  summary?: string,
): Promise<void> {
  const { id, created } = await recordExternalEventOnce(ctx, {
    ...(to.team_id ? { team_id: to.team_id } : {}),
    workspace: to.workspace,
    source: "github",
    repository: to.repository,
    kind,
    title,
    ...(summary ? { summary } : {}),
    ...(url ? { url } : {}),
    sha,
    branch: to.branch,
    data: { main_red: payload },
    dedupe_key: dedupe,
    created_at: now,
  });
  if (!created) return;
  await scheduleTriggerMatch(ctx, {
    event_type: kind,
    ...(to.team_id ? { team_id: to.team_id } : {}),
    workspace: to.workspace,
    repository: to.repository,
    event_ref: { external_event_id: id, title, ...(url ? { url } : {}) },
  });
}

async function tellSession(ctx: any, conv: Doc<"conversations">, text: string, clientId: string): Promise<void> {
  await enqueuePendingMessage(ctx, conv, conv.user_id, { content: formatSessionMessage("unknown", text, { name: "codecast" }), client_id: clientId });
}

/** The codecast user a GitHub login names, when the workspace admits them. */
async function memberByLogin(ctx: any, login: string | undefined, workspace: string): Promise<Id<"users"> | null> {
  if (!login) return null;
  const user = await ctx.db.query("users").withIndex("by_github_username", (q: any) => q.eq("github_username", login)).first();
  return user && (await workspaceGrantsAccess(ctx, user._id, workspace)) ? user._id : null;
}

/**
 * The session a commit's trailer names, when it may be told the commit is red: its owner put the commit on the
 * branch (the push's authenticated pusher, or the change run whose merge recorded it), or the session itself
 * recorded the sha. A trailer alone only links and an author is only an email: anyone with push access may write
 * both to name a teammate's session, and a brief starts a turn in it.
 */
async function sessionToTell(ctx: any, commit: Doc<"commits"> | null, h: Doc<"main_ci_runs">): Promise<Doc<"conversations"> | null> {
  if (!commit) return null;
  const id = await conversationFromSessionTrailer(ctx, commit.message, linkScope(h));
  const conv: Doc<"conversations"> | null = id ? await ctx.db.get(id) : null;
  if (!conv) return null;
  const owner = String(conv.user_id);
  if (String(await memberByLogin(ctx, commit.pushed_by, h.workspace)) === owner) return conv;
  const run = await runThatMerged(ctx, h.workspace, commit.sha.toLowerCase(), commit.main_at ?? commit.timestamp);
  if (run && (String(run.user_id) === owner || String(run.merge?.authorized?.user_id) === owner)) return conv;
  return String(await commitRecordedBy(ctx, commit.sha)) === String(conv._id) ? conv : null;
}

/** Past this many candidates no session is briefed: each brief is an agent turn, and most of them would be wasted. */
export const MAX_BRIEFED_CANDIDATES = 5;

/** Everyone already told of a culprit commit, on any culprit row for it (one that expired and was raised again too). */
async function briefedFor(ctx: any, h: Doc<"main_ci_runs">, sha: string): Promise<Set<string>> {
  const rows: Doc<"main_reds">[] = await ctx.db
    .query("main_reds")
    .withIndex("by_scope_culprit", (q: any) => q.eq("workspace", h.workspace).eq("repository", h.repository).eq("payload.culprit_sha", sha))
    .take(20);
  return new Set(rows.flatMap((r) => r.briefed ?? []));
}

/**
 * Brief the culprit, telling each session or person at most once per culprit commit, ever. Exact: its session, or
 * with none it may tell, its author (by login, so only ever a task's assignee) gets a task. Not exact, with up to
 * MAX_BRIEFED_CANDIDATES candidates: every candidate's session it may tell, each told it is one of N. Past that, no
 * session: one task to whoever pushed the newest candidate, naming the range.
 */
export async function brief(ctx: any, h: Doc<"main_ci_runs">, p: MainRedPayload, redId: Id<"main_reds">, note?: string): Promise<void> {
  const told = await briefedFor(ctx, h, p.culprit_sha);
  const now: string[] = [];
  const clientId = `main-red:${p.repo}:${p.culprit_sha}`;
  const tell = async (conv: Doc<"conversations">, mine?: string) => {
    if (told.has(String(conv._id))) return;
    told.add(String(conv._id));
    now.push(String(conv._id));
    await tellSession(ctx, conv, mainRedBrief(p, { mine, note }), clientId);
  };
  const task = async (user: Id<"users"> | null, title: string) => {
    if (!user || told.has(`task:${user}`)) return;
    told.add(`task:${user}`);
    now.push(`task:${user}`);
    await createTaskAs(ctx, user, {
      title,
      description: mainRedBrief(p, { note }),
      ...(h.team_id ? { workspace: "team" as const, team_id: h.team_id } : { workspace: "personal" as const }),
      priority: "high",
      assignee: String(user),
      client_key: clientId,
    });
  };
  if (p.culprit_exact) {
    const commit = await commitBySha(ctx, p.repo, p.culprit_sha);
    const conv = await sessionToTell(ctx, commit, h);
    if (conv) await tell(conv);
    else await task(await memberByLogin(ctx, commit?.author_login, h.workspace), `Fix red ${p.branch}: ${p.culprit_sha.slice(0, 7)} broke CI`);
  } else if (p.candidates.length <= MAX_BRIEFED_CANDIDATES) {
    for (const sha of p.candidates) {
      const conv = await sessionToTell(ctx, await commitBySha(ctx, p.repo, sha), h);
      if (conv) await tell(conv, sha);
    }
  } else {
    const newest = await commitBySha(ctx, p.repo, p.candidates[p.candidates.length - 1]!);
    const first = p.candidates[0]!.slice(0, 7);
    await task(await memberByLogin(ctx, newest?.pushed_by, h.workspace), `Find which of ${p.candidates.length} commits broke ${p.branch}: ${first}..${p.culprit_sha.slice(0, 7)}`);
  }
  if (now.length) {
    const row = await ctx.db.get(redId);
    await ctx.db.patch(redId, { briefed: [...(row?.briefed ?? []), ...now] });
  }
}
