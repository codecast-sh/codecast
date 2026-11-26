// The workspace a directory's flows belong to (flows.md FL2). The personal Ship is only ever the answer when it is
// established: the calling session (if any) is stamped personal, the server's rule on the git_root the daemon syncs a
// session with stamps personal (convex privacy.ts resolveTeamForPath, through the shared matchDirectoryMapping;
// gitLocation.ts), no team rule touches the checkout at all, and no team the person is in already knows its
// repository (convex workflows.ts workspaceFactsForCli). Anything else resolves as it always has: the team the
// listing maps the directory to, else the active workspace. A session's team stamp only rules personal out; it never
// picks a team.
import * as path from "node:path";
import { matchDirectoryMapping, type DirectoryRuleFacts } from "@codecast/shared/team/directoryRules";
import type { Workspace } from "./resolveWorkspace.js";

export type DirectoryRule = DirectoryRuleFacts & { team_id: string | null };

/** A /cli/teams/projects row: a folder with sessions, or a rule's folder, with the rule's team. */
type ProjectRow = { path: string; team_id: string | null; private?: boolean };

/** Where a directory's flows are read: the workspace, whether its default flow is this directory's (not so for the
 *  active team standing in for a directory it does not map), and whether it ships through the personal Ship. */
export type DirectoryWorkspace = { ws: Workspace; ownsDefault: boolean; personal: boolean };

/** Where the daemon says a session here sits: its git_root (a worktree's main checkout) and origin's `owner/name`. */
export type CheckoutAt = { root: string | null; repository: string | null };

export type DirectoryIO = {
  /** A CLI route read; it throws when the server cannot answer. */
  post: (route: string, body: Record<string, unknown>) => Promise<any>;
  /** The session this runs inside (its codecast id or agent session id), when there is one. */
  session: string | undefined;
  /** An agent runs this but no session id resolved for it: its stamp cannot be known, so personal is not established. */
  sessionUnknown?: boolean;
  cwd: string;
  /** The workspace this shell reads when nothing names one (the active team, else personal). */
  active: () => Promise<Workspace>;
  location: () => Promise<CheckoutAt>;
  /** Other sessions the run's change comes from (`cast flow run --session <id>`, a task's change session), read only
   *  once the checkout reads personal: each must be stamped personal too. */
  subjects?: () => Promise<ReadonlyArray<string>>;
};

/** The facts only the server holds (/cli/workflows/workspace-facts): the calling session's stamp, and whether a team
 *  the person is in already knows the checkout's repository (a teammate's published checkout, a pull request). */
type Facts = { workspace: string | null; team_repository: boolean; in_team?: boolean };

export async function directoryWorkspace(io: DirectoryIO): Promise<DirectoryWorkspace> {
  // The listing beside the checkout read and then the server's facts about it. A listing that cannot be read stops
  // the read, saying so, as it always has; facts that cannot be read leave personal unestablished.
  const [read, { at, facts }] = await Promise.all([
    io.post("/cli/teams/projects", { limit: 30 }),
    io.location().catch(() => null).then(async (at) => ({
      at,
      facts: await io.post("/cli/workflows/workspace-facts", { ...(io.session ? { session: io.session } : {}), ...(at?.repository ? { repository: at.repository } : {}) }).then(
        (r): Facts | null => (r && (typeof r.workspace === "string" || r.workspace === null) && typeof r.team_repository === "boolean" ? r : null),
        () => null,
      ),
    })),
  ]);
  // Inside a session, only its own personal stamp lets the rule decide: one not yet synced may still be stamped with
  // its parent's team (privacy.ts inheritedChildPrivacy). With no session, the rule alone decides. A repository a team
  // already knows rules personal out.
  const established = !io.sessionUnknown && !!facts && facts.workspace === (io.session ? "personal" : null) && !facts.team_repository;
  // The personal Ship lands on origin, so a checkout with no origin repository is never personal.
  if (established && at?.repository && personalCheckout(read?.mappings, io.cwd, at, facts.in_team) && (await subjectsPersonal(io))) return { ws: { kind: "personal" }, ownsDefault: true, personal: true };
  const listed = listedTeam(read?.projects ?? [], io.cwd);
  return listed ? { ws: { kind: "team", teamId: listed }, ownsDefault: true, personal: false } : { ws: await io.active(), ownsDefault: false, personal: false };
}

/** Whether every other session the change comes from is stamped personal; one that cannot be read is not. */
async function subjectsPersonal(io: DirectoryIO): Promise<boolean> {
  const subjects = io.subjects ? await io.subjects().catch(() => null) : [];
  if (!subjects) return false;
  const stamps = await Promise.all(subjects.map((session) => io.post("/cli/workflows/workspace-facts", { session }).then((r) => r?.workspace, () => null)));
  return stamps.every((w) => w === "personal");
}

/**
 * Whether no team shares this checkout: the folder rules are known and the person has some (with none, the daemon
 * stamps the active team, so only a person in no team at all, `inTeam` false, is personal), the server's rule on the
 * git_root stamps personal, and no team rule touches the checkout:
 * none covers the directory, covers the git_root or sits inside it, and none names its repository. A second clone of a
 * team's repository outside every rule's folder, under a team rule that names no repository, passes here (the server
 * stamps its sessions personal too); the server's facts catch it when a team knows the repository.
 */
export function personalCheckout(rules: ReadonlyArray<DirectoryRule> | undefined, cwd: string, at: CheckoutAt, inTeam?: boolean): boolean {
  if (!Array.isArray(rules)) return false;
  if (rules.length === 0) return inTeam === false;
  const dir = path.resolve(cwd);
  const root = at.root ?? dir;
  const rule = matchDirectoryMapping([...rules], root, at.repository);
  if (rule && !rule.private && rule.team_id) return false;
  // These checks only rule personal out, so they read paths as the Mac's filesystem does (case-insensitive) and
  // repositories in any spelling.
  const fold = (p: string) => (process.platform === "darwin" ? p.toLowerCase() : p);
  const under = (p: string, prefix: string) => fold(p) === fold(prefix) || fold(p).startsWith(fold(prefix) + "/");
  const repository = at.repository?.toLowerCase();
  return !rules.some((r) => !r.private && !!r.team_id && (
    under(dir, r.path_prefix) || under(root, r.path_prefix) || under(r.path_prefix, root) || (!!repository && r.repository?.toLowerCase() === repository)
  ));
}

/** The team the listing maps the directory to, read as before the rules came with it: the longest covering row. */
export function listedTeam(projects: ReadonlyArray<ProjectRow>, cwd: string): string | null {
  const dir = path.resolve(cwd);
  const covering = projects
    .filter((p) => p.path && (dir === path.resolve(p.path) || dir.startsWith(path.resolve(p.path) + path.sep)))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return covering && !covering.private ? covering.team_id ?? null : null;
}

/** Where the daemon says a session in `cwd` sits (gitLocation.ts): its git_root and its origin's `owner/name`. */
export async function checkoutLocation(cwd: string): Promise<CheckoutAt> {
  const [{ getGitLocation }, { repositoryKeyOfRemote }] = await Promise.all([import("./gitLocation.js"), import("@codecast/shared/contracts")]);
  const loc = await getGitLocation(cwd);
  // A read that failed is not "no checkout": it leaves the directory undecided, never personal.
  if (!loc) throw new Error(`git could not read the checkout at ${cwd}`);
  return { root: loc.repoRoot || loc.root, repository: repositoryKeyOfRemote(loc.remoteUrl) };
}

/** The workspace session start reads a directory's flows from (stableContext.ts), with no session and no active team:
 *  session start never reads the active team, so in doubt no team is named. Null when the server cannot say. */
export async function sessionStartWorkspace(siteUrl: string, apiToken: string, dir: string): Promise<DirectoryWorkspace | null> {
  const post = async (route: string, body: Record<string, unknown>) => {
    const r = await fetch(`${siteUrl}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_token: apiToken, ...body }), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`${route}: ${r.status}`);
    return r.json();
  };
  return directoryWorkspace({ post, session: undefined, cwd: dir, active: async () => ({ kind: "personal" }), location: () => checkoutLocation(dir) }).catch(() => null);
}

/** Why a workflow must not run here: the shipped personal Ship, or a flow built on it (`shipsPersonal`,
 *  parser.ts reachesShippedFlow), lands on main with no pull request, so only a checkout established as personal runs
 *  it. A team's own `personal` is not the shipped one. Null to run. */
export async function shippedPersonalRefusal(shipsPersonal: boolean, where: () => Promise<DirectoryWorkspace>): Promise<string | null> {
  if (!shipsPersonal) return null;
  const personal = await where().then((at) => at.personal, () => false);
  return personal ? null : "this flow is the personal Ship or built on it, and this checkout is not established as personal (a team shares it, or that cannot be told): run change";
}

/**
 * The other sessions a run's change comes from, for directoryWorkspace (read only once the checkout reads personal),
 * and the checks that rule personal out before them: a task the run names that is a team's or cannot be read, and any
 * open team task a session here is bound to, under every id its pulse may be written under.
 */
export function runSubjects(io: { post: (route: string, body: Record<string, unknown>) => Promise<any>; task?: string; session?: string; pulseIds: ReadonlyArray<string | null | undefined> }): () => Promise<string[]> {
  return async () => {
    const task = io.task ? await io.post("/cli/work/get", { short_id: io.task }) : null;
    if (io.task && (!task || task.team_id)) throw new Error(`${io.task} is a team's task, or unreadable`);
    const { readTaskPulseFor } = await import("./taskPulse.js");
    const pulsed = [...new Set(io.pulseIds.map((id) => readTaskPulseFor(id)?.task).filter((t): t is string => !!t))];
    for (const short of pulsed) {
      const bound = await io.post("/cli/work/get", { short_id: short });
      if (!bound || (bound.team_id && bound.status !== "done" && bound.status !== "dropped")) throw new Error(`${short} is a team's task, or unreadable`);
    }
    const changeSession = task?.change_session?.conversation_id;
    return [...(io.session ? [io.session] : []), ...(typeof changeSession === "string" ? [changeSession] : [])];
  };
}
