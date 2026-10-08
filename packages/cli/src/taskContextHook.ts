// SessionStart -> the bound task, back in front of an agent after compaction
// or a resume (docs/architecture/task-graph.md TG10). Installed to
// ~/.claude/hooks/task-context.sh and, for Codex, ~/.codecast/hooks/
// task-context-codex.sh. Part of Tasks & Plans in Agent Features, and
// independent of stable mode.
//
// The script gates everything cheap before a node boot: the source, the
// feature, the session's task pulse. Only a compacted or resumed session bound
// to a task reaches `codecast _task-context` (fastPath.ts), which makes one
// server read with a short timeout and prints nothing on any failure.
import * as path from "node:path";
import { formatTaskResume, restoresTaskContext, type TaskResumeContext } from "@codecast/shared/tasks";
import { readTaskPulseFor } from "./taskPulse.js";
import { codecastHooksDir, installCodexSessionStartHook, removeCodexSessionStartHook, wrapForClient, type StableHookClient, type StableContextConfig } from "./stableContext.js";
import { HOOK_FEATURE_ON, HOOK_FIELDS_READ } from "./hookJson.js";
import { writeHarnessFile } from "./harness.js";

export const TASK_CONTEXT_HOOK_FILE = "task-context.sh";

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
[ -f "\${CODECAST_DIR:-$HOME/.codecast}/task-pulse/$SESSION_ID.json" ] || exit 0

export PATH="$HOME/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v codecast >/dev/null 2>&1 || exit 0
# Silent on any failure, an older CLI without the verb included.
codecast _task-context${clientArg} <<<"$INPUT" 2>/dev/null
exit 0
`;
}

export const TASK_CONTEXT_HOOK = taskContextHookScript("claude");
export const TASK_CONTEXT_HOOK_CODEX = taskContextHookScript("codex");

const codexHookFile = () => path.join(codecastHooksDir(), "task-context-codex.sh");

/** Codex runs the same job from its own hooks.json, when it is installed here. */
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
  read: (body: { short_id: string; plan_id?: string }) => Promise<TaskResumeContext | null>,
  now = Date.now(),
): Promise<string | null> {
  if (payload.cursor_version || !restoresTaskContext(payload.source)) return null;
  const pulse = readTaskPulseFor(payload.session_id || payload.sessionId);
  if (!pulse?.task) return null;
  const context = await read({ short_id: pulse.task, ...(pulse.plan ? { plan_id: pulse.plan } : {}) });
  return context?.task ? formatTaskResume(context, { now }) : null;
}

/** `codecast _task-context [--client codex]`: the hook payload on stdin, the block on stdout. */
export async function runTaskContextHook(config: StableContextConfig | null, client: StableHookClient = "claude"): Promise<void> {
  if (!config?.auth_token || !config.convex_url) return;
  let payload: HookPayload = {};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return;
  }
  const siteUrl = config.convex_url.replace(".cloud", ".site");
  const block = await taskContextFor(payload, async (body) => {
    try {
      const response = await fetch(`${siteUrl}/cli/work/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_token: config.auth_token, ...body }),
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      return response.ok ? ((await response.json()) as TaskResumeContext | null) : null;
    } catch {
      return null;
    }
  });
  if (block) process.stdout.write(wrapForClient(client, block));
}
