// How a session's change enters a flow (docs/architecture/flows.md FL4). A
// session in a shared checkout leaves its edits uncommitted beside everyone
// else's; the flow runs on a commit of exactly that session's files, made from
// the frozen tree the way `cast ship checkout` makes its commits, on a branch
// of its own, so nothing in the shared tree moves. The commit is built on HEAD,
// the base its frozen content grew from, then replayed onto the freshly
// fetched upstream, so every stage tests the change on what it would land on.
//
// Every file the session wrote goes in. A file another session also changed
// goes in with only this session's lines when every writer's edits replay onto
// the committed file and together account for it (ownLines.ts); otherwise it
// goes in whole, carrying the other session's lines too, and the change names
// it as shared with why. Dropping a file the session wrote would run the flow
// on part of its change, which is worse than carrying a neighbour's edit the
// change names.
//
// A checkout's change (`cast flow run --checkout`) is the whole shared tree's
// uncommitted pass, cut the way `cast ship checkout` plans one: a commit per
// session that wrote files, one for files no session's edit names, credentials
// and stale copies held out. It records which session wrote each file, so a
// stage's finding goes to the writers of the files it names.
import { buildCommits, freezeWorktree, type CommitSpec, type Frozen } from "../land/commitGroups.js";
import { isAncestor, replayOnto } from "../land/replay.js";
import { credentialReason, defaultMessage, freezeAndAttribute, makePlan, trailerFor, upstreamRef, type FrozenAttribution } from "../land/shipCheckout.js";
import { treeDiff } from "../land/level.js";
import { findStaleCopies } from "../land/staleCopy.js";
import type { SessionEdits } from "../land/attribute.js";
import { readBlobs, type RosterRow } from "../land/scan.js";
import { spawnSync } from "../proc.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileAsync } from "../proc.js";
import { git, gitTry } from "../wipSnapshot.js";
import type { FrozenChange } from "./flowChangeFile.js";
import { ownVersion, sessionTranscripts, type Writer } from "./ownLines.js";
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

/** Each of `paths` that `commit` holds, with its blob; a path it lacks is absent. */
async function blobsAt(root: string, commit: string, paths: string[]): Promise<Map<string, string>> {
  return new Map(((await gitTry(root, ["ls-tree", "-r", "-z", commit, "--", ...paths])) ?? "").split("\0").filter(Boolean).map((l) => {
    const tab = l.indexOf("\t");
    return [l.slice(tab + 1), l.slice(0, tab).split(" ")[2]] as const;
  }));
}

/**
 * The upstream commit when it already holds every one of `paths` at its frozen content, so the change has nothing
 * left to land; else null. A checkout already holding upstream is not asked: there a match means its own commits
 * moved the file and the change moves it back.
 */
async function landedOn(root: string, frozen: Frozen, upstream: string, paths: string[]): Promise<string | null> {
  const upstreamSha = upstream === "HEAD" ? null : await gitTry(root, ["rev-parse", `${upstream}^{commit}`]);
  if (!upstreamSha || !paths.length || (await isAncestor(root, upstreamSha, frozen.base))) return null;
  const theirs = await blobsAt(root, upstreamSha, paths);
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
 * HEAD are untouched. `base` is where the ship's push starts (the change's
 * $diff_base): upstream, or where HEAD left it when the change is behind, so
 * a review sees the checkout's own unpushed commits the ship carries with it.
 */
async function cutChange(root: string, frozen: Frozen, upstream: string, specs: CommitSpec[], branch: string): Promise<Pick<FrozenChange, "base" | "tip" | "behind">> {
  const { tip: onHead } = await buildCommits(root, frozen, specs);
  let [base, tip] = [frozen.base, onHead];
  let behind: FrozenChange["behind"];
  const upstreamSha = upstream === "HEAD" ? null : await gitTry(root, ["rev-parse", `${upstream}^{commit}`]);
  if (upstreamSha && (await isAncestor(root, upstreamSha, frozen.base))) base = upstreamSha;
  else if (upstreamSha) {
    // A throw is a history the replay cannot carry (a merge commit in the checkout's own) or merge-tree failing, not a conflict.
    const replayed = await replayOnto(root, upstreamSha, onHead, upstreamSha)
      .catch((err: Error) => ({ ok: false as const, why: "unreplayable" as const, conflicts: [] as string[], reason: err.message }));
    if (replayed.ok) [base, tip] = [upstreamSha, replayed.tip];
    else {
      behind = { upstream: upstreamSha, why: "why" in replayed ? replayed.why : "conflict", conflicts: replayed.conflicts, reason: replayed.reason };
      base = (await gitTry(root, ["merge-base", frozen.base, upstreamSha])) ?? frozen.base;
    }
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
  const kept = wrote.filter((p) => !heldWhy(p)).sort();
  // A file another session also changed goes in with only this session's lines when every writer's replayed edits
  // account for it (ownLines.ts); one the session left as committed drops out. The rest go in whole, named as shared
  // with why.
  const transcriptsOf = new Map<SessionEdits, string[]>();
  const writer = (s: SessionEdits, p: string): Writer => {
    if (!transcriptsOf.has(s)) transcriptsOf.set(s, sessionTranscripts(s));
    return { id: idOf(s), transcripts: transcriptsOf.get(s)!, lastWrite: s.edits.get(p) ?? 0, client: s.client };
  };
  const cuts = new Map<string, string>();
  const unchanged = new Set<string>();
  const shared: FrozenChange["shared"] = [];
  for (const p of kept) {
    const others = attribution.sessions.filter((s) => s !== mine && inDiff(s, p));
    if (!others.length) continue;
    const change = frozen.changes.find((c) => c.path === p);
    const base = gitText(root, `${frozen.base}:${p}`);
    const now = change?.blob ? gitText(root, change.blob) : null;
    const own = base === undefined || now === undefined
      ? { ok: false as const, why: "it is not UTF-8 text" }
      : ownVersion({ root, rel: p, base, frozen: now, since: committedAt.get(p) ?? 0, mine: writer(mine, p), others: others.map((s) => writer(s, p)) });
    const blob = own.ok && own.content !== base ? spawnSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: own.content, encoding: "utf-8" }) : null;
    if (!own.ok) shared.push({ path: p, also: others.map(idOf), why: own.why });
    else if (!blob) unchanged.add(p);
    else if (blob.status !== 0) shared.push({ path: p, also: others.map(idOf), why: `its cut could not be stored: ${blob.stderr.trim()}` });
    else cuts.set(p, blob.stdout.trim());
  }
  const paths = kept.filter((p) => !unchanged.has(p));
  const cut = cuts.size ? { ...frozen, changes: frozen.changes.map((c) => (cuts.has(c.path) ? { ...c, blob: cuts.get(c.path)! } : c)) } : frozen;
  const landed = await landedOn(root, cut, upstream, paths);
  return { frozen: cut, upstream, session: idOf(mine), conversation: mine.conversationId ?? null, agentSession: mine.sessionId, paths, shared, held, landed };
}

/**
 * A blob's text (`<rev>:<path>` or a blob id): null when there is none, undefined when it is not UTF-8, since a
 * lossy decode would write different bytes back on the lines nobody touched.
 */
function gitText(root: string, spec: string): string | null | undefined {
  const r = spawnSync("git", ["-C", root, "cat-file", "blob", spec], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(r.stdout); } catch { return undefined; }
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

/** Whether a changed file belongs to a refrozen pass: yes, no, or held out for the reason given. */
type Keep = (path: string, conversation: string | null, changed: Array<{ path: string; conversation: string | null }>) => boolean | string;

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
 * already frozen (a refreeze), given each file, the session that wrote it and
 * every changed file with its writer; a reason it returns holds the file out
 * with that reason. A pass needs an upstream to ship to, so a checkout without
 * one is refused.
 */
export async function previewCheckoutChange(root: string, opts: { roster?: Roster; keep?: Keep; fetch?: boolean } = {}) {
  const upstream = await upstreamRef(root);
  if (opts.fetch !== false) await fetchUpstream(root, upstream);
  const fa = await freezeAndAttribute(root, upstream);
  const plan = await makePlan(root, { roster: opts.roster, fetch: false, frozen: fa });
  const writerOf = (p: string) => fa.attribution.owners.get(p)?.conversationId ?? null;
  const changed = plan.groups.flatMap((g) => g.paths).map((p) => ({ path: p, conversation: writerOf(p) }));
  const verdict = (p: string) => opts.keep ? opts.keep(p, writerOf(p), changed) : true;
  const groups = plan.groups
    .filter((g) => g.ship)
    .map((g) => ({ ...g, paths: g.paths.filter((p) => verdict(p) === true) }))
    .filter((g) => g.paths.length);
  const heldWhy = heldReason(fa);
  const held = [
    ...plan.groups.filter((g) => !g.ship).flatMap((g) => g.paths).filter((p) => verdict(p) !== false).map((p) => ({ path: p, why: heldWhy(p) ?? "held" })),
    ...plan.groups.filter((g) => g.ship).flatMap((g) => g.paths).flatMap((p) => { const v = verdict(p); return typeof v === "string" ? [{ path: p, why: v }] : []; }),
  ];
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
export async function freezeCheckoutChange(root: string, opts: { branch: string; worktree: string; title?: string | null; roster?: Roster; keep?: Keep; fetched?: boolean }): Promise<FrozenChange> {
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

/** A branch here holds commits origin never had: moving it to origin's tip would drop them. */
export class UnpushedCommitsError extends Error {}

/**
 * Bring origin's `branch` into the local branch of that name. A plain `fetch origin +b:b` is refused while a worktree
 * has `b` checked out (the run's own worktree does), so the tip is fetched alone and the ref moved with update-ref.
 * Origin's copy may be rewritten (each refreeze of a session's change force-pushes it), so the local branch may move
 * anywhere origin has been; what it never does is drop commits that only exist here. Those are commits neither in
 * origin's tip now nor in the tip last fetched from it (kept in refs/remotes/origin/<branch>, as originTip keeps it),
 * and they refuse the move with UnpushedCommitsError.
 */
export async function fetchBranch(root: string, branch: string): Promise<string> {
  const ref = (name: string) => git(root, ["rev-parse", "--verify", "--quiet", name]).then((s) => s.trim()).catch(() => "");
  const within = (rev: string, of: string) => !!of && git(root, ["merge-base", "--is-ancestor", rev, of]).then(() => true, () => false);
  // Read before the fetch: a clone's default refspec makes `fetch origin <ref>` move refs/remotes/origin/<branch> too.
  const fetched = await ref(`refs/remotes/origin/${branch}`);
  await git(root, ["fetch", "--quiet", "origin", `refs/heads/${branch}`]);
  const tip = (await git(root, ["rev-parse", "FETCH_HEAD"])).trim();
  const local = await ref(`refs/heads/${branch}`);
  if (local && local !== tip && !(await within(local, tip)) && !(await within(local, fetched))) {
    throw new UnpushedCommitsError(`${branch} here has commits origin does not (its tip ${local.slice(0, 10)}): moving it to origin's ${tip.slice(0, 10)} would drop them. Push them (git push origin ${branch}) or set them aside on another branch, then run this again`);
  }
  await git(root, ["update-ref", `refs/heads/${branch}`, tip]);
  await git(root, ["update-ref", `refs/remotes/origin/${branch}`, tip]);
  return tip;
}

/** Origin's tip of `branch`, fetched now; empty when origin has no such branch or cannot be reached. */
export async function originTip(root: string, branch: string): Promise<string> {
  const remoteRef = `refs/remotes/origin/${branch}`;
  await git(root, ["fetch", "--quiet", "origin", `+${branch}:${remoteRef}`]).catch(() => "");
  return git(root, ["rev-parse", "--verify", "--quiet", remoteRef]).catch(() => "");
}

/**
 * Where a named branch stands now, against what the run last froze. The session fixing it may be on another machine
 * (a run started over ssh), where its commit reaches this checkout only through origin. The run's worktree holds no
 * work of its own, so the side that moved since the freeze holds the fix: this checkout's branch off the frozen tip
 * first, else origin's off the tip it had then (`remote_tip`), rebased or force-pushed included.
 */
async function branchTip(root: string, change: FrozenChange): Promise<{ tip: string; remote_tip?: string }> {
  const [local, remote] = await Promise.all([
    git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${change.branch}`]).catch(() => ""),
    originTip(root, change.branch),
  ]);
  const pushed = !!remote && remote !== (change.remote_tip ?? "") && remote !== change.tip;
  const tip = local && local !== change.tip ? local : pushed ? remote : local || change.tip;
  return { tip, ...(remote ? { remote_tip: remote } : {}) };
}

/**
 * The upstream commit when it holds every one of `paths` as the checkout holds them now (a file gone from both is
 * held too), so a change with nothing left uncommitted (another pass shipped it, or the level sweep pulled it in) has
 * landed; else null.
 */
async function pathsLandedOn(root: string, paths: string[], tip: string): Promise<string | null> {
  const upstream = await upstreamRef(root).catch(() => "HEAD");
  const sha = upstream === "HEAD" ? null : await gitTry(root, ["rev-parse", `${upstream}^{commit}`]);
  if (!sha || !paths.length) return null;
  const theirs = await blobsAt(root, sha, paths);
  // A file cut to the session's own lines landed as the change's tip has it, while the checkout still holds another
  // session's lines beside them (ownLines.ts).
  const pushed = await blobsAt(root, tip, paths);
  for (const p of paths) {
    const ours = fs.existsSync(path.join(root, p)) ? await git(root, ["hash-object", "--", p]) : null;
    const upstreamHas = theirs.get(p) ?? null;
    if (ours !== upstreamHas && (pushed.get(p) ?? null) !== upstreamHas) return null;
  }
  return sha;
}

// A lockfile and the manifests whose change rewrites it.
const LOCKFILES: Record<string, string[]> = {
  "bun.lock": ["package.json"], "bun.lockb": ["package.json"], "package-lock.json": ["package.json"], "yarn.lock": ["package.json"],
  "pnpm-lock.yaml": ["package.json"], "Cargo.lock": ["Cargo.toml"], "Gemfile.lock": ["Gemfile"], "poetry.lock": ["pyproject.toml"],
  "uv.lock": ["pyproject.toml"], "go.sum": ["go.mod"],
};
// Directories a generator writes beside the sources it reads from their parent.
const GENERATED_DIRS = new Set(["_generated", "__generated__", "generated", "__snapshots__"]);
// Files a build writes at a repository's root.
const ROOT_GENERATED = new Set(["next-env.d.ts", "tsconfig.tsbuildinfo", ".pnp.cjs", ".pnp.loader.mjs", "worker-configuration.d.ts"]);

/**
 * The workspace members' directory patterns a JavaScript repository's root declares (package.json `workspaces`, as an
 * array or under `packages`, or pnpm-workspace.yaml's `packages`), or null when the root is no workspace root.
 */
function workspacePatterns(root: string): string[] | null {
  const read = (f: string) => { try { return fs.readFileSync(path.join(root, f), "utf-8"); } catch { return null; } };
  const pnpm = read("pnpm-workspace.yaml");
  if (pnpm !== null) {
    const listed = [...pnpm.matchAll(/^\s*-\s*['"]?([^'"#\s]+)['"]?/gm)].map((m) => m[1]).filter((g) => !g.startsWith("!"));
    return listed.length ? listed : null;
  }
  try {
    const ws = JSON.parse(read("package.json") ?? "{}").workspaces;
    const listed = (Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : []).filter((g: unknown): g is string => typeof g === "string" && !g.startsWith("!"));
    return listed.length ? listed : null;
  } catch {
    return null;
  }
}

/**
 * Whether a file no session's edit names, changed after a brief, is one a writer's shell made from what the writers
 * changed (`theirs`): a lockfile whose manifest a writer changed in its directory or below (at the root, the root's
 * own manifest, or in a workspace root any member's package.json, since an install there rewrites the one root
 * lockfile and a member's manifest shipped without it fails a frozen-lockfile install), a file beside a writer's changed source (the same directory, or a generator's directory whose
 * parent holds one), or a file a build writes at the root. Every session's work meets at the root, so a root file
 * is never made by a writer only because it sits beside one. Another session's `bun install` or codegen is neither.
 */
function madeByWriter(p: string, theirs: string[], workspaces: string[] | null): boolean {
  const dir = (f: string) => f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
  const base = (f: string) => f.slice(f.lastIndexOf("/") + 1);
  const under = (d: string, f: string) => d === "" ? dir(f) === "" : f.startsWith(`${d}/`);
  const manifests = LOCKFILES[base(p)];
  const member = (t: string) => dir(p) === "" && base(t) === "package.json" && !!workspaces?.some((g) => new Bun.Glob(g.replace(/\/+$/, "")).match(dir(t)));
  if (manifests) return theirs.some((t) => manifests.includes(base(t)) && (under(dir(p), t) || (manifests.includes("package.json") && member(t))));
  if (dir(p) === "") return ROOT_GENERATED.has(p) && theirs.length > 0;
  if (theirs.some((t) => dir(t) === dir(p))) return true;
  const segs = dir(p).split("/");
  return segs.some((seg, k) => GENERATED_DIRS.has(seg) && theirs.some((t) => under(segs.slice(0, k).join("/"), t)));
}

/**
 * A checkout's change frozen again: its files, any file one of its writers now holds (a fix may add a test), and,
 * when `since` is given (the brief went out then), any changed file no session's edit names that was written or
 * moved after it and that a writer's shell made from the writers' changes (madeByWriter: a lockfile, codegen output,
 * a `git mv` target with its source). A late file nothing of the writers' explains is held out with why, since it is
 * another session's `bun install` or codegen. Cut per writer as before. A pass whose files the checkout no longer
 * changes because upstream already holds them has landed: the change comes back as it was, with `landed` set.
 */
async function refreezeCheckoutChange(root: string, before: FrozenChange, roster?: Roster, since?: number): Promise<FrozenChange> {
  const paths = new Set(before.paths);
  const writers = new Set(Object.values(before.writers ?? {}).map((w) => w.conversation));
  // A rename keeps a file's mtime and moves its ctime.
  const touched = (p: string) => { try { const st = fs.lstatSync(path.join(root, p)); return Math.max(st.mtimeMs, st.ctimeMs); } catch { return 0; } };
  const lateShellWrite = (p: string) => since !== undefined && touched(p) > since;
  // A `git mv` source is gone, so nothing dates it: it goes with its target when the target goes.
  const movedTo = new Map<string, string>();
  if (since !== undefined) {
    const entries = ((await gitTry(root, ["status", "--porcelain=v1", "-z", "--untracked-files=no"])) ?? "").split("\0");
    for (let i = 0; i < entries.length; i++) {
      if (!/^R|^.R/.test(entries[i])) continue;
      movedTo.set(entries[i + 1], entries[i].slice(3));
      i++;
    }
  }
  const workspaces = workspacePatterns(root);
  const keep: Keep = (p, conversation, changed) => {
    if (paths.has(p) || (!!conversation && writers.has(conversation))) return true;
    if (conversation) return false;
    if (movedTo.has(p)) return keep(movedTo.get(p)!, null, changed) === true;
    if (!lateShellWrite(p)) return false;
    const theirs = changed.filter((c) => !!c.conversation && writers.has(c.conversation)).map((c) => c.path);
    return madeByWriter(p, theirs, workspaces) || "changed after the brief, and no writer's change makes it (not its manifest's lockfile, nor generated beside its source)";
  };
  // The session the run was started from stays its subject: it hears findings that name none of the change's files.
  const subject = { ...(before.session ? { session: before.session } : {}), ...(before.conversation ? { conversation: before.conversation } : {}) };
  try {
    const change = await freezeCheckoutChange(root, {
      branch: before.branch, worktree: before.worktree, title: before.title ?? null, roster,
      keep,
    });
    return { ...change, ...subject };
  } catch (err) {
    const landed = err instanceof NoCheckoutChange ? await pathsLandedOn(root, before.paths, before.tip) : null;
    if (!landed) throw err;
    return { ...before, landed };
  }
}

/** A session's change frozen again; one whose files upstream now holds as the checkout does comes back as it was, landed. */
async function refreezeOwnChange(root: string, before: FrozenChange): Promise<FrozenChange> {
  try {
    return await freezeSessionChange(root, before.conversation ?? before.session!, { branch: before.branch, worktree: before.worktree, title: before.title ?? null, only: before.only ?? null });
  } catch (err) {
    const landed = err instanceof NoSessionChange ? await pathsLandedOn(root, before.paths, before.tip) : null;
    if (!landed) throw err;
    return { ...before, landed };
  }
}

// What the run's worktree looked like when a brief last went out to the session that may fix the change there.
const BRIEF_TREE = "brief-tree";

/**
 * Record the run's worktree, as a git tree in the run's directory, before a brief goes out: a stage's finding names
 * that worktree, so the session may fix the change there and leave it uncommitted, and the refreeze carries whatever
 * differs from this record (refreezeSessionChange). What already differed is the run's own stations' writing. A
 * record already there is kept: a runner restarted mid-wait sends the brief again, and the session's edits from
 * before the restart are still its own. The refreeze removes it, so the next brief records afresh.
 */
export async function snapshotRunTree(tree: string, runDir: string): Promise<void> {
  const file = path.join(runDir, BRIEF_TREE);
  if (fs.existsSync(file)) return;
  const { tree: at } = await freezeWorktree(tree);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(file, `${at}\n`);
}

type TreeCarry = { head: string; commit: string; tree: string; held: FrozenChange["held"] };

// A lockfile, a generated directory's file, or a file a build writes at the root: kept only when a source beside it changed.
const generated = (p: string) => !!LOCKFILES[p.slice(p.lastIndexOf("/") + 1)] || ROOT_GENERATED.has(p) || p.split("/").slice(0, -1).some((s) => GENERATED_DIRS.has(s));

/**
 * The session's uncommitted edits in the run's worktree `tree`, committed on its HEAD off every ref: each file that
 * differs from the tree recorded at the brief (snapshotRunTree; from HEAD when none was recorded). A file a checkout's
 * change would hold out stays out here too, with why: a credential, a stale copy of an older version, or a lockfile or
 * generated file that nothing else the session changed there makes. Null when it changed nothing there. A tree off
 * the change's branch with such edits refuses: the reset would lose them.
 */
async function treeCarry(root: string, tree: string, runDir: string, change: FrozenChange): Promise<TreeCarry | null> {
  const now = await freezeWorktree(tree);
  const recorded = (() => { try { return fs.readFileSync(path.join(runDir, BRIEF_TREE), "utf-8").trim(); } catch { return null; } })();
  const since = recorded || (await git(tree, ["rev-parse", `${now.base}^{tree}`]));
  const touched = new Set((await treeDiff(tree, since, now.tree)).map((e) => e.path));
  const changes = now.changes.filter((c) => touched.has(c.path));
  if (!changes.length) return null;
  const on = await gitTry(tree, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (on !== change.branch) throw new Error(`The run's worktree ${tree} is ${on ? `on ${on}` : "on no branch"}, not the change's branch ${change.branch}, and holds uncommitted edits (${changes.map((c) => c.path).join(", ")}), so it is left as it is`);
  const held = new Map<string, string>();
  const texts = await readBlobs(tree, changes.map((c) => c.blob ?? ""));
  for (const c of changes) {
    const why = credentialReason(c.path, c.blob ? texts.get(c.blob) ?? null : null);
    if (why) held.set(c.path, why);
  }
  // A deletion is the session's own: nothing else touched the tree since the brief.
  const deleted = new Set(changes.filter((c) => !c.blob).map((c) => c.path));
  const upstream = await upstreamRef(root).catch(() => "HEAD");
  const stale = await findStaleCopies(tree, { base: now.base, tree: now.tree, upstream, changes: changes.filter((c) => !held.has(c.path)), wroteAt: (p) => (deleted.has(p) ? Date.now() : undefined) });
  for (const [p, s] of stale) held.set(p, `a stale copy: ${s.reason}`);
  const sources = changes.map((c) => c.path).filter((p) => !held.has(p) && !generated(p));
  const workspaces = workspacePatterns(tree);
  for (const c of changes) {
    if (!held.has(c.path) && generated(c.path) && !madeByWriter(c.path, sources, workspaces)) held.set(c.path, "a lockfile or generated file that nothing else the session changed in the run's worktree makes");
  }
  const paths = changes.map((c) => c.path).filter((p) => !held.has(p));
  const trailer = change.conversation ? trailerFor({ session: { conversation_id: change.conversation } }) : "";
  const { tip } = paths.length ? await buildCommits(tree, now, [{ message: `Edits left uncommitted in the run's worktree${trailer}`, paths }]) : { tip: now.base };
  return { head: now.base, commit: tip, tree: now.tree, held: [...held].map(([p, why]) => ({ path: p, why })) };
}

/** Replay `from..top` onto `onto`; a merge commit or a conflict refuses with why, and nothing moves. */
async function replayCarry(root: string, from: string, top: string, onto: string, against: string): Promise<string> {
  const replayed = await replayOnto(root, from, top, onto).catch((err: Error) => {
    throw new Error(`The run's worktree holds history the run cannot carry onto ${against} (${err.message}), so it is left as it is`);
  });
  if (!replayed.ok) throw new Error(`The edits in the run's worktree conflict with ${against} (${replayed.reason}), so it is left as it is`);
  return replayed.tip;
}

/**
 * A change frozen again from a checkout, with what the run's worktree holds over the last freeze replayed on top:
 * the session's commits and carried edits there (`top`), and those of earlier rounds (over `frozen_tip`), so a fix
 * made in the run's worktree stays in the change through every later refreeze. A change that came back as it was
 * (landed) with nothing new carried is returned as it is, landed only while upstream also holds what was carried.
 */
async function carryOntoFreeze(root: string, before: FrozenChange, change: FrozenChange, top: string): Promise<FrozenChange> {
  const asItWas = change.tip === before.tip;
  const under = asItWas ? before.frozen_tip ?? before.tip : change.tip;
  const from = asItWas ? before.tip : before.frozen_tip ?? before.tip;
  if (top === from) {
    const carried = before.carried ?? [];
    if (!change.landed || !carried.length) return change;
    const [ours, theirs] = await Promise.all([blobsAt(root, before.tip, carried), blobsAt(root, change.landed, carried)]);
    if (carried.every((p) => ours.get(p) === theirs.get(p))) return change;
    const { landed: _, ...rest } = change;
    return rest;
  }
  const tip = await replayCarry(root, from, top, change.tip, "the change frozen again from the checkout");
  if (tip === change.tip) return change;
  await git(root, ["update-ref", `refs/heads/${change.branch}`, tip]);
  const carried = (await git(root, ["diff", "--name-only", under, tip])).split("\n").filter(Boolean);
  const { landed: _, ...rest } = change;
  return { ...rest, tip, frozen_tip: under, carried };
}

/** Put the files a carry held out back in the worktree after its reset: they are the session's, never the change's. */
async function restoreHeld(tree: string, carry: TreeCarry): Promise<void> {
  const paths = carry.held.map((h) => h.path);
  if (!paths.length) return;
  const present = await blobsAt(tree, carry.tree, paths);
  const kept = paths.filter((p) => present.has(p));
  if (kept.length) await git(tree, ["--literal-pathspecs", "restore", `--source=${carry.tree}`, "--worktree", "--", ...kept]);
  for (const p of paths) if (!present.has(p)) fs.rmSync(path.join(tree, p), { force: true });
}

/**
 * Freeze a session's change again, after the session worked on what a stage
 * found (flows.md FL4): the same files cut the same way, on the same branch, so
 * the run's worktree follows the new tip and every later stage reads the change
 * as it stands now. A checkout's change is frozen again from the checkout as it
 * is now (refreezeCheckoutChange). What the session left uncommitted in the run's
 * worktree is carried first (treeCarry), and the branch moves only once all of it
 * is on the new tip. Returns the new change and whether anything moved.
 */
export async function refreezeSessionChange(root: string, runDir: string, worktreePath: string | null, opts: { roster?: Roster; since?: number } = {}): Promise<{ change: FrozenChange; moved: boolean }> {
  const { readFrozenChange, writeFrozenChange } = await import("./flowChangeFile.js");
  const before = readFrozenChange(runDir);
  if (!before || (!before.session && before.source !== "checkout")) throw new Error("The run's change did not come from a session, so there is no session's change to freeze again");
  const carry = worktreePath ? await treeCarry(root, worktreePath, runDir, before) : null;
  const head = carry?.head ?? (worktreePath ? await git(worktreePath, ["rev-parse", "HEAD"]) : before.tip);
  const top = carry?.commit ?? head;
  let change: FrozenChange;
  if (before.source === "checkout" || (before.source === "session" && !before.pushed)) {
    // The run's worktree held the change as last frozen: one reset or rebased there holds something else.
    if (!(await isAncestor(root, before.tip, head))) throw new Error(`The run's worktree is at ${head.slice(0, 10)}, which does not hold the change as last frozen (${before.tip.slice(0, 10)}): it was reset or rebased there, so it is left as it is`);
    change = before.source === "checkout" ? await refreezeCheckoutChange(root, before, opts.roster, opts.since) : await refreezeOwnChange(root, before);
    // The freeze has moved the branch: put it back where the worktree had it when the carry cannot go on top.
    change = await carryOntoFreeze(root, before, change, top).catch(async (err) => {
      await git(root, ["update-ref", `refs/heads/${before.branch}`, head]);
      throw err;
    });
  } else {
    // A named branch or pull request is the change: the session fixes it by committing there (a pull request's by
    // pushing). A tip pushed from elsewhere since takes what the session left here on top of it.
    change = { ...before, ...(await branchTip(root, before)) };
    if (top !== head) change.tip = change.tip === head ? top : await replayCarry(root, head, top, change.tip, `the branch's tip ${change.tip.slice(0, 10)}`);
  }
  if (carry?.held.length) change.held = [...change.held.filter((h) => !carry.held.some((c) => c.path === h.path)), ...carry.held];
  const tree = (rev: string) => git(root, ["rev-parse", `${rev}^{tree}`]).then((s) => s.trim()).catch(() => rev);
  const moved = (await tree(before.tip)) !== (await tree(change.tip));
  // The run's worktree holds no work of its own: it is the change, so it follows the new tip. What the reset puts
  // back is what the run's own stations wrote there before the brief.
  if (worktreePath) {
    await git(worktreePath, ["reset", "--quiet", "--hard", change.tip]);
    if (carry) await restoreHeld(worktreePath, carry);
  }
  writeFrozenChange(runDir, change);
  fs.rmSync(path.join(runDir, BRIEF_TREE), { force: true });
  return { change, moved };
}
