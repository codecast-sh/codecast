// Session query operators on the server: turn file:/commit:/pr:/label:/
// author:/repo:/after:/before: into the set of conversations the viewer may
// search, each with the time of the activity that matched. Text search then
// runs over that set (conversations.ts searchByOperators).
//
// Every lookup goes through an index the operator already has; nothing scans a
// table. Candidates are only ids until the end, where each is hydrated and
// passed through the caller's visibility predicate: the same rule that gates
// every other search row, so a file edit in a session the viewer cannot see
// never surfaces. File change rows hold only sizes (their text lives in
// file_change_bodies, fully migrated), so walking them reads no bodies.
//
// Every walk draws on one WalkBudget. When a walk stops short (a hot file, a
// user with thousands of checkouts) it says so in `truncated`, which the CLI
// and the web page show, so a partial answer never passes for the whole one.

import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { extractRepoFromRemoteUrl } from "@codecast/shared/contracts";
import type { SessionQuery } from "@codecast/shared/search";
import { newResolveCaches, resolveCommitSessions, type CommitDescriptor } from "./blame";
import { extractSessionTrailer } from "./lib/gitRefs";
import { resolveLabelConvIds } from "./buckets";
import {
  addCandidate,
  fileQueryPrefixes,
  inWindow,
  intersectCandidates,
  matchAuthorIds,
  pathMatchesPrefix,
  repoMatchesConversation,
  WalkBudget,
  worktreeContainer,
  type Candidates,
} from "./sessionQueryCore";

export const OPERATOR_LIMITS = {
  // Index reads and gets across every walk of one query. Convex allows 4096
  // per function; the rest is left for scope loading and text lookups.
  reads: 3000,
  // Bytes of edit rows walked. Rows hold only sizes, so this is ~600 B of index
  // metadata each; a row still carrying legacy inline text counts its text,
  // so a straggler the body migration missed cannot push a hot file walk
  // toward Convex's 16 MiB read cap.
  fileBytes: 8 * 1024 * 1024,
  // Distinct checkout roots, then project paths, walked across users (one
  // conversation read each).
  roots: 1200,
  // When the root walk stops short, each user's newest sessions add their roots.
  recentRootsPerUser: 25,
  // Distinct remotes read per user while looking for the ones repo: names.
  remoteReadsPerUser: 600,
  // Edit rows one file: value reads, newest first, and the sessions it stops at.
  fileRows: 4000,
  fileSessions: 200,
  // Rows per file inside a folder, so one hot file cannot starve its siblings.
  folderFileRows: 200,
  // Conversations hydrated to find `candidates` the viewer may see.
  hydrate: 800,
  candidates: 300,
  recentPerUser: 100,
  // A bare pr:<n> probes every repository in scope (an absent row costs one
  // index probe), but a pull request row carries its files and patches, so
  // only the first few that exist are read.
  prRepos: 60,
  prRows: 3,
};
export type OperatorLimits = typeof OPERATOR_LIMITS;

// An edit row is written when its message syncs, after the edit happened, so
// its creation time bounds its timestamp from above. A day of slack covers a
// machine whose clock runs ahead.
const CLOCK_SLACK_MS = 86_400_000;
const PROBE_BATCH = 40;
// An edit row without inline text, rounded up: ids, path, sizes, timestamps.
const ROW_BYTES = 600;
const HYDRATE_BATCH = 50;

export type OperatorScope = {
  viewerId: Id<"users">;
  /** Everyone whose sessions the viewer may search, the viewer first. */
  users: Doc<"users">[];
  /** The teams in scope, whose GitHub installations name the repositories a bare pr:<n> probes. */
  teamIds: Id<"teams">[];
  /** The caller's search visibility rule, applied to every candidate. */
  isVisible: (conv: Doc<"conversations">) => boolean;
};

export type OperatorCandidate = { conv: Doc<"conversations">; matchedAt: number };

type RootIndex = "by_user_git_root" | "by_user_project_path" | "by_user_git_remote_url";
type RootField = "git_root" | "project_path" | "git_remote_url";

// The distinct values of one field across a user's conversations, one read
// per value: each step asks the index for the first row past the last value.
// `keep` filters while walking, so a cap bounds reads rather than matches.
// `from`/`until` bound the walk to a range, and `defer` names a container
// (a folder of worktrees) the walk jumps over in one read, handing it back
// in `deferred` for the caller to walk later.
async function distinctConversationValues(
  ctx: QueryCtx,
  userId: Id<"users">,
  index: RootIndex,
  field: RootField,
  opts: {
    reads: number;
    budget: WalkBudget;
    keep?: (value: string) => boolean;
    from?: string;
    until?: string;
    defer?: (value: string) => string | null;
  },
): Promise<{ values: string[]; deferred: string[]; reads: number; complete: boolean }> {
  const values: string[] = [];
  const deferred: string[] = [];
  let last = opts.from ?? "";
  let reads = 0;
  while (reads < opts.reads && opts.budget.spend()) {
    reads++;
    const row = await ctx.db
      .query("conversations")
      .withIndex(index, (q: any) => {
        const range = q.eq("user_id", userId).gt(field, last);
        return opts.until === undefined ? range : range.lt(field, opts.until);
      })
      .first();
    const value = row?.[field];
    if (typeof value !== "string") return { values, deferred, reads, complete: true };
    const container = opts.defer?.(value);
    if (container) {
      deferred.push(container);
      last = `${container}\uffff`;
      continue;
    }
    if (!opts.keep || opts.keep(value)) values.push(value);
    last = value;
  }
  return { values, deferred, reads, complete: false };
}

export async function narrowByOperators(
  ctx: QueryCtx,
  q: SessionQuery,
  scope: OperatorScope,
  limits: OperatorLimits = OPERATOR_LIMITS,
): Promise<{ candidates: OperatorCandidate[]; truncated: string[] } | { error: string }> {
  const viewerKey = scope.viewerId.toString();
  const budget = new WalkBudget(limits.reads, limits.fileBytes);

  const authorSets: Set<string>[] = [];
  for (const author of q.authors) {
    const ids = matchAuthorIds(scope.users, author, viewerKey);
    if (ids.size === 0) return { error: `author: nobody whose sessions you can search matches "${author}"` };
    authorSets.push(ids);
  }
  const authorIds = authorSets.length
    ? authorSets.reduce((acc, ids) => new Set([...acc].filter((id) => ids.has(id))))
    : null;
  // Whose checkouts and sessions to walk: the named authors, else everyone.
  const users = authorIds ? scope.users.filter((u) => authorIds.has(u._id.toString())) : scope.users;

  // Every checkout root the people in scope ran sessions in. When there are
  // more than the walk reads, each person's newest sessions add theirs first,
  // so a cut drops old worktrees rather than today's checkout.
  let roots: Promise<string[]> | null = null;
  const checkoutRoots = () =>
    (roots ??= (async () => {
      const walked = new Set<string>();
      let complete = true;
      let left = limits.roots;
      const later: Array<{ userId: Id<"users">; index: "by_user_git_root" | "by_user_project_path"; field: "git_root" | "project_path"; container: string }> = [];
      for (const [index, field] of [
        ["by_user_git_root", "git_root"],
        ["by_user_project_path", "project_path"],
      ] as const) {
        for (const user of users) {
          if (left <= 0) {
            complete = false;
            break;
          }
          const walk = await distinctConversationValues(ctx, user._id, index, field, { reads: left, budget, defer: worktreeContainer });
          left -= walk.reads;
          complete &&= walk.complete;
          for (const v of walk.values) walked.add(v);
          for (const container of walk.deferred) later.push({ userId: user._id, index, field, container });
        }
      }
      for (const { userId, index, field, container } of later) {
        if (left <= 0) {
          complete = false;
          break;
        }
        const walk = await distinctConversationValues(ctx, userId, index, field, {
          reads: left, budget, from: container, until: `${container}\uffff`,
        });
        left -= walk.reads;
        complete &&= walk.complete;
        for (const v of walk.values) walked.add(v);
      }
      if (complete) return [...walked];
      const recent = new Set<string>();
      for (const user of users) {
        if (!budget.spend()) break;
        const convs = await ctx.db
          .query("conversations")
          .withIndex("by_user_updated", (ix) => ix.eq("user_id", user._id))
          .order("desc")
          .take(limits.recentRootsPerUser);
        for (const c of convs) for (const v of [c.git_root, c.project_path]) if (v) recent.add(v);
      }
      budget.note(`file: looked under ${walked.size} checkouts and the newest sessions' ones; an absolute path reaches any other`);
      return [...new Set([...recent, ...walked])];
    })());

  const remotesMatching = async (keep: (url: string) => boolean) => {
    const urls: Array<{ userId: Id<"users">; url: string }> = [];
    for (const user of users) {
      const walk = await distinctConversationValues(ctx, user._id, "by_user_git_remote_url", "git_remote_url", {
        reads: limits.remoteReadsPerUser, budget, keep,
      });
      if (!walk.complete) budget.note(`repo: looked through ${walk.reads} of ${user.name ?? "a teammate"}'s remotes`);
      for (const url of walk.values) urls.push({ userId: user._id, url });
    }
    return urls;
  };
  const matchesRepos = (conv: { git_remote_url?: string; git_root?: string }) =>
    q.repos.every((r) => repoMatchesConversation(conv, r));

  let candidates: Candidates | null = null;

  for (const path of q.files) {
    candidates = intersectCandidates(candidates, await fileCandidates(ctx, path, path.startsWith("/") ? [] : await checkoutRoots(), q, budget, limits));
  }

  for (const sha of q.commits) {
    const found: Candidates = new Map();
    // A commit matches at the time it was made, held to after:/before: like an edit.
    const add = (id: string, at?: number) => {
      if (at === undefined || inWindow(at, q.after, q.before)) addCandidate(found, id, at);
    };
    // Pushed commits carry the full sha; a typed prefix finds them by range.
    budget.spend(3);
    const named = await ctx.db
      .query("commits")
      .withIndex("by_sha", (ix) => ix.gte("sha", sha).lt("sha", `${sha}~`))
      .take(10);
    // The typed sha itself goes to blame's resolution too: a stored short
    // hash that prefixes it attributes it, however long it was typed. A pushed
    // commit also brings its subject and time, which is how blame finds the
    // session whose commit output printed no hash.
    const descriptors = new Map<string, CommitDescriptor>([[sha, { sha }]]);
    for (const row of named) {
      descriptors.set(row.sha, { sha: row.sha, summary: row.message.split("\n")[0], author_time: row.timestamp, session: extractSessionTrailer(row.message) ?? undefined });
      if (row.conversation_id) add(row.conversation_id.toString(), row.timestamp);
    }
    // A session's own commit row stores the short hash git printed, which can
    // be longer than what was typed...
    const longer = await ctx.db
      .query("file_changes")
      .withIndex("by_commit_hash", (ix) => ix.gte("commit_hash", sha).lt("commit_hash", `${sha}~`))
      .take(20);
    const rowTime = new Map<string, number>();
    for (const row of longer) {
      rowTime.set(row.conversation_id.toString(), row.timestamp);
      add(row.conversation_id.toString(), row.timestamp);
    }
    // ...or a prefix of the full sha, which is cast blame's resolution.
    const resolved = await resolveCommitSessions(ctx, scope.viewerId, [...descriptors.values()], newResolveCaches());
    for (const [key, session] of Object.entries(resolved)) {
      const id = session.conversation_id.toString();
      add(id, descriptors.get(key)?.author_time ?? rowTime.get(id));
    }
    candidates = intersectCandidates(candidates, found);
  }

  if (q.prs.length > 0) {
    // Pull requests are keyed by repository, so a bare number is looked up in
    // the repositories the scope's GitHub installations cover (the only ones
    // with pull request rows), and only if none has it, in those the scope's
    // sessions push to. repo: narrows both lists.
    const inRepoFilter = (slugs: string[]) =>
      [...new Set(slugs)].filter((slug) => slug.includes("/") && matchesRepos({ git_remote_url: slug }));
    let installed: string[] | null = null;
    let pushed: string[] | null = null;
    const installedRepos = async () =>
      (installed ??= inRepoFilter((await Promise.all([
        ...scope.teamIds.map((teamId) =>
          ctx.db.query("github_app_installations").withIndex("by_team_id", (ix) => ix.eq("team_id", teamId)).collect()),
        ctx.db.query("github_app_installations").withIndex("by_scope_user", (ix) => ix.eq("scope_user_id", scope.viewerId)).collect(),
      ])).flat().flatMap((row) => (row.repositories ?? []).map((r) => r.full_name))));
    const pushedRepos = async () =>
      (pushed ??= inRepoFilter((await remotesMatching((url) => {
        const slug = extractRepoFromRemoteUrl(url);
        return slug !== null && matchesRepos({ git_remote_url: slug });
      })).map(({ url }) => extractRepoFromRemoteUrl(url)!)));

    // Rows are stored under the lowercase name; an installation lists GitHub's
    // casing, so each repository is tried as written and lowercased.
    const probe = async (number: number, repos: string[], found: Candidates) => {
      let rowsRead = 0;
      const spellings = [...new Set(repos.slice(0, limits.prRepos).flatMap((r) => [r, r.toLowerCase()]))];
      for (const repository of spellings) {
        if (rowsRead >= limits.prRows || !budget.spend()) break;
        const row = await ctx.db
          .query("pull_requests")
          .withIndex("by_repository_number", (ix) => ix.eq("repository", repository).eq("number", number))
          .first();
        if (!row) continue;
        rowsRead++;
        for (const id of row.linked_session_ids ?? []) addCandidate(found, id.toString());
        if (row.shepherd_conversation_id) addCandidate(found, row.shepherd_conversation_id.toString());
      }
      return rowsRead > 0;
    };

    for (const pr of q.prs) {
      const found: Candidates = new Map();
      if (pr.repository) await probe(pr.number, [pr.repository], found);
      else if (!(await probe(pr.number, await installedRepos(), found))) {
        const tried = new Set(await installedRepos());
        await probe(pr.number, (await pushedRepos()).filter((r) => !tried.has(r)), found);
      }
      candidates = intersectCandidates(candidates, found);
    }
  }

  for (const label of q.labels) {
    const resolved = await resolveLabelConvIds(ctx, scope.viewerId, label);
    if ("error" in resolved) return { error: `label: ${resolved.error}` };
    candidates = intersectCandidates(candidates, new Map([...resolved.convIds].map((id) => [id, undefined])));
  }

  // Only author/repo/time were asked: walk the recent sessions of the people
  // in scope (in the named repository, when there is one). The rows are in
  // hand, so each is keyed by its last activity (held to the window here) and
  // kept for hydration.
  const known = new Map<string, Doc<"conversations">>();
  if (candidates === null) {
    const found: Candidates = new Map();
    const take = (convs: Doc<"conversations">[]) => {
      for (const conv of convs) {
        if (!inWindow(conv.updated_at, q.after, q.before)) continue;
        known.set(conv._id.toString(), conv);
        addCandidate(found, conv._id.toString(), conv.updated_at);
      }
    };
    const newest = async (index: "by_user_git_remote_url" | "by_user_git_root", field: "git_remote_url" | "git_root", userId: Id<"users">, value: string) => {
      if (!budget.spend()) return;
      const convs = await ctx.db
        .query("conversations")
        .withIndex(index, (ix: any) => ix.eq("user_id", userId).eq(field, value))
        .order("desc")
        .take(limits.recentPerUser);
      take(convs);
    };
    if (q.repos.length > 0) {
      for (const { userId, url } of await remotesMatching((url) => matchesRepos({ git_remote_url: url }))) {
        await newest("by_user_git_remote_url", "git_remote_url", userId, url);
      }
      // A checkout with no remote is named by its folder. Worktrees are
      // named for their task, not their repository, so their folders are
      // skipped in one read.
      if (q.repos.every((r) => !r.includes("/"))) {
        for (const user of users) {
          const walk = await distinctConversationValues(ctx, user._id, "by_user_git_root", "git_root", {
            reads: limits.roots, budget, keep: (root) => matchesRepos({ git_root: root }), defer: worktreeContainer,
          });
          if (!walk.complete) budget.note(`repo: looked through ${walk.reads} checkout folders`);
          for (const root of walk.values) await newest("by_user_git_root", "git_root", user._id, root);
        }
      }
    } else {
      for (const user of users) {
        if (!budget.spend()) break;
        const recent = await ctx.db
          .query("conversations")
          .withIndex("by_user_updated", (ix) => {
            const byUser = ix.eq("user_id", user._id);
            if (q.after !== undefined && q.before !== undefined) return byUser.gte("updated_at", q.after).lte("updated_at", q.before);
            if (q.after !== undefined) return byUser.gte("updated_at", q.after);
            if (q.before !== undefined) return byUser.lte("updated_at", q.before);
            return byUser;
          })
          .order("desc")
          .take(limits.recentPerUser);
        take(recent);
      }
    }
    candidates = found;
  }

  // Timed matches first (newest change), then the rest. Hydrate in batches
  // and apply visibility as they land, so sessions the viewer cannot see
  // never take the seats of ones they can.
  const ordered = [...candidates.entries()].sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1));
  const out: OperatorCandidate[] = [];
  let i = 0;
  for (; i < ordered.length && out.length < limits.candidates; i += HYDRATE_BATCH) {
    const batch = ordered.slice(i, i + HYDRATE_BATCH);
    const unread = batch.filter(([id]) => !known.has(id)).length;
    if (i >= limits.hydrate || !budget.spend(unread)) break;
    const convs = await Promise.all(batch.map(([id]) => known.get(id) ?? ctx.db.get(id as Id<"conversations">)));
    convs.forEach((conv, j) => {
      if (!conv || !scope.isVisible(conv)) return;
      if (authorIds && !authorIds.has(conv.user_id.toString())) return;
      if (!matchesRepos(conv)) return;
      const changedAt = batch[j][1];
      // A change time was already held to the window; a whole-session match is
      // held to it by the session's last activity.
      if (changedAt === undefined && !inWindow(conv.updated_at, q.after, q.before)) return;
      out.push({ conv, matchedAt: changedAt ?? conv.updated_at });
    });
  }
  if (i < ordered.length || out.length > limits.candidates) {
    budget.note(`stopped at ${Math.min(out.length, limits.candidates)} matching sessions, newest first; add after:, before: or author: to reach the rest`);
  }
  out.sort((a, b) => b.matchedAt - a.matchedAt);
  return { candidates: out.slice(0, limits.candidates), truncated: budget.truncated };
}

/**
 * Sessions that edited a file or anything under a folder, newest edit first.
 * Each checkout root is probed with one read; the ones that hold the path are
 * walked newest first, rows held to after:/before: as they stream, until the
 * sessions or rows budget is reached.
 */
async function fileCandidates(
  ctx: QueryCtx,
  path: string,
  roots: string[],
  q: SessionQuery,
  budget: WalkBudget,
  limits: OperatorLimits,
): Promise<Candidates> {
  const found: Candidates = new Map();
  const prefixes = fileQueryPrefixes(path, roots);
  const range = (prefix: string) =>
    ctx.db.query("file_changes").withIndex("by_file_path", (ix) => ix.gte("file_path", prefix).lt("file_path", `${prefix}/\uffff`));

  // Which prefixes hold anything at all: one read each.
  const hits: Array<{ prefix: string; at: number }> = [];
  for (let i = 0; i < prefixes.length; i += PROBE_BATCH) {
    const batch = prefixes.slice(i, i + PROBE_BATCH);
    if (!budget.spend(batch.length)) break;
    const rows = await Promise.all(batch.map((prefix) => range(prefix).order("desc").first()));
    rows.forEach((row, j) => row && hits.push({ prefix: batch[j], at: row.timestamp }));
  }
  hits.sort((a, b) => b.at - a.at);

  const floor = q.after === undefined ? undefined : q.after - CLOCK_SLACK_MS;
  let rowsLeft = limits.fileRows;
  let sessionCut = false;
  let perFileCut = false;
  // One stored path, newest first, stopping at the window's lower edge, at
  // `cap` rows, or (for a file, where newest first is exact) once `stopAt`
  // sessions are found. True when it stopped with rows left unread.
  const walkPath = async (filePath: string, cap: number, stopAt?: number): Promise<boolean> => {
    if (!budget.spend()) return true;
    let read = 0;
    const rows = ctx.db
      .query("file_changes")
      .withIndex("by_file_path", (ix) => (floor === undefined ? ix.eq("file_path", filePath) : ix.eq("file_path", filePath).gte("_creationTime", floor)))
      .order("desc");
    for await (const row of rows) {
      if (read >= cap || rowsLeft <= 0) return true;
      read++;
      rowsLeft--;
      if (!budget.spendBytes(ROW_BYTES + (row.old_content?.length ?? 0) + (row.new_content?.length ?? 0) + (row.commit_message?.length ?? 0))) {
        rowsLeft = 0;
        return true;
      }
      if (row.change_type === "commit" || !inWindow(row.timestamp, q.after, q.before)) continue;
      addCandidate(found, row.conversation_id.toString(), row.timestamp);
      if (stopAt !== undefined && found.size >= stopAt) {
        sessionCut = true;
        return true;
      }
    }
    return false;
  };

  for (const { prefix } of hits) {
    if (rowsLeft <= 0 || sessionCut) break;
    await walkPath(prefix, limits.fileRows, limits.fileSessions);
    // A folder: every distinct file under it, one seek each. Files come in
    // path order, not recency, so each gets a bounded walk and the newest
    // sessions are chosen once every file has had its turn.
    let last = `${prefix}/`;
    while (rowsLeft > 0 && budget.spend()) {
      const next = await ctx.db
        .query("file_changes")
        .withIndex("by_file_path", (ix) => ix.gt("file_path", last).lt("file_path", `${prefix}/\uffff`))
        .first();
      if (!next) break;
      if (pathMatchesPrefix(next.file_path, prefix) && (await walkPath(next.file_path, limits.folderFileRows)) && rowsLeft > 0) {
        perFileCut = true;
      }
      last = next.file_path;
    }
  }
  if (rowsLeft <= 0) budget.note(`file:${path} stopped after reading ${limits.fileRows - Math.max(rowsLeft, 0)} edits; add before:, after: or a deeper path`);
  if (perFileCut) budget.note(`file:${path} read the newest ${limits.folderFileRows} edits of each file under it`);
  if (sessionCut || found.size > limits.fileSessions) {
    budget.note(`file:${path} kept the ${limits.fileSessions} session${limits.fileSessions === 1 ? "" : "s"} with the newest edits`);
    return new Map([...found.entries()].sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).slice(0, limits.fileSessions));
  }
  return found;
}
