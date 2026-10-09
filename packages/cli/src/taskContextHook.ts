// SessionStart -> the bound task, back in front of an agent after compaction
// or a resume (docs/architecture/task-graph.md TG10). Installed to
// ~/.claude/hooks/task-context.sh and, for Codex, ~/.codecast/hooks/
// task-context-codex.sh when Codex hooks are on. Part of Tasks & Plans in
// Agent Features, and independent of stable mode.
//
// The script gates everything cheap before a node boot: the source and the
// feature. A compacted or resumed session reaches `codecast _task-context`
// (fastPath.ts) even without a task pulse, because a session the server
// spawned for a task holds it on the conversation alone; compaction is rare,
// so the boot and one read are cheap. The read has a short timeout. When it
// fails, the agent still gets the task its pulse names; each failure also
// leaves one line in ~/.codecast/task-context.log.
import * as fs from "node:fs";
import * as path from "node:path";
import { formatTaskResume, formatTaskResumeUnavailable, restoresTaskContext, type TaskResumeContext } from "@codecast/shared/tasks";
import { readTaskPulseFor } from "./taskPulse.js";
import { agentWords } from "./checkoutWords.js";
import { codecastHooksDir, installCodexSessionStartHook, removeCodexSessionStartHook, wrapForClient, type StableHookClient, type StableContextConfig } from "./stableContext.js";
import { HOOK_FEATURE_ON, HOOK_FIELDS_READ } from "./hookJson.js";
import { writeHarnessFile } from "./harness.js";
import { defaultConfigDir } from "./config/configDir.js";

export const TASK_CONTEXT_HOOK_FILE = "task-context.sh";
export const TASK_CONTEXT_LOG_FILE = "task-context.log";

/** The read is all the hook waits on; a slow backend costs a session start this much at most. */
const READ_TIMEOUT_MS = 4000;
/** Past this the log starts over: it answers "why did nothing print", not history. */
const LOG_CAP_BYTES = 64 * 1024;

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
LOG="$DIR/${TASK_CONTEXT_LOG_FILE}"

export PATH="$HOME/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v codecast >/dev/null 2>&1 || exit 0
# Silent to the agent when the CLI itself fails (an older one without the
# verb); the log, capped as the CLI caps it, says why.
codecast _task-context${clientArg} <<<"$INPUT" 2>/dev/null \\
  || { rc=$?; [ "$(wc -c <"$LOG" 2>/dev/null || echo 0)" -gt ${LOG_CAP_BYTES} ] && : >"$LOG"; echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $SESSION_ID codecast _task-context exited $rc" >>"$LOG"; } 2>/dev/null
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

type HookPayload = { session_id?: string; sessionId?: string; source?: string; cursor_version?: string; cwd?: string };

/**
 * The block to print for this SessionStart payload, or null. Only a
 * compacted or resumed session gets one, and only when the server finds a
 * task it holds or its pulse names. `read` is the server call: null when the
 * server answers with nothing, a throw when it could not answer, and then the
 * pulse's task is all the block can say.
 */
export async function taskContextFor(
  payload: HookPayload,
  read: (body: { short_id?: string; started?: boolean; plan_id?: string; session_id: string }) => Promise<TaskResumeContext | null>,
  now = Date.now(),
): Promise<string | null> {
  if (payload.cursor_version || !restoresTaskContext(payload.source)) return null;
  const sessionId = payload.session_id || payload.sessionId;
  if (!sessionId) return null;
  const pulse = readTaskPulseFor(sessionId);
  try {
    const context = await read({
      ...(pulse?.task ? { short_id: pulse.task, ...(pulse.started ? { started: true } : {}) } : {}),
      ...(pulse?.plan ? { plan_id: pulse.plan } : {}),
      session_id: sessionId,
    });
    // A time wait is named absolute here (TG11): this block is read by an
    // agent, beside the stored history, the unblock comment, the wake message
    // and `cast task context`, which all name the date, the year and the zone
    // — and the agent is told to copy the parking line's `cast state` text
    // verbatim, where a bare local-clock "14:00" is pinned, read later by
    // other sessions in other zones, and meaningless once the day turns.
    return context?.task ? formatTaskResume(context, { now, ...agentWords(payload.cwd || process.cwd()) }) : null;
  } catch {
    return pulse?.task ? formatTaskResumeUnavailable(pulse.task, pulse.plan || undefined) : null;
  }
}

/** One line per failure, so a hook that never prints can be diagnosed. */
export function logFailure(sessionId: string | undefined, reason: string): void {
  try {
    const file = path.join(defaultConfigDir(), TASK_CONTEXT_LOG_FILE);
    const line = `${new Date().toISOString()} ${sessionId ?? "-"} ${reason}\n`;
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > LOG_CAP_BYTES) fs.writeFileSync(file, line);
    else fs.appendFileSync(file, line);
  } catch {}
}

/** `codecast _task-context [--client codex]`: the hook payload on stdin, the
 *  block on stdout. `unreadable` is why the config yielded no token, when it
 *  is there but cannot be decrypted. */
export async function runTaskContextHook(config: StableContextConfig | null, client: StableHookClient = "claude", unreadable?: string): Promise<void> {
  let payload: HookPayload = {};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return logFailure(undefined, "unreadable hook payload");
  }
  const sessionId = payload.session_id || payload.sessionId;
  const block = await taskContextFor(payload, async (body) => {
    const label = body.short_id ?? "no pulse task";
    try {
      if (!config?.auth_token || !config.convex_url) throw new Error(unreadable ?? "not signed in");
      const response = await fetch(`${config.convex_url.replace(".cloud", ".site")}/cli/work/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_token: config.auth_token, ...body }),
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`server answered ${response.status}`);
      const context = (await response.json()) as TaskResumeContext | null;
      if (!context && body.short_id) logFailure(sessionId, `${label}: nothing to restore (not found, not readable, or a closed task it only filed)`);
      return context;
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      logFailure(sessionId, `${label}: ${timedOut ? `no answer in ${READ_TIMEOUT_MS}ms` : err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  });
  if (block) process.stdout.write(wrapForClient(client, block));
}
