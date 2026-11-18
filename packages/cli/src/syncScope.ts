// Sync-scope rules shared by the sync loop, the reconciliation loop, AND
// `cast doctor` (which must place its self-test transcript somewhere the sync
// loop will accept). Kept in its own leaf module (no daemon deps) so all of
// them import the SAME rule without a circular import — and so the CLI bundle
// doesn't pull in the whole daemon. If any two of these ever disagree about
// which files are in scope, reconciliation "repairs" files the sync loop
// refuses to sync — writing zombie zero-position ledger entries that surface
// forever as phantom "stuck syncs" (file changed, never synced, "last sync
// 20618 days ago").

import * as fs from "node:fs";
import * as path from "node:path";
import { codecastPath } from "./codecastDir.js";
import { dirFilterByDepth } from "./fsWalk.js";
import { checkoutRootOf } from "./fs/checkoutOf.js";
import type { Config } from "./config/types.js";
import { managedExcludedPaths } from "./config/managedPolicy.js";
import { folderCovers, folderCoversOnAnyMachine } from "@codecast/shared/team/folderLists";
import { TEST_SCRATCH_DIRNAME, isTestArtifactPath } from "@codecast/shared/contracts";

export { TEST_SCRATCH_DIRNAME, isTestArtifactPath };

export const CLAUDE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where Claude Code writes transcripts: ~/.claude/projects. */
export function claudeProjectsDir(): string {
  return path.join(process.env.HOME || "", ".claude", "projects");
}

export function isPathExcluded(projectPath: string, excludedPaths?: string): boolean {
  if (!projectPath) return false;
  // Folders an organization's policy keeps on the device (config/managedPolicy.ts)
  // are out whatever the person's own list or sync mode says, worktrees with them.
  if (inFolderList(managedExcludedPaths(), projectPath)) return true;
  if (!excludedPaths) {
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

/** A folder is in a list when it is one of them or sits below one; a
 *  worktree outside its checkout (Codex keeps them under ~/.codex/worktrees)
 *  counts as its checkout, the same reach a sharing rule has. The person's
 *  own sync lists (`anyMachine`) are shared by all their machines, so an entry
 *  written on one covers the same place under home on this one. */
function inFolderList(list: string[] | undefined, projectPath: string, anyMachine = false): boolean {
  if (!list || list.length === 0) return false;
  const match = anyMachine ? folderCoversOnAnyMachine : folderCovers;
  const covers = (p: string) => list.some(entry => match(p, path.resolve(entry)));
  const normalizedProject = path.resolve(projectPath);
  if (covers(normalizedProject)) return true;
  const checkout = checkoutRootOf(normalizedProject);
  return !!checkout && checkout.root !== normalizedProject && covers(checkout.root);
}

export function isProjectAllowedToSync(projectPath: string, config: Config): boolean {
  if (isTestArtifactPath(projectPath)) {
    return false;
  }
  if (!config.sync_mode || config.sync_mode === "all") {
    // "Everything except": the server's excluded folders never upload.
    return !inFolderList(config.sync_excluded, projectPath, true);
  }
  return inFolderList(config.sync_projects, projectPath, true);
}

/**
 * Why a transcript placed in `workspacePath` (null when its workspace is
 * unknown) stays out of sync, or null when it syncs. The one rule for every
 * transcript placed by workspace: the live watcher's event and the watchdog's
 * stale-file pass must never disagree about it.
 */
//
// `launched` marks a session codecast itself started or resumed
// (markLaunched, below). The launch is the person's choice to see it in
// codecast, so it lifts only the "not one of my selected folders" refusal; an
// explicit exclusion (excluded_paths, a managed policy, sync_excluded) and the
// test-artifact rule still hold it back.
export function transcriptScopeRefusal(workspacePath: string | null, config: Config, launched = false): string | null {
  if (!workspacePath) return config.sync_mode === "selected" && !launched ? "unknown workspace path" : null;
  if (isPathExcluded(workspacePath, config.excluded_paths)) return `excluded path ${workspacePath}`;
  if (isTestArtifactPath(workspacePath)) return `non-selected project ${workspacePath}`;
  if (launched && config.sync_mode === "selected") return null;
  if (!isProjectAllowedToSync(workspacePath, config)) return `${config.sync_mode === "selected" ? "non-selected" : "excluded"} project ${workspacePath}`;
  return null;
}

/**
 * Why a session codecast is launching in `folder` will never sync, or null when
 * it will. Only explicit exclusions refuse a launch (see transcriptScopeRefusal).
 */
export function launchScopeRefusal(folder: string, config: Config): string | null {
  return transcriptScopeRefusal(folder, config, true);
}

// The live watcher's own view of the same rule: these tmpdirs end up under
// ~/.claude/projects/<encoded-cwd>/ when tests run, and without filtering the
// daemon would upload them to the user's production Convex inbox. Tests that
// need a real session-watcher event loop should pick a neutral project dir name.
export function isTestProjectDir(projectDirName: string): boolean {
  return isTestArtifactPath(projectDirName);
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

// Sessions codecast itself launched on this machine: a start or resume a person
// asked for through codecast (web, phone, `cast spawn`, a trigger). Such a
// session exists to be seen in codecast, so the sync scope's "only the folders
// I selected" rule does not hold its transcript back: the launch is the
// selection. Explicit exclusions (the person's excluded folders, a managed
// policy) still win; see transcriptScopeRefusal above.
//
// Keyed by conversation and by agent session id. A Claude start knows its
// session id up front (--session-id); other agents learn theirs later, so the
// transcript gate also accepts a session the conversation cache maps to a
// launched conversation. Persisted, because a transcript can sync after a
// daemon restart (the watchdog's stale pass). Leaf module: no daemon deps.


const FILE = "launched-sessions.json";
const KEEP_MS = 90 * 24 * 60 * 60 * 1000;

interface LaunchedFile {
  sessions: Record<string, number>;
  conversations: Record<string, number>;
}

let memo: { file: string; data: LaunchedFile } | null = null;

function filePath(): string {
  return codecastPath(FILE);
}

function load(): LaunchedFile {
  const file = filePath();
  if (memo?.file === file) return memo.data;
  let data: LaunchedFile = { sessions: {}, conversations: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    data = { sessions: raw?.sessions ?? {}, conversations: raw?.conversations ?? {} };
  } catch {}
  memo = { file, data };
  return data;
}

function save(data: LaunchedFile): void {
  const now = Date.now();
  for (const table of [data.sessions, data.conversations]) {
    for (const [id, at] of Object.entries(table)) if (now - at > KEEP_MS) delete table[id];
  }
  const file = filePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch {}
}

/** Record a launch. Either id may be unknown yet; call again when it is. */
export function markLaunched(ids: { conversationId?: string; sessionId?: string }): void {
  const data = load();
  const now = Date.now();
  let changed = false;
  if (ids.conversationId && !data.conversations[ids.conversationId]) { data.conversations[ids.conversationId] = now; changed = true; }
  if (ids.sessionId && !data.sessions[ids.sessionId]) { data.sessions[ids.sessionId] = now; changed = true; }
  if (changed) save(data);
}

/** Whether codecast launched this session, by its own id or its conversation's. */
export function wasLaunched(sessionId: string | undefined, conversationId?: string): boolean {
  const data = load();
  return (!!sessionId && !!data.sessions[sessionId]) || (!!conversationId && !!data.conversations[conversationId]);
}

/** Test seam: forget the in-memory copy so the next read goes to disk. */
export function resetLaunchedSessionsMemo(): void {
  memo = null;
}
