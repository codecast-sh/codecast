// The frame a trigger run's agent receives as its first message: the trigger's
// prompt, the context it carries, and the instructions for completing the run.
// A leaf with light imports so the eval harness (packages/evals, role-wake
// surface) renders exactly the frame production sends without loading the
// scheduler. `now` is a parameter so a frame can be rebuilt at a captured
// moment.
import { SAFE_MODE_MANDATE } from "./agentLaunch.js";
import { triggerLifecycleInstructions, runResultThreadOf } from "@codecast/shared/contracts";

export function buildTriggerFrame(task: any, now: number): string {
  const parts: string[] = [];

  // The handle the agent should type and quote. `Task ID:` below stays the
  // Convex id, which is wire format that sessionMessage.ts parses into the run
  // chip, but every instruction the agent might echo into its own prose uses
  // the short id, so a summary reads "tr-42", not a 32-char blob.
  const handle = task.short_id || task._id;

  parts.push(`[Codecast Task: ${task.title}]`);
  parts.push(`Task ID: ${task._id}`);
  // Wire format: sessionMessage.ts parses `Mode: <propose|apply>` into the
  // run's chip, so the literals stay even though the user-facing name for
  // propose is now "safe". Absent mode falls back to the permissive default.
  parts.push(`Mode: ${task.mode || "apply"}`);
  parts.push("");
  parts.push(task.prompt);

  if (task.context_summary || task.last_run_summary) {
    parts.push("");
    parts.push("---");
  }

  if (task.context_summary) {
    const convId = task.originating_conversation_id;
    // A session's short id is the first 7 chars of its Convex id: the handle
    // that resolves in `cast read` and renders as a session reference.
    parts.push(`Context from originating session${convId ? ` (${convId.toString().slice(0, 7)})` : ""}:`);
    parts.push(task.context_summary);
  }

  if (task.last_run_summary) {
    const ago = task.last_run_at
      ? formatTimeAgo(now - task.last_run_at)
      : "unknown time ago";
    parts.push("");
    parts.push(`Previous run (${ago}):`);
    parts.push(task.last_run_summary);
  }

  parts.push("");
  parts.push("---");
  parts.push("Instructions:");
  // The Mode: header line above is wire format (the web UI parses it into a
  // chip); the mandate that gives safe mode teeth lives here instead, and is
  // the same string the agent gets as its system prompt.
  if (task.mode !== "apply") {
    parts.push(`- ${SAFE_MODE_MANDATE}`);
  }
  if (runResultThreadOf(task)) {
    parts.push(`- Your summary will be posted as a message in the originating conversation thread.`);
    parts.push(`- When done, run: cast trigger complete ${handle} --summary "your full response to post in the thread"`);
    parts.push(`- Write the summary as if you are replying directly to the user in their conversation.`);
  } else {
    parts.push(`- When done, run: cast trigger complete ${handle} --summary "brief description of what was done"`);
  }
  // Only when a real short id exists: telling an agent to quote a 32-char id
  // and to never paste one in the same breath would be nonsense.
  if (task.short_id) {
    parts.push(`- Refer to this trigger as ${task.short_id} in anything you write — that renders as a rich trigger reference. Never paste its 32-char id into prose.`);
  }
  parts.push(`- The completion is this run's declaration of who acts next. A clean one says nobody: the run stays out of the user's inbox and the summary carries the outcome. If you found something the user must read or act on, add --needs-attention: that declares the run blocked on them and keeps it in their inbox.`);
  const lifecycle = triggerLifecycleInstructions(task);
  if (lifecycle) parts.push(lifecycle);
  parts.push('- To set a follow-up trigger: cast trigger add "..." --in <time>');
  if (task.originating_conversation_id) {
    parts.push(`- Run \`cast read ${task.originating_conversation_id.toString().slice(0, 7)}\` for full original context`);
  }

  return parts.join("\n");
}

function formatTimeAgo(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
