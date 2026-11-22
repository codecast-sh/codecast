// How a session's change enters a flow (docs/architecture/flows.md FL4). A
// session in a shared checkout leaves its edits uncommitted beside everyone
// else's; the flow runs on a commit of exactly that session's files, made from
// the frozen tree the way `cast ship checkout` makes its commits, on a branch
// of its own, so nothing in the shared tree moves. The commit is built on HEAD,
// the base its frozen content grew from, then replayed onto the freshly
// fetched upstream, so every stage tests the change on what it would land on.
//
// Every file the session wrote goes in, including one another session also
// wrote after it (attribution is per file, so that file carries the other
// session's lines too, and the change says so). Dropping a file the session
// wrote would run the flow on part of its change, which is worse than carrying
// a neighbour's edit the change names.
//
// A checkout's change (`cast flow run --checkout`) is the whole shared tree's
// uncommitted pass, cut the way `cast ship checkout` plans one: a commit per
// session that wrote files, one for files no session's edit names, credentials
// and stale copies held out. It records which session wrote each file, so a
// stage's finding goes to the writers of the files it names.
import { buildCommits, type CommitSpec, type Frozen } from "../land/commitGroups.js";
import { isAncestor, replayOnto } from "../land/replay.js";
import { defaultMessage, freezeAndAttribute, makePlan, trailerFor, upstreamRef, type FrozenAttribution } from "../land/shipCheckout.js";
import type { SessionEdits } from "../land/attribute.js";
import type { RosterRow } from "../land/scan.js";
import * as fs from "node:fs";
import { execFileAsync } from "../proc.js";
import { git, gitTry } from "../wipSnapshot.js";
import type { FrozenChange } from "./flowChangeFile.js";
export { frozenChangeContext, writeFrozenChange, type FrozenChange } from "./flowChangeFile.js";

/** Whether `ref` (a codecast id, its 7-character short id, or the agent's own session id) names this session. */
export function sessionMatches(s: Pick<SessionEdits, "conversationId" | "sessionId">, ref: string): boolean {
  const r = ref.trim();
  if (!r) return false;
  if (s.sessionId === r) return true;
  const conv = s.conversationId ?? "";
  return !!conv && (conv === r || (r.length >= 7 && conv.startsWith(r)));
}

const idOf = (s: SessionEdits) => s.conversationId?.slice(0, 7) ?? s.sessionId.slice(0, 8);

/** Each path's last commit time on HEAD (ms); a path no commit holds is absent. */
async function lastCommitTimes(root: string, paths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const p of paths) {
    const t = Number(await git(root, ["log", "-1", "--format=%ct", "HEAD", "--", p]).catch(() => ""));
    if (t) out.set(p, t * 1000);
  }
  return out;
}

/** No changed file in the checkout was written by the session: it has nothing uncommitted here. */
export class NoSessionChange extends Error {
  constructor(root: string, session: string) {
    super(`No uncommitted change in ${root} was written by session ${session}`);
  }
}

/**
 * Fetched first, as a ship plan fetches, so the stale-copy guard and the replay read upstream as it is now. Offline,
 * slow or asking for credentials, it gives up and upstream reads as last fetched.
 */
async function fetchUpstream(root: string, upstream: string): Promise<void> {
  if (upstream !== "HEAD") await fetchRef(root, upstream.split("/")[0], upstream.split("/").slice(1).join("/")).catch(() => {});
}

/** A fetch that gives up after a minute and never prompts for credentials. */
function fetchRef(root: string, remote: string, refspec: string) {
  return execFileAsync("git", ["-C", root, "fetch", "--quiet", remote, refspec], { encoding: "utf-8", timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

/**
 * The upstream commit when it already holds every one of `paths` at its frozen content, so the change has nothing
 * left to land; else null. A checkout already holding upstream is not asked: there a match means its own commits
 * moved the file and the change moves it back.
 */
async function landedOn(root: string, frozen: Frozen, upstream: string, paths: string[]): Promise<string | null> {
  const upstreamSha = upstream === "HEAD" ? null : await gitTry(root, ["rev-parse", `${upstream}^{commit}`]);
  if (!upstreamSha || !paths.length || (await isAncestor(root, upstreamSha, frozen.base))) return null;
  const theirs = new Map(((await gitTry(root, ["ls-tree", "-r", "-z", upstreamSha, "--", ...paths])) ?? "").split("\0").filter(Boolean).map((l) => {
    const tab = l.indexOf("\t");
    return [l.slice(tab + 1), l.slice(0, tab).split(" ")[2]] as const;
  }));
  const ours = new Map(frozen.changes.map((c) => [c.path, c.blob]));
  return paths.every((p) => (ours.get(p) ?? null) === (theirs.get(p) ?? null)) ? upstreamSha : null;
}

/** Why a frozen file stays out of every change (a credential, a stale copy), or undefined when it can go in. */
const heldReason = ({ credentials, stale }: Pick<FrozenAttribution, "credentials" | "stale">) =>
  (p: string) => credentials.get(p) ?? (stale.has(p) ? `a stale copy: ${stale.get(p)!.reason}` : undefined);

/**
 * Commit each spec's files at their frozen content on top of the checkout's
 * HEAD (the base their content grew from, so the diff reverts nothing), then
 * replay that onto the fetched upstream with the checkout's own unlanded
 * commits, as a ship does, and point `branch` at the result. When the replay
 * conflicts the branch stays on the HEAD-based commits and the change records
 * it is `behind`, for a later stage to resolve. The shared tree, its index and
 * HEAD are untouched.
 */
async function cutChange(root: string, frozen: Frozen, upstream: string, specs: CommitSpec[], branch: string): Promise<Pick<FrozenChange, "base" | "tip" | "behind">> {
  const { tip: onHead } = await buildCommits(root, frozen, specs);
  let [base, tip] = [frozen.base, onHead];
  let behind: FrozenChange["behind"];
  const upstreamSha = upstream === "HEAD" ? null : await gitTry(root, ["rev-parse", `${upstream}^{commit}`]);
  if (upstreamSha && !(await isAncestor(root, upstreamSha, frozen.base))) {
    // A throw is a history the replay cannot carry (a merge commit in the checkout's own) or merge-tree failing, not a conflict.
    const replayed = await replayOnto(root, upstreamSha, onHead, upstreamSha)
      .catch((err: Error) => ({ ok: false as const, why: "unreplayable" as const, conflicts: [] as string[], reason: err.message }));
    if (replayed.ok) [base, tip] = [upstreamSha, replayed.tip];
    else behind = { upstream: upstreamSha, why: "why" in replayed ? replayed.why : "conflict", conflicts: replayed.conflicts, reason: replayed.reason };
  }
  await git(root, ["update-ref", `refs/heads/${branch}`, tip]);
  return { base, tip, ...(behind ? { behind } : {}) };
}

/** What a session's change would hold, read from the frozen tree: its files, the ones another session also wrote, and the ones held out. */
export async function previewSessionChange(root: string, session: string, only?: ReadonlyArray<string> | null, opts: { fetch?: boolean } = {}) {
  // Without an upstream, HEAD stands in: stale copies are still read from its history.
  const upstream = await upstreamRef(root).catch(() => "HEAD");
  if (opts.fetch !== false) await fetchUpstream(root, upstream);
  const { frozen, attribution, credentials, stale } = await freezeAndAttribute(root, upstream);
  const heldWhy = heldReason({ credentials, stale });
  const mine = attribution.sessions.find((s) => sessionMatches(s, session));
  if (!mine) throw new NoSessionChange(root, session);
  // A write is in a file's uncommitted diff only when it came after the file's last commit.
  const committedAt = await lastCommitTimes(root, frozen.changes.map((c) => c.path));
  const inDiff = (s: SessionEdits, p: string) => (s.edits.get(p) ?? 0) > (committedAt.get(p) ?? 0);
  // A session that changed more than this change names the files that belong to it (globs, repo-relative).
  const globs = (only ?? []).map((g) => new Bun.Glob(g));
  const wrote = frozen.changes.map((c) => c.path).filter((p) => inDiff(mine, p) && (!globs.length || globs.some((g) => g.match(p))));
  const held = wrote.filter((p) => heldWhy(p)).map((p) => ({ path: p, why: heldWhy(p)! }));
  const paths = wrote.filter((p) => !heldWhy(p)).sort();
  const shared = paths
    .map((p) => ({ path: p, also: attribution.sessions.filter((s) => s !== mine && inDiff(s, p)).map(idOf) }))
    .filter((s) => s.also.length);
  const landed = await landedOn(root, frozen, upstream, paths);
  return { frozen, upstream, session: idOf(mine), conversation: mine.conversationId ?? null, agentSession: mine.sessionId, paths, shared, held, landed };
}

/**
 * Commit the files `session` wrote, at their frozen content, and cut them onto
 * the freshly fetched upstream on `branch` (cutChange). `fetched` says the
 * caller's preview just fetched, so this does not fetch again. Throws when the
 * session wrote nothing that is changed.
 */
export async function freezeSessionChange(root: string, session: string, opts: { branch: string; worktree: string; title?: string | null; only?: ReadonlyArray<string> | null; fetched?: boolean }): Promise<FrozenChange> {
  const { frozen, upstream, session: id, conversation, paths, shared, held, landed } = await previewSessionChange(root, session, opts.only, { fetch: !opts.fetched });
  if (!paths.length) throw new Error(`Session ${id} wrote nothing here that can go in a change${held.length ? ` (held: ${held.map((h) => `${h.path}, ${h.why}`).join("; ")})` : ""}`);
  const cut = await cutChange(root, frozen, upstream, [{ message: defaultMessage(opts.title ?? null, paths), paths }], opts.branch);
  return {
    source: "session", session: id, ...(conversation ? { conversation } : {}), ...cut, ...(landed ? { landed } : {}), branch: opts.branch, worktree: opts.worktree, paths, shared, held,
    ...(opts.only?.length ? { only: [...opts.only] } : {}), ...(opts.title ? { title: opts.title } : {}),
  };
}

/** The sessions' rows a pass's commit messages are titled from. */
export type Roster = (ids: string[]) => Promise<RosterRow[] | null>;

/** A roster read from the inbox through `call` (a cliPost); an unreadable inbox titles nothing. */
export function inboxRosterVia(call: (route: string, body: Record<string, unknown>) => Promise<any>): Roster {
  return async (ids) => {
    const read = await call("/cli/inbox", { session_ids: ids, show_all: true, limit: ids.length + 5 }).catch(() => null);
    return (read?.sessions ?? []).map((r: any): RosterRow => ({ short_id: String(r.id).slice(0, 7), title: r.short_title || r.title || null, work_state: r.work_state ?? null }));
  };
}

/** Nothing uncommitted in the checkout can ship: no change at all, or only held files. */
export class NoCheckoutChange extends Error {
  constructor(root: string, held: FrozenChange["held"]) {
    super(`Nothing uncommitted in ${root} can ship${held.length ? ` (held: ${held.map((h) => `${h.path}, ${h.why}`).join("; ")})` : ""}`);
  }
}

/**
 * What the whole checkout's change would hold, planned as `cast ship checkout`
 * plans a pass (makePlan): the shipping groups, one per session that wrote
 * files and one for files no session's edit names, each with its message, and
 * the files held out with why. `keep` narrows it to the files of a change
 * already frozen (a refreeze), given each file and the session that wrote it.
 * A pass needs an upstream to ship to, so a checkout without one is refused.
 */
export async function previewCheckoutChange(root: string, opts: { roster?: Roster; keep?: (path: string, conversation: string | null) => boolean; fetch?: boolean } = {}) {
  const upstream = await upstreamRef(root);
  if (opts.fetch !== false) await fetchUpstream(root, upstream);
  const fa = await freezeAndAttribute(root, upstream);
  const plan = await makePlan(root, { roster: opts.roster, fetch: false, frozen: fa });
  const keep = opts.keep ?? (() => true);
  const writerOf = (p: string) => fa.attribution.owners.get(p)?.conversationId ?? null;
  const groups = plan.groups
    .filter((g) => g.ship)
    .map((g) => ({ ...g, paths: g.paths.filter((p) => keep(p, writerOf(p))) }))
    .filter((g) => g.paths.length);
  const heldWhy = heldReason(fa);
  const held = plan.groups.filter((g) => !g.ship).flatMap((g) => g.paths).filter((p) => keep(p, writerOf(p))).map((p) => ({ path: p, why: heldWhy(p) ?? "held" }));
  const landed = await landedOn(root, fa.frozen, upstream, groups.flatMap((g) => g.paths));
  return { frozen: fa.frozen, upstream, groups, held, landed };
}

/**
 * Freeze the whole checkout's change: a commit per shipping group, with the
 * session trailer a ship pass adds for a team-visible session, cut onto the
 * freshly fetched upstream on `branch` (cutChange). `writers` maps each file to
 * the session that wrote it; a file no session's edit names has no entry.
 * Throws NoCheckoutChange when nothing can ship.
 */
export async function freezeCheckoutChange(root: string, opts: { branch: string; worktree: string; title?: string | null; roster?: Roster; keep?: (path: string, conversation: string | null) => boolean; fetched?: boolean }): Promise<FrozenChange> {
  const { frozen, upstream, groups, held, landed } = await previewCheckoutChange(root, { ...opts, fetch: !opts.fetched });
  if (!groups.length) throw new NoCheckoutChange(root, held);
  const cut = await cutChange(root, frozen, upstream, groups.map((g) => ({ message: g.message.trim() + trailerFor(g), paths: g.paths })), opts.branch);
  const writers: NonNullable<FrozenChange["writers"]> = {};
  for (const g of groups) {
    const conversation = g.session?.conversation_id;
    if (conversation) for (const p of g.paths) writers[p] = { conversation, session: g.session!.id ?? conversation.slice(0, 7) };
  }
  return {
    source: "checkout", ...cut, ...(landed ? { landed } : {}), branch: opts.branch, worktree: opts.worktree, paths: groups.flatMap((g) => g.paths).sort(), shared: [], held, writers,
    ...(opts.title ? { title: opts.title } : {}),
  };
}

/** The worktree that has `branch` checked out, or null. */
async function checkedOutAt(root: string, branch: string): Promise<string | null> {
  for (const entry of (await git(root, ["worktree", "list", "--porcelain"])).split("\n\n")) {
    const lines = entry.split("\n");
    if (lines.includes(`branch refs/heads/${branch}`)) return lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length) ?? null;
  }
  return null;
}

/**
 * Where a named branch stands now. A pull request's session pushes rather than commits here, so its branch is
 * fetched first, into origin's remote-tracking ref: a fetch into the branch itself is refused while a worktree (the
 * run's own, from an earlier stage) has it checked out. The local branch then follows: the worktree that has it
 * checked out is reset to the fetched tip, or the ref moves when none does. A worktree holding uncommitted work is
 * never reset, and neither a worktree other than the run's own (`runWorktree`) nor a branch no worktree holds moves
 * unless the fetched tip fast-forwards it, since that would drop its commits; the run's own holds no work, so it
 * follows a force-push too. A refusal, like a fetch that fails, is never read as "nothing new": each stops the
 * refreeze, saying why.
 */
async function branchTip(root: string, change: FrozenChange, runWorktree: string | null): Promise<string> {
  if (change.source !== "pr") return git(root, ["rev-parse", `refs/heads/${change.branch}`]);
  const tracking = `refs/remotes/origin/${change.branch}`;
  await fetchRef(root, "origin", `+refs/heads/${change.branch}:${tracking}`).catch((err: { stderr?: string; message: string }) => {
    throw new Error(`Could not fetch the pull request's branch ${change.branch} from origin: ${(err.stderr || err.message).trim()}`);
  });
  const tip = await git(root, ["rev-parse", tracking]);
  // The commits at `head` whose change the fetched tip does not carry: what moving `head` to it would drop. A commit
  // the tip holds an equivalent patch of (a rebase, force-pushed) is not lost (`git cherry` marks it "-").
  const lostFrom = async (head: string) => (await isAncestor(root, head, tip)) ? []
    : (await git(root, ["cherry", "-v", tip, head])).split("\n").filter((l) => l.startsWith("+ ")).map((l) => `${l.slice(2, 11)} ${l.slice(43)}`);
  const holder = await checkedOutAt(root, change.branch);
  if (!holder) {
    const current = await gitTry(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${change.branch}`]);
    const lost = current ? await lostFrom(current) : [];
    if (lost.length) throw new Error(`The pull request's branch ${change.branch} has commits here the pushed branch lacks (${lost.join("; ")}): moving it would drop them, so push them or move them to another branch first`);
    await git(root, ["update-ref", `refs/heads/${change.branch}`, tip]);
  } else {
    if (await git(holder, ["status", "--porcelain", "--untracked-files=no"])) {
      throw new Error(`The pull request's branch ${change.branch} is checked out in ${holder}, which holds uncommitted work: finish or clear it there, then the run can take the branch's new commits`);
    }
    const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
    const lost = !runWorktree || real(holder) !== real(runWorktree) ? await lostFrom(await git(holder, ["rev-parse", "HEAD"])) : [];
    if (lost.length) {
      throw new Error(`The pull request's branch ${change.branch} is checked out in ${holder}, which has commits the pushed branch lacks (${lost.join("; ")}): moving it would drop them, so push or move them there first`);
    }
    await git(holder, ["reset", "--quiet", "--hard", tip]);
  }
  return tip;
}

/** A checkout's change frozen again: its files and any file one of its writers now holds (a fix may add a test), cut per writer as before. */
async function refreezeCheckoutChange(root: string, before: FrozenChange, roster?: Roster): Promise<FrozenChange> {
  const paths = new Set(before.paths);
  const writers = new Set(Object.values(before.writers ?? {}).map((w) => w.conversation));
  const change = await freezeCheckoutChange(root, {
    branch: before.branch, worktree: before.worktree, title: before.title ?? null, roster,
    keep: (p, conversation) => paths.has(p) || (!!conversation && writers.has(conversation)),
  });
  // The session the run was started from stays its subject: it hears findings that name none of the change's files.
  return { ...change, ...(before.session ? { session: before.session } : {}), ...(before.conversation ? { conversation: before.conversation } : {}) };
}

/**
 * Freeze a session's change again, after the session worked on what a stage
 * found (flows.md FL4): the same files cut the same way, on the same branch, so
 * the run's worktree follows the new tip and every later stage reads the change
 * as it stands now. A checkout's change is frozen again from the checkout as it
 * is now (refreezeCheckoutChange). Returns the new change and whether anything moved.
 */
export async function refreezeSessionChange(root: string, runDir: string, worktreePath: string | null, opts: { roster?: Roster } = {}): Promise<{ change: FrozenChange; moved: boolean }> {
  const { readFrozenChange, writeFrozenChange } = await import("./flowChangeFile.js");
  const before = readFrozenChange(runDir);
  if (!before || (!before.session && before.source !== "checkout")) throw new Error("The run's change did not come from a session, so there is no session's change to freeze again");
  // A named branch or pull request is the change: the session fixes it by committing there (a pull request's by pushing).
  const change: FrozenChange = before.source === "checkout"
    ? await refreezeCheckoutChange(root, before, opts.roster)
    : before.source === "session"
    ? await freezeSessionChange(root, before.conversation ?? before.session!, { branch: before.branch, worktree: before.worktree, title: before.title ?? null, only: before.only ?? null })
    : { ...before, tip: await branchTip(root, before, worktreePath) };
  const tree = (rev: string) => git(root, ["rev-parse", `${rev}^{tree}`]).then((s) => s.trim()).catch(() => rev);
  const moved = (await tree(before.tip)) !== (await tree(change.tip));
  // The run's worktree holds no work of its own: it is the change, so it follows the new tip.
  if (worktreePath) await git(worktreePath, ["reset", "--quiet", "--hard", change.tip]);
  writeFrozenChange(runDir, change);
  return { change, moved };
}
