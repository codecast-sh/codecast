// Every change on one repository, in flight or recently finished
// (docs/architecture/changes.md), assembled from the rows the web store already
// holds: the checkouts every device reports (contracts/checkouts.ts), the pull
// requests, the deploy targets' queues of commits on main not yet live, and,
// when the branches page asks, GitHub's branch list. Each change comes out as
// the facts lifecycle.ts reads, plus the links and writers a chip draws.
// Reach toward production is not computed here: a landed change names its
// `reach_ref`, which the hook resolves (useDeployReach) and lays on with
// `withReach`. Pure, with relative imports only.
import type { CheckoutRow, CheckoutSession } from "@codecast/shared/contracts/checkouts";
import type { CommitCiState, QueueCommit } from "@codecast/shared/contracts/deployTargets";
import type { DeployReach } from "@codecast/shared/contracts/deployReach";
import { parseRepoObjectId } from "@codecast/shared/entities";
import { commitPageHref, prPageHref, repoCompareHref } from "../repoView";
import { deploysFocusHref } from "../deploys/focus";
import type { ChangeFacts, ChangeWriter } from "./lifecycle";
import { finishedAt, isMerged, prActive, pullRequestFacts, type ChangePullRequest } from "./pullRequest";

export type { ChangePullRequest } from "./pullRequest";

/** Merged or closed pull requests older than this are history, not changes. */
export const RECENT_FINISHED_MS = 7 * 24 * 60 * 60_000;


/** A deploy target as the queue is read from it (lib/deploys/targets DeployTargetRow). */
export type ChangeTarget = { name: string; repository: string; queue: { groups: ReadonlyArray<{ commits: ReadonlyArray<QueueCommit> }> } };

/** One row of GitHub's branch list (hooks/useRepoBrowse RepoBranchDetail). */
export type ChangeBranchRow = { name: string; sha: string; committed_at: number; ahead_by?: number; open_pr: { number: number; title?: string } | null };

export type RepoChangeRows = {
  /** `owner/name`, any case. */
  repository: string;
  now: number;
  checkouts?: ReadonlyArray<CheckoutRow>;
  pullRequests?: ReadonlyArray<ChangePullRequest>;
  /** The team's deploy targets (any repository's); undefined while unread, so `deploys` stays unknown. */
  targets?: ReadonlyArray<ChangeTarget>;
  branches?: { default_branch: string; branches: ReadonlyArray<ChangeBranchRow>; truncated?: boolean } | null;
  /** A session's title in the viewer's own store: a team row never carries one. */
  titleOf?: (conversationId: string) => string | null | undefined;
  /** The people a session belongs to (its author and its routed owner), when the viewer's store holds it. */
  ownersOf?: (conversationId: string) => ReadonlyArray<string> | null | undefined;
};

/**
 * Who a change belongs to, by the strongest fact it carries: its pull request's author, else the people whose sessions
 * wrote it (those the viewer's store knows), else the devices its checkouts sit on, else its commit's author.
 */
export type ChangeOwner =
  | { by: "pr"; login: string }
  | { by: "session"; users: string[] }
  | { by: "device"; devices: string[] }
  | { by: "commit"; author: string };

export type ChangeWriterLink = { conversation_id: string | null; title: string | null; state: ChangeWriter["state"]; href: string | null };

export type ChangeLinks = {
  /** Where the chip opens: the pull request, else the branch's compare page, else the commit; null for a pass. */
  href: string | null;
  pr: string | null;
  /** The deploys that carry it (dp-N), once its reach is laid on. */
  deploys: Array<{ id: string; href: string }>;
  /** A commit on main whose CI there failed: the failing run, where its "red on main" is read. */
  ci_run: string | null;
  action: null;
};

export type AssembledChange = {
  /** Stable per change: `branch:<name>`, `pr:<N>`, `commit:<sha>`, `pass:<device>:<path>`. */
  key: string;
  repository: string;
  facts: ChangeFacts;
  /** `owner/repo#N` or `owner/repo@sha` for a landed change, to resolve with useDeployReach; null before it lands. */
  reach_ref: string | null;
  links: ChangeLinks;
  writers: ChangeWriterLink[];
  /** Which checkout holds it, short (`budget-checks · Ashot Main Mac`); null when no checkout does. */
  where: string | null;
  /** When anyone last worked on it: a session's write, a pull request's update, a commit, a merge. 0 when unknown. */
  updated_at: number;
  /** What a reference can name it by (findChange). */
  refs: { branch: string | null; pr: number | null; shas: string[] };
  owner: ChangeOwner | null;
};

const COMMIT_CI: Record<CommitCiState, NonNullable<ChangeFacts["check"]>["ci"]> = { passed: "success", failed: "failure", running: "pending", none: "none" };

const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();
const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
const deviceName = (row: CheckoutRow) => row.device_label?.trim() || "a machine with no name";
const sameSha = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.length >= 7 && b.length >= 7 && (lower(a).startsWith(lower(b)) || lower(b).startsWith(lower(a)));
const conversationHref = (id: string | null) => (id ? `/conversation/${id}` : null);
/** The default branch a checkout is compared with: `origin/main` → `main`. */
const defaultOf = (row: CheckoutRow, fallback: string) => (row.upstream ? row.upstream.replace(/^[^/]+\//, "") : fallback);
/** A commit subject's pull request: `Fix the thing (#4465)`. */
const subjectPr = (subject: string) => {
  const m = /\(#(\d+)\)\s*$/.exec(subject);
  return m ? Number(m[1]) : null;
};

/**
 * The newest work in these checkouts: a session's last write, else (no session holds edits: they are committed, or
 * nobody's they can attribute) the report, which moves only when the checkout's work does (its hash holds the head).
 */
const lastWrite = (rows: ReadonlyArray<CheckoutRow>) =>
  Math.max(0, ...rows.flatMap((r) => r.uncommitted.sessions.map((s) => s.last_activity))) || Math.max(0, ...rows.map((r) => r.reported_at));

function checkoutWriters(rows: ReadonlyArray<CheckoutRow>, titleOf: RepoChangeRows["titleOf"]): ChangeWriterLink[] {
  const seen = new Map<string, ChangeWriterLink>();
  // Freshest report first: its state for a session reported by two devices wins.
  for (const row of [...rows].sort((a, b) => b.reported_at - a.reported_at)) {
    for (const s of row.uncommitted.sessions) {
      const id = s.conversation_id ?? s.session_id;
      if (!seen.has(id)) seen.set(id, sessionWriter(s, titleOf));
    }
  }
  return [...seen.values()];
}

function sessionWriter(s: CheckoutSession, titleOf: RepoChangeRows["titleOf"]): ChangeWriterLink {
  // A session the viewer's store holds no title for stays nameless: it counts, but nobody can read it.
  const title = (s.conversation_id && titleOf?.(s.conversation_id)?.trim()) || null;
  return { conversation_id: s.conversation_id, title, state: s.state, href: conversationHref(s.conversation_id) };
}

function linkedWriters(ids: ReadonlyArray<string> | undefined, have: ReadonlyArray<ChangeWriterLink>, titleOf: RepoChangeRows["titleOf"]): ChangeWriterLink[] {
  const known = new Set(have.map((w) => w.conversation_id));
  return (ids ?? []).filter((id) => !known.has(id)).map((id) => ({ conversation_id: id, title: titleOf?.(id)?.trim() || null, state: "finished" as const, href: conversationHref(id) }));
}

const factWriters = (ws: ReadonlyArray<ChangeWriterLink>): ChangeWriter[] => ws.map((w) => ({ conversation_id: w.conversation_id, title: w.title, state: w.state }));

/** A change's owner from what it joins, strongest first (ChangeOwner). */
function ownerOf(o: { pr?: ChangePullRequest | null; writers?: ReadonlyArray<ChangeWriterLink>; devices?: ReadonlyArray<string>; author?: string | null }, ownersOf: RepoChangeRows["ownersOf"]): ChangeOwner | null {
  if (o.pr?.author_github_username) return { by: "pr", login: o.pr.author_github_username };
  const users = [...new Set((o.writers ?? []).flatMap((w) => (w.conversation_id && ownersOf?.(w.conversation_id)) || []))];
  if (users.length) return { by: "session", users };
  if (o.devices?.length) return { by: "device", devices: [...new Set(o.devices)] };
  return o.author ? { by: "commit", author: o.author } : null;
}

/** The pull request a branch carries now: an open one, else the newest. */
function pickPr(prs: ReadonlyArray<ChangePullRequest>): ChangePullRequest | null {
  return [...prs].sort((a, b) => Number(b.state === "open") - Number(a.state === "open") || prActive(b) - prActive(a))[0] ?? null;
}

/** Every change on the repository, freshest first. */
export function assemble(rows: RepoChangeRows): AssembledChange[] {
  const repository = lower(rows.repository);
  const { now, titleOf, ownersOf } = rows;
  const checkouts = (rows.checkouts ?? []).filter((c) => lower(c.repository) === repository);
  const prs = (rows.pullRequests ?? []).filter((p) => !p.repository || lower(p.repository) === repository);
  const targets = rows.targets?.filter((t) => lower(t.repository) === repository);
  const deploys = targets ? targets.length > 0 : undefined;
  const fallbackDefault = rows.branches?.default_branch ?? checkouts.find((c) => c.upstream)?.upstream?.replace(/^[^/]+\//, "") ?? "main";
  const remote = new Map((rows.branches?.branches ?? []).map((b) => [b.name, b]));
  const out: AssembledChange[] = [];

  // Pull requests by the branch they head from. One finished more than a week ago is history.
  const recent = (pr: ChangePullRequest) => pr.state === "open" || now - finishedAt(pr) <= RECENT_FINISHED_MS;
  const prsByBranch = new Map<string, ChangePullRequest[]>();
  for (const pr of prs) if (pr.head_ref) prsByBranch.set(pr.head_ref, [...(prsByBranch.get(pr.head_ref) ?? []), pr]);
  const usedPrs = new Set<number>();

  const base = (key: string, facts: ChangeFacts, extra: Partial<AssembledChange> & Pick<AssembledChange, "links" | "writers" | "updated_at" | "refs">): AssembledChange => ({
    key, repository, facts: { ...facts, ...(deploys !== undefined ? { deploys } : {}) }, reach_ref: null, where: null, owner: null, ...extra,
  });

  /** Lay a pull request onto a change's facts and links. */
  const withPr = (facts: ChangeFacts, pr: ChangePullRequest) => {
    usedPrs.add(pr.number);
    const merged = isMerged(pr);
    return {
      facts: { ...facts, ...pullRequestFacts(pr) } satisfies ChangeFacts,
      reach_ref: merged ? `${repository}#${pr.number}` : null,
      pr: prPageHref(repository, pr.number),
    };
  };

  // ── Checkouts: a branch is a change; a default-branch checkout holding work is a pass. ──
  const byBranch = new Map<string, CheckoutRow[]>();
  for (const row of checkouts) {
    if (!row.branch) continue; // detached HEAD: no vehicle to name it by
    if (row.branch === defaultOf(row, fallbackDefault)) {
      if (row.uncommitted.total > 0 || (row.ahead ?? 0) > 0) out.push(passChange(row));
      continue;
    }
    byBranch.set(row.branch, [...(byBranch.get(row.branch) ?? []), row]);
  }

  function passChange(row: CheckoutRow): AssembledChange {
    const writers = checkoutWriters([row], titleOf);
    return base(`pass:${row.device_id}:${row.path}`, {
      vehicle: { kind: "pass", folder: row.path, sessions: row.uncommitted.sessions.length, files: row.uncommitted.total },
      work: { uncommitted: row.uncommitted.total, ahead: row.ahead, pushed: false, writers: factWriters(writers) },
    }, {
      links: { href: null, pr: null, deploys: [], ci_run: null, action: null },
      writers,
      where: `${basename(row.path)} · ${deviceName(row)}`,
      updated_at: lastWrite([row]),
      // Its head is main's: a sha names the commit on main, never this checkout's uncommitted work.
      refs: { branch: null, pr: null, shas: [] },
      owner: ownerOf({ writers, devices: [row.device_id] }, ownersOf),
    });
  }

  for (const [name, group] of byBranch) {
    const fresh = [...group].sort((a, b) => b.reported_at - a.reported_at)[0];
    const allPrs = prsByBranch.get(name) ?? [];
    const recentPrs = allPrs.filter(recent);
    const picked = pickPr(recentPrs);
    const ahead = fresh.ahead ?? null;
    // Work the checkout holds beyond a finished pull request is a new change: the merged or closed one stays its own.
    const past = !!picked && picked.state !== "open" && (fresh.uncommitted.total > 0 || (!!ahead && !sameSha(fresh.head_sha, picked.head_sha) && !sameSha(fresh.head_sha, picked.merge_commit_sha)));
    const pr = past ? null : picked;
    // A branch whose pull request finished long ago, with nothing new in its checkout, is a leftover worktree.
    if (!picked && allPrs.length && fresh.uncommitted.total === 0) {
      for (const p of allPrs) usedPrs.add(p.number);
      continue;
    }
    if (!pr && fresh.uncommitted.total === 0 && !ahead && !remote.get(name)?.ahead_by) continue; // nothing main lacks
    const worktree = isWorktree(fresh, checkouts) ? fresh.path : null;
    let writers = checkoutWriters(group, titleOf);
    if (pr) writers = [...writers, ...linkedWriters(pr.linked_session_ids, writers, titleOf)];
    const pushed = !!pr || remote.has(name);
    let facts: ChangeFacts = {
      vehicle: { kind: "branch", name, worktree, pr: pr?.number ?? null },
      work: { uncommitted: fresh.uncommitted.total, ahead, pushed, writers: factWriters(writers) },
    };
    let reach_ref: string | null = null;
    let prHref: string | null = null;
    if (pr) ({ facts, reach_ref, pr: prHref } = withPr(facts, pr));
    if (!past) for (const p of allPrs) usedPrs.add(p.number);
    const others = new Set(group.map((r) => r.device_id)).size - 1;
    out.push(base(`branch:${name}`, facts, {
      reach_ref,
      links: { href: prHref ?? repoCompareHref(repository, defaultOf(fresh, fallbackDefault), name), pr: prHref, deploys: [], ci_run: null, action: null },
      writers,
      where: `${basename(fresh.path)} · ${deviceName(fresh)}${others > 0 ? ` +${others}` : ""}`,
      updated_at: Math.max(lastWrite(group), pr ? prActive(pr) : 0, remote.get(name)?.committed_at ?? 0),
      refs: { branch: name, pr: pr?.number ?? null, shas: [fresh.head_sha, pr?.head_sha, pr?.merge_commit_sha].filter((s): s is string => !!s) },
      owner: ownerOf({ pr, writers, devices: group.map((r) => r.device_id) }, ownersOf),
    }));
  }

  // ── Pull requests no checkout reports. ──
  const prOnly = new Map<string, ChangePullRequest[]>();
  for (const pr of prs) {
    if (usedPrs.has(pr.number) || !recent(pr)) continue;
    // Several pull requests from one branch are one change: the one it carries now.
    const k = pr.head_ref ?? `#${pr.number}`;
    prOnly.set(k, [...(prOnly.get(k) ?? []), pr]);
  }
  for (const group of prOnly.values()) {
    const pr = pickPr(group)!;
    for (const p of group) usedPrs.add(p.number);
    const writers = linkedWriters(pr.linked_session_ids, [], titleOf);
    const { facts, reach_ref, pr: prHref } = withPr({
      vehicle: { kind: "pr", number: pr.number, branch: pr.head_ref ?? null, title: pr.title ?? null },
      work: { uncommitted: 0, ahead: null, pushed: true, writers: factWriters(writers) },
    }, pr);
    out.push(base(`pr:${pr.number}`, facts, {
      reach_ref,
      links: { href: prHref, pr: prHref, deploys: [], ci_run: null, action: null },
      writers,
      updated_at: prActive(pr),
      refs: { branch: pr.head_ref ?? null, pr: pr.number, shas: [pr.head_sha, pr.merge_commit_sha].filter((s): s is string => !!s) },
      owner: ownerOf({ pr, writers }, ownersOf),
    }));
  }

  // ── Branches on GitHub with commits main lacks that nothing above covers. ──
  const coveredBranches = new Set(out.map((c) => c.refs.branch).filter(Boolean));
  for (const b of rows.branches?.branches ?? []) {
    if (b.name === rows.branches?.default_branch || !b.ahead_by || coveredBranches.has(b.name)) continue;
    if (b.open_pr && usedPrs.has(b.open_pr.number)) continue;
    out.push(base(`branch:${b.name}`, {
      vehicle: { kind: "branch", name: b.name, worktree: null, pr: b.open_pr?.number ?? null },
      work: { uncommitted: 0, ahead: b.ahead_by, pushed: true, writers: [] },
    }, {
      links: { href: b.open_pr ? prPageHref(repository, b.open_pr.number) : repoCompareHref(repository, rows.branches!.default_branch, b.name), pr: b.open_pr ? prPageHref(repository, b.open_pr.number) : null, deploys: [], ci_run: null, action: null },
      writers: [],
      updated_at: b.committed_at,
      refs: { branch: b.name, pr: b.open_pr?.number ?? null, shas: [b.sha] },
    }));
  }

  // ── Commits on main a target has not deployed yet, not already a pull request's change. ──
  const landed = out.filter((c) => c.facts.land?.state === "landed");
  const landedShas = landed.flatMap((c) => (c.facts.land?.sha ? [c.facts.land.sha] : []));
  const landedPrs = new Set(landed.map((c) => c.refs.pr));
  const seenCommits = new Set<string>();
  for (const t of targets ?? []) {
    for (const g of t.queue.groups) {
      for (const c of g.commits) {
        const sha = lower(c.sha);
        if (seenCommits.has(sha)) continue;
        seenCommits.add(sha);
        const prN = subjectPr(c.subject);
        if (landedShas.some((s) => sameSha(s, sha)) || (prN != null && landedPrs.has(prN))) continue;
        const writers: ChangeWriterLink[] = c.session
          ? [{ conversation_id: c.session.conversation_id, title: titleOf?.(c.session.conversation_id)?.trim() || c.session.title?.trim() || c.session.short_id || "a session", state: "finished", href: conversationHref(c.session.conversation_id) }]
          : [];
        const href = commitPageHref(repository, sha);
        const ref = `${repository}@${sha}`;
        out.push(base(`commit:${sha}`, {
          vehicle: { kind: "commit", sha },
          // CI on main ran after the commit landed.
          check: { ci: COMMIT_CI[c.ci], review: "none", after_land: true },
          land: { state: "landed", how: prN != null ? "merged" : "pushed", sha, at: c.at },
          deploys: true,
        }, {
          reach_ref: ref,
          links: { href, pr: prN != null ? prPageHref(repository, prN) : null, deploys: [], ci_run: c.ci === "failed" ? c.ci_url ?? null : null, action: null },
          writers,
          where: null,
          updated_at: c.at,
          refs: { branch: null, pr: prN, shas: [sha] },
          owner: ownerOf({ writers, author: c.author }, ownersOf),
        }));
      }
    }
  }

  return out.sort((a, b) => b.updated_at - a.updated_at || a.key.localeCompare(b.key));
}

/**
 * Whether a checkout is a worktree rather than its device's main checkout: another checkout of the repository on the
 * same device holds it (`.codecast/worktrees/x` under the main one), or it sits in a `worktrees` folder.
 */
function isWorktree(row: CheckoutRow, all: ReadonlyArray<CheckoutRow>): boolean {
  if (/\/\.?worktrees\//.test(row.path)) return true;
  return all.some((o) => o !== row && o.device_id === row.device_id && row.path.startsWith(`${o.path.replace(/\/+$/, "")}/`));
}

/** A landed change with its reach laid on: the facts lifecycle reads, and the deploys that carry it as links. */
export function withReach(change: AssembledChange, reach: DeployReach | null | undefined, read = true): AssembledChange {
  if (!change.reach_ref) return change;
  // Landed, and its reach not read yet: it says so rather than reading as touching nothing.
  if (!read) return { ...change, facts: { ...change.facts, reach_pending: true } };
  if (!reach) return change;
  const ids = [...new Set(reach.targets.flatMap((t) => [t.deploy?.short_id, t.now?.short_id]).filter((s): s is string => !!s))];
  return {
    ...change,
    facts: { ...change.facts, reach },
    links: { ...change.links, deploys: ids.map((id) => ({ id, href: deploysFocusHref({ focus: { kind: "deploy", id } }) })) },
  };
}

/**
 * The change a reference names: a branch name, `#N`, `owner/repo#N`, a sha prefix of 7 or more, or `owner/repo@sha`.
 * A full reference to another repository names none.
 */
export function findChange(changes: ReadonlyArray<AssembledChange>, ref: string): AssembledChange | null {
  const r = ref.trim();
  if (!r) return null;
  const byPr = (n: number, repo?: string) => changes.find((c) => (!repo || c.repository === repo) && c.refs.pr === n) ?? null;
  const bySha = (sha: string, repo?: string) => changes.find((c) => (!repo || c.repository === repo) && c.refs.shas.some((s) => sameSha(s, sha))) ?? null;
  const obj = parseRepoObjectId(r);
  if (obj) return obj.type === "pr" ? byPr(obj.number, obj.repository) : bySha(obj.sha, obj.repository);
  const hash = /^#(\d+)$/.exec(r);
  if (hash) return byPr(Number(hash[1]));
  const branch = changes.find((c) => c.refs.branch === r);
  if (branch) return branch;
  return /^[0-9a-f]{7,40}$/i.test(r) ? bySha(r) : null;
}
