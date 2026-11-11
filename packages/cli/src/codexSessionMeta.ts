// What a Codex rollout's session_meta records say about the session: its cwd,
// who launched it, whether it is a finished review, and the root of its fork
// lineage. Import-free, split out of parser.ts for its max-lines cap.

export function extractCodexCwd(content: string): string | undefined {
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session_meta" && entry.payload?.cwd) {
        return entry.payload.cwd;
      }
    } catch {}
  }
  return undefined;
}

/** A Codex subagent spawned IN-PROCESS as a thread of its parent TUI. The nested
 *  `thread_spawn` object is what distinguishes it from a `codex exec` child, which
 *  is a separate OS process and writes `subagent: "review"` (a bare string). Only
 *  the thread shape shares its parent's pid — see classifyProcessOwnership. */
export interface CodexThreadSpawn {
  parent_thread_id?: string;
  depth?: number;
  agent_path?: string;
  agent_nickname?: string;
}

export interface CodexSessionMetadata {
  id?: string;
  parentThreadId?: string;
  originator?: string;
  source?: string | { subagent?: string | { thread_spawn?: CodexThreadSpawn }; custom?: string };
}

export function extractCodexSessionMetadata(content: string): CodexSessionMetadata | undefined {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "session_meta") continue;
      return {
        id: optionalString(entry.payload?.id),
        parentThreadId: optionalString(entry.payload?.parent_thread_id),
        originator: optionalString(entry.payload?.originator),
        source: codexSource(entry.payload?.source),
      };
    } catch {}
  }
  return undefined;
}

const optionalString = (v: unknown) => (typeof v === "string" ? v : undefined);
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// Codex adds fields to session_meta.source between releases (0.167 added
// thread_spawn.agent_role). The ingest worker's result validator accepts only
// the declared shape, so passing the raw object through rejected every such
// session's ingest. Keep exactly the fields CodexSessionMetadata declares.
function codexSource(raw: unknown): CodexSessionMetadata["source"] {
  if (typeof raw === "string") return raw;
  if (!plainObject(raw)) return undefined;
  const source: Exclude<CodexSessionMetadata["source"], string | undefined> = {};
  if (typeof raw.custom === "string") source.custom = raw.custom;
  if (typeof raw.subagent === "string") source.subagent = raw.subagent;
  else if (plainObject(raw.subagent)) {
    const spawn = raw.subagent.thread_spawn;
    if (!plainObject(spawn)) source.subagent = {};
    else {
      const kept: CodexThreadSpawn = {};
      for (const key of ["parent_thread_id", "agent_path", "agent_nickname"] as const) {
        if (typeof spawn[key] === "string") kept[key] = spawn[key] as string;
      }
      if (Number.isSafeInteger(spawn.depth) && (spawn.depth as number) >= 0) kept.depth = spawn.depth as number;
      source.subagent = { thread_spawn: kept };
    }
  }
  return source;
}

// A Codex thread no person started: `codex exec` (Codex's headless mode, the
// counterpart of `claude -p`) or a thread Codex spawned itself (a reviewer, an
// approval assessor). Its user turns are prompts a program wrote.
export function isCodexProgramLaunch(metadata: CodexSessionMetadata | undefined): boolean {
  return metadata?.source === "exec" || (typeof metadata?.source === "object" && !!metadata.source.subagent);
}

export function isCompletedStandaloneCodexReview(
  metadata: CodexSessionMetadata | undefined,
  content: string,
): boolean {
  if (metadata?.originator !== "codex_exec" || metadata.source !== "exec") return false;

  let exitedReviewMode = false;
  let taskComplete = false;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "event_msg") continue;
      if (entry.payload?.type === "exited_review_mode") exitedReviewMode = true;
      if (entry.payload?.type === "task_complete") taskComplete = true;
    } catch {}
  }
  return exitedReviewMode && taskComplete;
}

export function isCompletedNativeCodexReviewChild(
  metadata: CodexSessionMetadata | undefined,
  content: string,
): boolean {
  if (
    metadata?.originator !== "codex_exec" ||
    typeof metadata.source !== "object" ||
    metadata.source.subagent !== "review"
  ) return false;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "event_msg" && entry.payload?.type === "task_complete") return true;
    } catch {}
  }
  return false;
}

// Codex Desktop forks a rollout on every resume/reopen: it writes a new file with a
// fresh UUID, copies the prior history forward, and stacks one more session_meta record
// at the top whose `forked_from_id` points at the parent. The whole ancestry is therefore
// embedded as the leading run of session_meta records (newest first), back to the original
// session that was forked from nothing. That original is the stable identity for the entire
// lineage — resolving to it lets the daemon collapse every resume/fork of one logical
// session into a single conversation instead of minting a duplicate per rollout file.
//
// Pass the leading session_meta block (see readCodexSessionMetaHead in the daemon); a file
// whose head was truncated still resolves consistently because every fork embeds the same
// ancestry. Returns the file's own id when there is no fork lineage, or undefined when no
// session_meta is present at all.
export function extractCodexForkRoot(content: string): string | undefined {
  const parent = new Map<string, string | undefined>();
  let ownId: string | undefined;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "session_meta") continue;
      const id: string | undefined = entry.payload?.id;
      if (!id) continue;
      if (!ownId) ownId = id; // the file's own session_meta is always first
      if (!parent.has(id)) parent.set(id, entry.payload?.forked_from_id ?? undefined);
    } catch {}
  }
  if (!ownId) return undefined;
  // Walk forked_from links to the deepest ancestor recorded in this file.
  let root = ownId;
  const seen = new Set<string>();
  while (parent.get(root) && !seen.has(root)) {
    seen.add(root);
    root = parent.get(root)!;
  }
  return root;
}
