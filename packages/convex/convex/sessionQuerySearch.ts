// Session query operators on the server: turn file:/commit:/pr:/label:/
// author:/repo:/after:/before: into the set of conversations the viewer may
// search, each with the time of the activity that matched. Text search then
// runs over that set (conversations.ts searchByOperators).
//
// Every lookup goes through an index the operator already has; nothing scans a
// table. Candidates are only ids until the end, where each is hydrated and
// passed through the caller's visibility predicate: the same rule that gates
// every other search row, so a file edit in a session the viewer cannot see
// never surfaces. Bodies of file changes are never read, only their index rows.

import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { repoSlugOf, type SessionQuery } from "@codecast/shared/search";
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
  type Candidates,
} from "./sessionQueryCore";

// Budgets. A distinct-root walk costs one conversation read per root, and a
// relative file path costs two index lookups per root.
const MAX_ROOTS = 400;
const ROOT_LOOKUP_BATCH = 40;
const FILE_ROWS_PER_LOOKUP = 50;
const MAX_FILE_ROWS = 2000;
const MAX_REMOTES_PER_USER = 60;
const MAX_REMOTES = 200;
// A bare pr:<n> probes every repository in scope (an absent row costs one
// index probe), but a pull request row carries its files and patches, so
// only the first few that exist are read.
const MAX_PR_REPOS = 60;
const MAX_PR_ROWS = 3;
const RECENT_PER_USER = 100;
const MAX_CANDIDATES = 300;

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
async function distinctConversationValues(
  ctx: QueryCtx,
  userId: Id<"users">,
  index: RootIndex,
  field: RootField,
  cap: number,
): Promise<string[]> {
  const out: string[] = [];
  let last = "";
  while (out.length < cap) {
    const row = await ctx.db
      .query("conversations")
      .withIndex(index, (q: any) => q.eq("user_id", userId).gt(field, last))
      .first();
    const value = row?.[field];
    if (typeof value !== "string") break;
    out.push(value);
    last = value;
  }
  return out;
}

export async function narrowByOperators(
  ctx: QueryCtx,
  q: SessionQuery,
  scope: OperatorScope,
): Promise<{ candidates: OperatorCandidate[] } | { error: string }> {
  const viewerKey = scope.viewerId.toString();

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

  let roots: Promise<string[]> | null = null;
  const checkoutRoots = () =>
    (roots ??= (async () => {
      const found = new Set<string>();
      for (const user of users) {
        for (const [index, field] of [["by_user_git_root", "git_root"], ["by_user_project_path", "project_path"]] as const) {
          if (found.size >= MAX_ROOTS) break;
          const values = await distinctConversationValues(ctx, user._id, index, field, MAX_ROOTS - found.size);
          for (const v of values) found.add(v);
        }
      }
      return [...found];
    })());

  const remoteUrls = async () => {
    const urls: Array<{ userId: Id<"users">; url: string }> = [];
    for (const user of users) {
      if (urls.length >= MAX_REMOTES) break;
      const cap = Math.min(MAX_REMOTES_PER_USER, MAX_REMOTES - urls.length);
      for (const url of await distinctConversationValues(ctx, user._id, "by_user_git_remote_url", "git_remote_url", cap)) {
        urls.push({ userId: user._id, url });
      }
    }
    return urls;
  };

  let candidates: Candidates | null = null;

  for (const path of q.files) {
    const found: Candidates = new Map();
    const prefixes = fileQueryPrefixes(path, path.startsWith("/") ? [] : await checkoutRoots());
    let rows = 0;
    for (let i = 0; i < prefixes.length && rows < MAX_FILE_ROWS; i += ROOT_LOOKUP_BATCH) {
      const batches = await Promise.all(
        prefixes.slice(i, i + ROOT_LOOKUP_BATCH).flatMap((prefix) => [
          ctx.db
            .query("file_changes")
            .withIndex("by_file_path", (ix) => ix.eq("file_path", prefix))
            .order("desc")
            .take(FILE_ROWS_PER_LOOKUP),
          ctx.db
            .query("file_changes")
            .withIndex("by_file_path", (ix) => ix.gte("file_path", `${prefix}/`).lt("file_path", `${prefix}/￿`))
            .take(FILE_ROWS_PER_LOOKUP),
        ]),
      );
      for (const row of batches.flat()) {
        rows++;
        if (row.change_type === "commit") continue;
        if (!prefixes.some((p) => pathMatchesPrefix(row.file_path, p))) continue;
        if (!inWindow(row.timestamp, q.after, q.before)) continue;
        addCandidate(found, row.conversation_id.toString(), row.timestamp);
      }
    }
    candidates = intersectCandidates(candidates, found);
  }

  for (const sha of q.commits) {
    const found: Candidates = new Map();
    // Pushed commits carry the full sha; a typed prefix finds them by range.
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
      if (row.conversation_id) addCandidate(found, row.conversation_id.toString(), row.timestamp);
    }
    // A session's own commit row stores the short hash git printed, which can
    // be longer than what was typed...
    const longer = await ctx.db
      .query("file_changes")
      .withIndex("by_commit_hash", (ix) => ix.gte("commit_hash", sha).lt("commit_hash", `${sha}~`))
      .take(20);
    for (const row of longer) addCandidate(found, row.conversation_id.toString(), row.timestamp);
    // ...or a prefix of the full sha, which is cast blame's resolution.
    const resolved = await resolveCommitSessions(ctx, scope.viewerId, [...descriptors.values()], newResolveCaches());
    for (const session of Object.values(resolved)) addCandidate(found, session.conversation_id.toString());
    candidates = intersectCandidates(candidates, found);
  }

  if (q.prs.length > 0) {
    // Pull requests are keyed by repository, so a bare number is looked up in
    // the repositories the scope's GitHub installations cover (the only ones
    // with pull request rows), and only if none has it, in those the scope's
    // sessions push to. repo: narrows both lists.
    const inRepoFilter = (slugs: string[]) =>
      [...new Set(slugs)].filter((slug) => slug.includes("/") && q.repos.every((r) => repoMatchesConversation({ git_remote_url: slug }, r)));
    let installed: string[] | null = null;
    let pushed: string[] | null = null;
    const installedRepos = async () =>
      (installed ??= inRepoFilter((await Promise.all([
        ...scope.teamIds.map((teamId) =>
          ctx.db.query("github_app_installations").withIndex("by_team_id", (ix) => ix.eq("team_id", teamId)).collect()),
        ctx.db.query("github_app_installations").withIndex("by_scope_user", (ix) => ix.eq("scope_user_id", scope.viewerId)).collect(),
      ])).flat().flatMap((row) => (row.repositories ?? []).map((r) => r.full_name))));
    const pushedRepos = async () =>
      (pushed ??= inRepoFilter((await remoteUrls()).map(({ url }) => repoSlugOf(url))));

    // A remote keeps whatever case it was cloned with (Union-AI/app) while the
    // row carries GitHub's name, so each repository is tried as written and
    // lowercased.
    const probe = async (number: number, repos: string[], found: Candidates) => {
      let rowsRead = 0;
      const spellings = [...new Set(repos.slice(0, MAX_PR_REPOS).flatMap((r) => [r, r.toLowerCase()]))];
      for (const repository of spellings) {
        if (rowsRead >= MAX_PR_ROWS) break;
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
  // in scope (in the named repository, when there is one).
  if (candidates === null) {
    const found: Candidates = new Map();
    for (const user of users) {
      if (q.repos.length > 0) {
        const urls = (await distinctConversationValues(ctx, user._id, "by_user_git_remote_url", "git_remote_url", MAX_REMOTES_PER_USER))
          .filter((url) => q.repos.every((r) => repoMatchesConversation({ git_remote_url: url }, r)));
        const perUrl = await Promise.all(urls.map((url) =>
          ctx.db
            .query("conversations")
            .withIndex("by_user_git_remote_url", (ix) => ix.eq("user_id", user._id).eq("git_remote_url", url))
            .order("desc")
            .take(RECENT_PER_USER),
        ));
        for (const conv of perUrl.flat()) addCandidate(found, conv._id.toString());
        // A checkout with no remote is named by its folder.
        if (q.repos.every((r) => !r.includes("/"))) {
          const rootsByName = (await distinctConversationValues(ctx, user._id, "by_user_git_root", "git_root", MAX_ROOTS))
            .filter((root) => q.repos.every((r) => repoMatchesConversation({ git_root: root }, r)));
          const perRoot = await Promise.all(rootsByName.map((root) =>
            ctx.db
              .query("conversations")
              .withIndex("by_user_git_root", (ix) => ix.eq("user_id", user._id).eq("git_root", root))
              .order("desc")
              .take(RECENT_PER_USER),
          ));
          for (const conv of perRoot.flat()) addCandidate(found, conv._id.toString());
        }
      } else {
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
          .take(RECENT_PER_USER);
        for (const conv of recent) addCandidate(found, conv._id.toString());
      }
    }
    candidates = found;
  }

  // Timed matches first (newest change), then the rest; hydrate a bounded set.
  const ids = [...candidates.entries()]
    .sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1))
    .slice(0, MAX_CANDIDATES);
  const convs = await Promise.all(ids.map(([id]) => ctx.db.get(id as Id<"conversations">)));
  const out: OperatorCandidate[] = [];
  convs.forEach((conv, i) => {
    if (!conv || !scope.isVisible(conv)) return;
    if (authorIds && !authorIds.has(conv.user_id.toString())) return;
    if (!q.repos.every((r) => repoMatchesConversation(conv, r))) return;
    const changedAt = ids[i][1];
    // A change time was already held to the window; a whole-session match is
    // held to it by the session's last activity.
    if (changedAt === undefined && !inWindow(conv.updated_at, q.after, q.before)) return;
    out.push({ conv, matchedAt: changedAt ?? conv.updated_at });
  });
  out.sort((a, b) => b.matchedAt - a.matchedAt);
  return { candidates: out };
}
