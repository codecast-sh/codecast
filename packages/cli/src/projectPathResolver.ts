import * as fs from "fs";
import * as path from "path";

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
