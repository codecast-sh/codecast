// SessionStart -> the bound task, back in front of an agent after compaction
// or a resume (docs/architecture/task-graph.md TG10). Installed to
// ~/.claude/hooks/task-context.sh and, for Codex, ~/.codecast/hooks/
// task-context-codex.sh when Codex hooks are on. Part of Tasks & Plans in
// Agent Features, and independent of stable mode.
//
// The script gates everything cheap before a node boot: the source, the
// feature, a task in the session's pulse. Only a compacted or resumed session
// bound to a task reaches `codecast _task-context` (fastPath.ts), which makes
// one server read with a short timeout and prints nothing on any failure. Each
// failure leaves one line in ~/.codecast/task-context.log instead.
import * as fs from "node:fs";
import * as path from "node:path";
import { formatTaskResume, restoresTaskContext, type TaskResumeContext } from "@codecast/shared/tasks";
import { readTaskPulseFor } from "./taskPulse.js";
import { codecastHooksDir, installCodexSessionStartHook, removeCodexSessionStartHook, wrapForClient, type StableHookClient, type StableContextConfig } from "./stableContext.js";
import { HOOK_FEATURE_ON, HOOK_FIELDS_READ } from "./hookJson.js";
import { writeHarnessFile } from "./harness.js";
import { defaultConfigDir } from "./config/configDir.js";

export const TASK_CONTEXT_HOOK_FILE = "task-context.sh";
export const TASK_CONTEXT_LOG_FILE = "task-context.log";

/** The read is all the hook waits on; a slow backend costs a session start this much at most. */
const READ_TIMEOUT_MS = 4000;

type HookClient = Extract<StableHookClient, "claude" | "codex">;

function taskContextHookScript(client: HookClient): string {
  const clientArg = client === "claude" ? "" : ` --client ${client}`;
  return `#!/bin/bash
# Puts the bound task back in front of the agent after compaction or a resume (${client}).
set -uo pipefail

INPUT=$(dd bs=65536 count=1 2>/dev/null || true)
[ -n "$INPUT" ] || exit 0

${HOOK_FIELDS_READ}

case "\${HOOK_source:-}" in
  compact|resume) ;;
  *) exit 0 ;;
esac

SESSION_ID="\${HOOK_session_id:-}"
[ -z "$SESSION_ID" ] && SESSION_ID="\${HOOK_sessionId:-}"
case "$SESSION_ID" in
  ""|[!A-Za-z0-9_-]*|*[!A-Za-z0-9._-]*) exit 0 ;;
esac
[ \${#SESSION_ID} -le 128 ] || exit 0

${HOOK_FEATURE_ON}
feature_on work_enabled || exit 0
DIR="\${CODECAST_DIR:-$HOME/.codecast}"
# A plan-only bind writes an empty task: nothing to restore.
grep -q '"task":"[^"]' "$DIR/task-pulse/$SESSION_ID.json" 2>/dev/null || exit 0

export PATH="$HOME/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v codecast >/dev/null 2>&1 || exit 0
# Silent to the agent on any failure, an older CLI without the verb included;
# the log says why.
codecast _task-context${clientArg} <<<"$INPUT" 2>/dev/null \\
  || { rc=$?; echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $SESSION_ID codecast _task-context exited $rc" >>"$DIR/${TASK_CONTEXT_LOG_FILE}"; } 2>/dev/null
exit 0
`;
}

export const TASK_CONTEXT_HOOK = taskContextHookScript("claude");
export const TASK_CONTEXT_HOOK_CODEX = taskContextHookScript("codex");

const codexHookFile = () => path.join(codecastHooksDir(), "task-context-codex.sh");

/** Codex runs the same job from its own hooks.json, where Codex is installed
 *  and its hooks are already on (stableContext.ts installCodexSessionStartHook). */
export function installTaskContextHookCodex(): void {
  installCodexSessionStartHook(() => {
    const file = codexHookFile();
    writeHarnessFile(file, TASK_CONTEXT_HOOK_CODEX, "hooks", { mode: 0o755, executable: true });
    return file;
  }, "hooks", 10);
}

export function removeTaskContextHookCodex(): void {
  removeCodexSessionStartHook(codexHookFile(), "hooks");
}

type HookPayload = { session_id?: string; sessionId?: string; source?: string; cursor_version?: string };

/**
 * The block to print for this SessionStart payload, or null. Only a
 * compacted or resumed session bound to a task gets one; `read` is the
 * server call (null on any failure).
 */
export async function taskContextFor(
  payload: HookPayload,
  read: (body: { short_id: string; plan_id?: string; session_id: string }) => Promise<TaskResumeContext | null>,
  now = Date.now(),
): Promise<string | null> {
  if (payload.cursor_version || !restoresTaskContext(payload.source)) return null;
  const sessionId = payload.session_id || payload.sessionId;
  const pulse = readTaskPulseFor(sessionId);
  if (!sessionId || !pulse?.task) return null;
  const context = await read({ short_id: pulse.task, ...(pulse.plan ? { plan_id: pulse.plan } : {}), session_id: sessionId });
  return context?.task ? formatTaskResume(context, { now }) : null;
}

/** Past this the log starts over: it answers "why did nothing print", not history. */
const LOG_CAP_BYTES = 64 * 1024;

/** One line per failure, so a hook that never prints can be diagnosed. */
function logFailure(sessionId: string | undefined, reason: string): void {
  try {
    const file = path.join(defaultConfigDir(), TASK_CONTEXT_LOG_FILE);
    const line = `${new Date().toISOString()} ${sessionId ?? "-"} ${reason}\n`;
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > LOG_CAP_BYTES) fs.writeFileSync(file, line);
    else fs.appendFileSync(file, line);
  } catch {}
}

/** `codecast _task-context [--client codex]`: the hook payload on stdin, the block on stdout. */
export async function runTaskContextHook(config: StableContextConfig | null, client: StableHookClient = "claude"): Promise<void> {
  let payload: HookPayload = {};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return logFailure(undefined, "unreadable hook payload");
  }
  const sessionId = payload.session_id || payload.sessionId;
  if (!config?.auth_token || !config.convex_url) return logFailure(sessionId, "not signed in");
  const siteUrl = config.convex_url.replace(".cloud", ".site");
  const block = await taskContextFor(payload, async (body) => {
    try {
      const response = await fetch(`${siteUrl}/cli/work/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_token: config.auth_token, ...body }),
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (!response.ok) {
        logFailure(sessionId, `${body.short_id}: server answered ${response.status}`);
        return null;
      }
      const context = (await response.json()) as TaskResumeContext | null;
      if (!context) logFailure(sessionId, `${body.short_id}: not found or not readable`);
      return context;
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      logFailure(sessionId, `${body.short_id}: ${timedOut ? `no answer in ${READ_TIMEOUT_MS}ms` : String(err)}`);
      return null;
    }
  });
  if (block) process.stdout.write(wrapForClient(client, block));
}
