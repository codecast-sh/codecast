import * as fs from "fs";
import * as path from "path";

/**
 * Reproduce Claude Code's cwd → ~/.claude/projects/<dir> slug EXACTLY.
 *
 * Claude encodes the working directory by replacing every character that is not
 * a letter or digit with "-" (so "/", ".", and "_" all become "-"). A session
 * JSONL written under any other slug is invisible to `claude --resume`, which
 * scans only the project dir for its own cwd and then crashes with
 * "No conversation found with session ID". The previous `cwd.replace(/\//g,"-")`
 * handled "/" but left dots intact, so any cwd containing a dot — notably the
 * `.claude/worktrees/...` paths used by `cast ws`/orchestrate, or `~/.claude`
 * itself — landed in a dir Claude never reads.
 *
 * Verified against Claude 2.1.196:
 *   "/Users/a/.claude"  -> "-Users-a--claude"
 *   ".../outreach/.claude/worktrees/x" -> "...-outreach--claude-worktrees-x"
 *   "probe_x.y-z"       -> "probe-x-y-z"
 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export interface ResolveInput {
  // Recorded path from the conversation (often foreign — e.g. /Users/ec2-user/...)
  projectPath?: string | null;
  // Recorded git repo root for that conversation. Subpath of projectPath inside the
  // repo is preserved when remapping.
  gitRoot?: string | null;
  // git remote URL used to find candidate local checkouts
  gitRemoteUrl?: string | null;
  // Returns this user's known local git_root values for the same remote, in
  // most-recently-used order. The resolver filters to ones that exist on disk.
  findCandidates: (gitRemoteUrl: string) => Promise<string[]>;
  // Optional file-existence check (overridable for tests)
  exists?: (p: string) => boolean;
}

export interface ResolveResult {
  path: string;
  // true if we mapped a foreign path to a local checkout
  remapped: boolean;
  // human-readable explanation for logs / notifications
  reason: string;
}

const defaultExists = (p: string): boolean => {
  try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; }
};

// Resolves a (possibly foreign) project path to a path that exists on this
// machine. Used by:
//   * daemon `start_session` — for messages on conversations created elsewhere
//     (bot, EC2 host, another laptop)
//   * `cast fork --resume` — when forking someone else's conversation
//
// Returns null when no local checkout for the conversation's git remote can be
// found. Callers MUST NOT silently fall back to $HOME — refuse the operation
// and surface a clear error so the user can clone the repo locally.
export async function resolveLocalProjectPath(
  input: ResolveInput
): Promise<ResolveResult | null> {
  const exists = input.exists ?? defaultExists;
  const projectPath = input.projectPath?.trim() || null;
  const gitRoot = input.gitRoot?.trim() || null;
  const gitRemoteUrl = input.gitRemoteUrl?.trim() || null;

  // 1. Recorded path is valid here — use as-is. Same machine / same checkout.
  if (projectPath && exists(projectPath)) {
    return { path: projectPath, remapped: false, reason: "recorded path exists locally" };
  }

  // 2. Need a remote URL to look up alternative checkouts.
  if (!gitRemoteUrl) {
    return null;
  }

  // 3. The subpath inside the repo (e.g. "" or "/packages/foo") is preserved.
  const subpath = projectPath && gitRoot && projectPath.startsWith(gitRoot)
    ? projectPath.slice(gitRoot.length)
    : "";

  const candidates = await input.findCandidates(gitRemoteUrl);
  for (const candidate of candidates) {
    if (!candidate || !exists(candidate)) continue;
    const candidateFull = subpath ? path.join(candidate, subpath) : candidate;
    if (exists(candidateFull)) {
      return {
        path: candidateFull,
        remapped: true,
        reason: `remapped ${projectPath ?? "<unknown>"} → ${candidateFull} via remote ${gitRemoteUrl}`,
      };
    }
    // Subpath inside the candidate doesn't exist (e.g. branch-specific dir).
    // Falling back to the repo root is still valid; agent can cd from there.
    if (subpath) {
      return {
        path: candidate,
        remapped: true,
        reason: `remapped ${projectPath ?? "<unknown>"} → ${candidate} (subpath ${subpath} missing) via remote ${gitRemoteUrl}`,
      };
    }
  }

  return null;
}

export interface LocalRepoInput {
  /** The (possibly foreign) recorded path to resolve, e.g. /Users/m1/work/codecast/packages/cli */
  remotePath: string;
  /** $HOME for the convention search (~/src/<repo>, ~/projects/<repo>, …). */
  home: string;
  /** Explicit user mappings (config `project_mappings`): full-path OR basename → local path. */
  userMap?: Record<string, string> | null;
  /** Learned mappings the daemon has observed locally: full-path OR basename → local path. */
  learnedMap?: Record<string, string> | null;
  /** Container dirs under $HOME to probe. Defaults to src/projects/code/repos and $HOME itself. */
  conventionDirs?: string[];
  /** Directory-existence check (overridable for tests). */
  exists?: (p: string) => boolean;
  /** Invoked on a convention hit so the daemon can persist basename → local repo. */
  onLearn?: (basename: string, localPath: string) => void;
}

// Resolve a (possibly foreign) recorded path to a local one by repo CONVENTION —
// no git remote required. Used by the daemon for start_session, resume, and
// cross-machine forks.
//
// Walks the path from the LEAF up to the root. For each segment it tries to map
// that segment's basename to a local repo (explicit map, then learned map, then
// ~/<dir>/<name> convention) and re-appends the descendant subpath.
//
// Why walk up: a recorded path is frequently a SUBDIR inside a repo
// (/Users/m1/work/codecast/packages/cli). The leaf ("cli") is not the repo; an
// ancestor ("codecast") is. Trying only the leaf — the original behavior —
// refused these even though the repo IS checked out locally, which stamped a
// dead-end "clone it first" banner on brand-new sessions seeded from another
// machine's path.
//
// Safety: we walk DEEPEST segment first (the repo nests below its container
// dirs), and skip generic container/home segments so "work"/"src" can never
// masquerade as a repo. The first real repo match wins; when its subpath is
// absent locally we fall back to the repo root (the agent can cd from there),
// matching resolveLocalProjectPath.
const GENERIC_PATH_SEGMENTS = new Set([
  "work", "src", "code", "repos", "projects", "dev", "developer",
  "users", "home", "tmp", "documents", "desktop", "downloads",
]);

export function resolveLocalRepoPath(input: LocalRepoInput): string | null {
  const exists = input.exists ?? defaultExists;
  const remotePath = input.remotePath?.trim();
  if (!remotePath) return null;
  if (exists(remotePath)) return remotePath;

  // A torn-down worktree path. `cast ws`, orchestrate, and conductor place
  // worktrees under <repo>/.codecast|.claude|.conductor/...; once destroyed the
  // recorded cwd is gone but the session belongs to the PARENT repo. Resolve to
  // it directly when it still exists. Without this, the leaf walk below reaches
  // the ".claude" segment and resolveBase(".claude") matches $HOME/.claude
  // (which always exists), so every dead worktree resumed in ~/.claude — the
  // wrong directory, and the project then mislabels as the home dir. Only
  // reached because remotePath itself is already gone (checked above).
  const worktreeParent = remotePath.match(/^(.*?)\/\.(?:claude|codecast|conductor)(?:\/|$)/)?.[1];
  if (worktreeParent && worktreeParent !== input.home && exists(worktreeParent)) {
    return worktreeParent;
  }

  const maps = [input.userMap, input.learnedMap].filter(Boolean) as Record<string, string>[];
  // A full-path mapping is the most specific signal — honor it before walking.
  for (const map of maps) {
    const mapped = map[remotePath];
    if (mapped && exists(mapped)) return mapped;
  }

  const conventionDirs = input.conventionDirs ?? ["src", "projects", "code", "repos", ""];
  const home = input.home;

  const resolveBase = (name: string): string | null => {
    for (const map of maps) {
      const mapped = map[name];
      if (mapped && exists(mapped)) return mapped;
    }
    for (const dir of conventionDirs) {
      const candidate = dir ? `${home}/${dir}/${name}` : `${home}/${name}`;
      if (exists(candidate)) {
        input.onLearn?.(name, candidate);
        return candidate;
      }
    }
    return null;
  };

  const parts = remotePath.split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const name = parts[i];
    if (!name || GENERIC_PATH_SEGMENTS.has(name.toLowerCase())) continue;
    const base = resolveBase(name);
    if (!base) continue;
    const sub = parts.slice(i + 1);
    if (sub.length === 0) return base; // leaf names the repo itself (original behavior)
    const full = [base, ...sub].join("/");
    return exists(full) ? full : base; // deepest repo match wins; subpath optional
  }
  return null;
}

export interface ResumeCwdInput {
  /** Explicit caller override (e.g. a `cast remote move` worktree path). Wins if it exists. */
  cwdOverride?: string | null;
  /** The cwd recorded in the session transcript — authoritative for where it ran. */
  recordedCwd?: string | null;
  /** Convention/learned/user-mapping resolver (the daemon's resolveLocalRepo). */
  resolveLocalRepo: (p: string) => string | null;
  /** Remap via the conversation's git remote (resolveLocalProjectPath wrapper). Optional. */
  remapViaRemote?: () => Promise<string | null>;
  /** File-existence check (overridable for tests). */
  exists?: (p: string) => boolean;
}

// Resolve the directory a resumed/reconstituted session must run in — or null to
// REFUSE. Resolution order:
//   1. an explicit override that exists locally (remote-move worktree)
//   2. the recorded transcript cwd, if it exists locally (same machine — the
//      common case for every local resume)
//   3. the convention/learned/user-mapping resolver (forks, renamed checkouts)
//   4. a git-remote remap to a sibling checkout
//
// Returns null when none resolve. Callers MUST NOT fall back to $HOME: doing so
// runs the agent in the wrong directory AND mislabels the project as the home
// dir — `claude --resume` relocates the transcript under
// ~/.claude/projects/-Users-<home>/, and the daemon later decodes project_path
// from that slug (e.g. "/Users/m1"). Mirror start_session: surface "clone it
// first" and let the owning device handle it.
export async function resolveResumeCwd(input: ResumeCwdInput): Promise<string | null> {
  const exists = input.exists ?? defaultExists;

  const override = input.cwdOverride?.trim() || null;
  if (override && exists(override)) return override;

  const recorded = input.recordedCwd?.trim() || null;
  if (recorded) {
    if (exists(recorded)) return recorded;
    const viaLocal = input.resolveLocalRepo(recorded);
    if (viaLocal && exists(viaLocal)) return viaLocal;
  }

  if (input.remapViaRemote) {
    const viaRemote = await input.remapViaRemote();
    if (viaRemote && exists(viaRemote)) return viaRemote;
  }

  return null;
}

export interface PickProjectPathInput {
  /** decodeProjectDirName(slug) — the path implied by the ~/.claude/projects folder name. */
  decodedSlugPath: string;
  /** extractCwd(transcript head) — the cwd recorded inside the transcript. Authoritative. */
  recordedCwd?: string | null;
  /** process.env.HOME — the bare home dir is never a real project. */
  home?: string | null;
  /** Directory-existence check (overridable for tests). */
  exists?: (p: string) => boolean;
}

// Decide a discovered transcript's project_path from its folder SLUG vs the cwd
// recorded inside it.
//
// The transcript's `cwd` is authoritative — it's the physical directory the
// agent actually ran in. The slug (~/.claude/projects/<name>) is only a
// fallback: it's lossy ("/" and "." both encode to "-") and can be flat wrong
// when a transcript is copied or resumed into a FOREIGN dir. Canonical failure:
// a session offloaded to a remote Mac whose checkout was absent, so an old
// resume fell back to $HOME and wrote the JSONL under `-Users-<remoteuser>` →
// decodes to the bare home dir → mislabels the whole conversation as e.g.
// "/Users/m1". resolveResumeCwd now prevents NEW occurrences; this heals
// already-mislocated and cross-machine transcripts at sync time.
//
// Rule: a real, existing, non-$HOME slug dir wins — that keeps normal sessions
// and cross-machine forks (which live under a real project dir, even when their
// recorded cwd points at another machine) correctly labeled. Otherwise the
// transcript's own cwd wins. The decoded slug is the last resort.
export function pickProjectPath(input: PickProjectPathInput): string {
  const exists = input.exists ?? defaultExists;
  const decoded = input.decodedSlugPath;
  const home = input.home?.trim() || null;
  const recordedCwd = input.recordedCwd?.trim() || null;

  if (decoded && decoded !== home && exists(decoded)) return decoded;
  if (recordedCwd) return recordedCwd;
  return decoded;
}

export interface TranscriptCandidate {
  /** The ~/.claude/projects/<slug>/<uuid>.jsonl path. */
  filePath: string;
  /** resolveTranscriptProjectPath(filePath, slug) — the project this copy resolves to. */
  projectPath: string;
  /** Does projectPath exist as a directory on this machine? */
  projectExists: boolean;
}

export type TranscriptChoice =
  // `supersededFilePath` is set only when the incoming transcript replaces a
  // different prior copy that resolved to a non-existent dir (a promotion). It is
  // absent when there was no prior copy or when both copies are legitimately
  // syncing (ambiguous), so callers don't tear down a still-valid sibling.
  | { action: "sync"; reason: string; supersededFilePath?: string }
  | { action: "skip"; reason: string; canonicalFilePath: string };

// `claude --resume` copies the prior transcript into the new cwd's project dir,
// so a single session UUID can appear as two .jsonl files under two slugs — both
// watched, both syncing the SAME conversation (keyed by UUID), doubling write
// load. The stale copy is the remote-resume artifact: it lands under a slug that
// decodes to a foreign/home dir that does NOT exist locally (e.g. -Users-m1 ->
// /Users/m1), exactly the home-fallback path pickProjectPath already heals. The
// live copy lives under the real local checkout, so its projectPath exists.
//
// Decide whether an incoming transcript should be synced or skipped as a stale
// duplicate of an already-watched canonical file for the same UUID. CONSERVATIVE:
// only skip a copy whose project dir does NOT exist when the canonical one's
// DOES. If both exist, neither exists, or there is no prior file, sync (the
// server dedups by message_uuid, so syncing both is correct, just redundant).
// We never skip a transcript living in a real local checkout — message loss is
// never traded for reduced write load.
export function chooseSessionTranscript(
  incoming: TranscriptCandidate,
  canonical: TranscriptCandidate | undefined
): TranscriptChoice {
  if (!canonical || canonical.filePath === incoming.filePath) {
    return { action: "sync", reason: "no prior transcript for this session UUID" };
  }
  if (incoming.projectExists && !canonical.projectExists) {
    return {
      action: "sync",
      reason: `incoming resolves to real checkout ${incoming.projectPath}; prior ${canonical.filePath} resolves to non-existent ${canonical.projectPath} — incoming becomes canonical`,
      supersededFilePath: canonical.filePath,
    };
  }
  if (!incoming.projectExists && canonical.projectExists) {
    return {
      action: "skip",
      reason: `duplicate of ${canonical.filePath} (real checkout ${canonical.projectPath}); incoming resolves to non-existent ${incoming.projectPath} — stale resume artifact`,
      canonicalFilePath: canonical.filePath,
    };
  }
  return {
    action: "sync",
    reason: "two transcripts for the same UUID but neither is a clear stale artifact — sync both, server dedups",
  };
}
