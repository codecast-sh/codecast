/**
 * A repository's worktrees, published into the same repository cache the
 * branch list lives in (repoMirror.ts, convex repos.ingestLocal).
 *
 * GitHub knows a repository's branches; only a machine knows its checkouts. So
 * this row has no GitHub twin: each checkout publishes its own, and the pages
 * read every checkout's row together. It names every worktree git lists, says
 * who manages it (`cast ws`, Claude Code, or a plain `git worktree add`), adds
 * what `cast ws` recorded for the ones it manages (state, ports, the sessions
 * that acquired them) and the sessions running in each one right now.
 *
 * The row travels as a RepoMirror with one row and no commits, so the daemon
 * and `cast ws` both publish it through the ordinary ingestLocalRepo call.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { defaultBranchFor, repositoryKeyFor, runGit, tryGitLine, type GitRunner, type RepoMirror } from "./repoMirror.js";
import { WORKTREES_KIND, type WorktreeEntry, type WorktreeManager, type WorktreesPayload } from "@codecast/shared/contracts";
import { listStates } from "./workspace/contract.js";
import { defaultConfigDir, readAuthConfig } from "./config/readAuthConfig.js";
import { readLocalConversationMap } from "./localConversationMap.js";
import { deviceId, deviceLabel } from "./remote/device.js";
import { SyncService } from "./syncService.js";

/** Every worktree is listed; only this many get the per-worktree git reads. */
export const WORKTREE_DETAIL_CAP = 40;
export const WORKTREE_LIST_CAP = 300;
export const WORKTREE_SESSIONS_CAP = 20;

export interface WorktreeMirrorOptions {
  device_id?: string;
  device_label?: string;
  /**
   * Live sessions and where each runs; a session belongs to the deepest
   * worktree holding its cwd. `dirty` is the daemon's own status read for that
   * checkout (reportGitStates), so an occupied worktree is never read twice.
   */
  sessions?: Array<{ conversationId: string; cwd: string; dirty?: boolean }>;
  /** A session uuid `cast ws acquire` recorded, to its conversation id. */
  resolveSession?: (sessionId: string) => string | undefined;
  now?: () => number;
}

/** The main checkout behind any path inside a repository or one of its worktrees. */
export async function mainRootFor(cwd: string, run: GitRunner = runGit): Promise<string | null> {
  const common = await tryGitLine(run, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common) return null;
  return path.basename(common) === ".git" ? path.dirname(common) : null;
}

export function worktreeManagerFor(worktreePath: string): WorktreeManager {
  if (worktreePath.includes("/.codecast/worktrees/")) return "codecast";
  if (worktreePath.includes("/.claude/worktrees/")) return "claude";
  return "git";
}

/** `git worktree list --porcelain`: blank-line separated blocks, the main checkout first. */
export function parseWorktreeList(out: string): Array<Pick<WorktreeEntry, "path" | "branch" | "head_sha" | "locked" | "prunable">> {
  return out.split(/\n\s*\n/).flatMap((block) => {
    const entry: Partial<WorktreeEntry> = {};
    for (const line of block.split("\n")) {
      const [key, ...rest] = line.trim().split(" ");
      const value = rest.join(" ");
      if (key === "worktree") entry.path = value;
      else if (key === "HEAD") entry.head_sha = value;
      else if (key === "branch") entry.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "locked") entry.locked = true;
      else if (key === "prunable") entry.prunable = true;
    }
    return entry.path && entry.head_sha ? [entry as WorktreeEntry] : [];
  });
}

const inside = (dir: string, cwd: string) => cwd === dir || cwd.startsWith(`${dir}/`);

export async function buildWorktreeMirror(
  root: string,
  opts: WorktreeMirrorOptions = {},
  run: GitRunner = runGit,
): Promise<RepoMirror | null> {
  const listing = await run(root, ["worktree", "list", "--porcelain"]).catch(() => "");
  const listed = parseWorktreeList(listing);
  if (!listed.length) return null;
  const origin = await tryGitLine(run, root, ["remote", "get-url", "origin"]);
  const current = await tryGitLine(run, root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const defaultBranch = await defaultBranchFor(run, root, current);
  const states = new Map(listStates(root).map((s) => [s.path, s]));

  const knownDirty = new Map<string, boolean>();
  const sessionsIn = new Map<string, Set<string>>();
  const attach = (worktreePath: string, conversationId: string | undefined) => {
    if (!conversationId) return;
    const set = sessionsIn.get(worktreePath) ?? new Set();
    set.add(conversationId);
    sessionsIn.set(worktreePath, set);
  };
  for (const session of opts.sessions ?? []) {
    const home = listed.filter((w) => inside(w.path, session.cwd)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!home) continue;
    attach(home.path, session.conversationId);
    if (session.dirty !== undefined) knownDirty.set(home.path, session.dirty);
  }
  for (const state of states.values()) {
    for (const sessionId of state.sessions ?? []) attach(state.path, opts.resolveSession?.(sessionId));
  }

  const worktrees: WorktreeEntry[] = listed.slice(0, WORKTREE_LIST_CAP).map((w, index) => {
    const state = states.get(w.path);
    const sessions = [...(sessionsIn.get(w.path) ?? [])].sort().slice(-WORKTREE_SESSIONS_CAP);
    return {
      ...w,
      name: state?.name ?? path.basename(w.path),
      manager: worktreeManagerFor(w.path),
      ...(index === 0 ? { main: true } : {}),
      ...(state ? { state: state.state, ...(Object.keys(state.ports ?? {}).length ? { ports: state.ports } : {}) } : {}),
      ...(sessions.length ? { sessions } : {}),
    };
  });

  // The git reads cost a process each, and a busy repository holds hundreds of
  // agent worktrees: spend them on the main checkout, the ones `cast ws`
  // manages, and the ones a session is in.
  const detailed = worktrees
    .filter((w) => !w.prunable && (w.main || w.manager === "codecast" || w.sessions?.length))
    .slice(0, WORKTREE_DETAIL_CAP);
  // One worktree at a time: three processes, never three times the cap.
  for (const w of detailed) {
    const [status, counts, last] = await Promise.all([
      // The same read, with the same meaning, as the session header's dirty mark.
      knownDirty.has(w.path) ? (knownDirty.get(w.path) ? "dirty" : "") : run(w.path, ["status", "--porcelain"]).catch(() => undefined),
      w.main ? undefined : tryGitLine(run, root, ["rev-list", "--left-right", "--count", `${defaultBranch}...${w.head_sha}`]),
      tryGitLine(run, root, ["log", "-1", "--format=%ct%x00%s", w.head_sha]),
    ]);
    if (status !== undefined) w.dirty = !!status.trim();
    const [behind, ahead] = (counts ?? "").split(/\s+/).map(Number);
    if (Number.isFinite(ahead) && Number.isFinite(behind)) Object.assign(w, { ahead, behind });
    const [at, subject] = (last ?? "").split("\0");
    if (at) Object.assign(w, { committed_at: Number(at) * 1000, subject: subject ?? "" });
  }

  const payload: WorktreesPayload = {
    root,
    device_id: opts.device_id,
    device_label: opts.device_label,
    default_branch: defaultBranch,
    truncated: listed.length > WORKTREE_LIST_CAP,
    sessions_live: !!opts.sessions,
    worktrees,
    at: (opts.now ?? Date.now)(),
  };
  return {
    repository: repositoryKeyFor(root, origin),
    remote_url: origin || undefined,
    default_branch: defaultBranch,
    head_sha: worktrees[0].head_sha,
    // The server keys this row by publisher and root, so checkouts never overwrite each other.
    rows: [{ kind: WORKTREES_KIND, ref: "", path: root, content: JSON.stringify(payload) }],
    commits: [],
  };
}

/** What changed, ignoring when it was read: the daemon publishes only when this moves. */
export function worktreeFingerprint(mirror: RepoMirror): string {
  const { at: _at, ...stable } = JSON.parse(mirror.rows[0].content) as WorktreesPayload;
  return createHash("sha1").update(JSON.stringify(stable)).digest("hex");
}

const PUBLISH_BUDGET_MS = 5000;

/**
 * Publish a repository's worktrees now, from a command that just changed one
 * (`cast ws acquire`, `heal`, `destroy`), so the pages show it at once instead
 * of at the daemon's next sweep. Best effort within a small budget: the
 * command's own work is done, and the sweep repairs a publish that missed.
 */
export async function publishWorktrees(cwd: string): Promise<void> {
  const publish = async () => {
    const config = readAuthConfig(defaultConfigDir());
    const root = await mainRootFor(cwd);
    if (!config?.auth_token || !config.convex_url || !root) return;
    const sessions = readLocalConversationMap();
    const mirror = await buildWorktreeMirror(root, { device_id: deviceId(), device_label: deviceLabel(), resolveSession: (id) => sessions[id] });
    if (!mirror) return;
    const service = new SyncService({ convexUrl: config.convex_url, authToken: config.auth_token, userId: config.user_id });
    await service.ingestLocalRepo({ root, device_label: deviceLabel(), ...mirror });
  };
  await Promise.race([publish().catch(() => {}), new Promise((resolve) => setTimeout(resolve, PUBLISH_BUDGET_MS).unref?.())]);
}
