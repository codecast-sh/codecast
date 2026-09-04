// Sync-scope rules shared by the sync loop, the reconciliation loop, AND
// `cast doctor` (which must place its self-test transcript somewhere the sync
// loop will accept). Kept in its own leaf module (no daemon deps) so all of
// them import the SAME rule without a circular import — and so the CLI bundle
// doesn't pull in the whole daemon. If any two of these ever disagree about
// which files are in scope, reconciliation "repairs" files the sync loop
// refuses to sync — writing zombie zero-position ledger entries that surface
// forever as phantom "stuck syncs" (file changed, never synced, "last sync
// 20618 days ago").

import * as path from "node:path";
import { dirFilterByDepth } from "./fsWalk.js";
import type { Config } from "./config/types.js";

export const CLAUDE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where Claude Code writes transcripts: ~/.claude/projects. */
export function claudeProjectsDir(): string {
  return path.join(process.env.HOME || "", ".claude", "projects");
}

// Integration tests (daemon.inject-clear.test.ts) drive a REAL claude under a
// throwaway project dir, so its transcript lands in ~/.claude/projects like any
// other and would otherwise be synced as a phantom inbox conversation. The dir
// name carries this marker; both loops refuse any path containing it. A single
// lowercase token (no dots or hyphens) so it survives both the exact recorded-cwd
// resolution AND the lossy dir-name slug decode (where every "/" and "." collapses
// to "-"). Enforced on every machine regardless of the user's excluded_paths config.
export const TEST_SCRATCH_DIRNAME = "codecasttestscratch";

export function isTestScratchPath(projectPath: string): boolean {
  return !!projectPath && projectPath.includes(TEST_SCRATCH_DIRNAME);
}

export function isPathExcluded(projectPath: string, excludedPaths?: string): boolean {
  if (!excludedPaths || !projectPath) {
    return false;
  }

  const paths = excludedPaths.split(',').map(p => p.trim()).filter(p => p.length > 0);

  for (const excludedPath of paths) {
    const normalizedExcluded = path.resolve(excludedPath);
    const normalizedProject = path.resolve(projectPath);

    if (normalizedProject.startsWith(normalizedExcluded)) {
      return true;
    }
  }

  return false;
}

export function isProjectAllowedToSync(projectPath: string, config: Config): boolean {
  if (isTestScratchPath(projectPath)) {
    return false;
  }
  if (!config.sync_mode || config.sync_mode === "all") {
    return true;
  }

  if (!config.sync_projects || config.sync_projects.length === 0) {
    return false;
  }

  const normalizedProject = path.resolve(projectPath);
  return config.sync_projects.some(allowed => {
    const normalizedAllowed = path.resolve(allowed);
    return normalizedProject === normalizedAllowed || normalizedProject.startsWith(normalizedAllowed + path.sep);
  });
}

// Marker substrings produced by the test harness (`messagingHarness.ts` →
// `codecast-test-cwd-`, `fakeClaudeShim.ts` → `codecast-fake-claude-`).
// These tmpdirs end up under ~/.claude/projects/<encoded-cwd>/ when tests
// run, and without filtering the daemon would upload them to the user's
// production Convex inbox. Tests that need a real session-watcher event
// loop should pick a neutral project dir name.
const TEST_PROJECT_MARKERS = ["codecast-test-cwd-", "codecast-fake-claude-"];

export function isTestProjectDir(projectDirName: string): boolean {
  return TEST_PROJECT_MARKERS.some(m => projectDirName.includes(m));
}

// Dynamic-workflow run snapshot: <projectDir>/<session>/workflows/wf_<id>.json
// (the runtime materializes the whole run here; the daemon ingests it for the dash).
export function isWorkflowSnapshot(relativePath: string): boolean {
  const parts = relativePath.split(path.sep);
  if (parts.length < 2) return false;
  const base = parts[parts.length - 1];
  return parts[parts.length - 2] === "workflows"
    && parts[parts.length - 3] !== "subagents"
    && /^wf_.*\.json$/.test(base);
}

// Dynamic-workflow per-agent transcript:
// <projectDir>/<session>/subagents/workflows/<wf_runId>/agent-<id>.jsonl
// These sync as regular subagent conversations (session_id = filename base), which is
// what makes workflow agent sessions clickable in the run UI. Matched explicitly —
// NOT via the generic .jsonl rule — so raising the watch depth doesn't sweep in other
// deep files (e.g. the runtime's journal.jsonl alongside them).
export function isWorkflowAgentTranscript(relativePath: string): boolean {
  const parts = relativePath.split(path.sep);
  return parts.length === 6
    && parts[2] === "subagents"
    && parts[3] === "workflows"
    && /^agent-.+\.jsonl$/.test(parts[5]);
}

// Single source of truth for what the watcher (and the priming scan) considers a
// syncable file. Plain .jsonl matching keeps its historical depth (session transcripts
// and Task-tool subagents, <= 4 segments); deeper paths must match a specific shape.
export function watchFilter(relativePath: string): boolean {
  const depth = relativePath.split(path.sep).length;
  return (relativePath.endsWith(".jsonl") && depth <= 4)
    || isWorkflowSnapshot(relativePath)
    || isWorkflowAgentTranscript(relativePath);
}

// Whether the walk should enter a directory: only one that can hold a file
// watchFilter accepts. Without this the priming walk and every rescan read
// each session's tool-results, memory, session-memory and checkpoint dirs
// (1510 tool-results dirs on one machine, 3696 dirs walked for 2074 useful)
// and merely discarded what they found.
//   <slug>/                                   any project
//   <slug>/<uuid>/                            a session's own dir
//   <slug>/<uuid>/subagents|workflows/        Task subagents, run snapshots
//   <slug>/<uuid>/subagents/workflows/wf_*/   workflow agent transcripts
export const watchDirFilter = dirFilterByDepth(
  () => true,
  (seg) => CLAUDE_UUID_RE.test(seg),
  (seg) => seg === "subagents" || seg === "workflows",
  (seg, parts) => parts[2] === "subagents" && seg === "workflows",
  (seg, parts) => parts[2] === "subagents" && parts[3] === "workflows" && seg.startsWith("wf_"),
);

// Under ~/.claude/projects, whether a path is one the live watcher refuses.
// The sweeps (startup, wake recovery, reconciliation) walk the same tree with a
// bare ".jsonl" rule, which also matched the dynamic-workflow runtime's
// journal.jsonl: they synced it as a subagent conversation and wrote a ledger
// row the watcher then never advanced, so `cast status` reported it as a
// stuck sync forever. Paths outside the tree are another watcher's business
// and are never refused here.
export function isClaudeTranscriptOutOfWatchScope(filePath: string): boolean {
  const rel = path.relative(claudeProjectsDir(), filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return !watchFilter(rel);
}
