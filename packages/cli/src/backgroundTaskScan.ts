import type { OpenTaskReport } from "@codecast/shared/contracts";
import { openTaskStart } from "./backgroundTaskStart.js";

// Open background work in a Claude JSONL transcript: tasks the harness started
// (run_in_background Bash, a command moved to the background on timeout, a
// Monitor, a Workflow run) that have not yet reached a terminal state. While any is open, the
// harness re-invokes the agent when it finishes — so a turn that ended with an
// open task is "waiting" (an active substate), not idle/needs-input.
//
// Opens come from tool_result text (the id is only ever surfaced there);
// closes come from:
//   - a <task-notification> carrying a <status> tag. Terminal notifications
//     (completed/failed/stopped) always carry one; Monitor interim event
//     notifications carry none and must NOT close the task. Delivery shapes
//     vary: a plain user message, a queue-operation "remove" (top-level
//     content), or an attachment (prompt) — an enqueue alone is not delivery.
//   - a TaskStop tool_use (the agent tore the task down; no notification comes).
// Lines are scoped to `currentSessionId` when given: a resumed session's file
// replays prior-run history verbatim (original sessionId preserved per line),
// and those runs' tasks died with their process — counting them would latch a
// phantom "waiting".
export function scanOpenBackgroundTasks(content: string, currentSessionId?: string): Set<string> {
  return scanOpenBackgroundTasksInto(new Set<string>(), content, currentSessionId);
}

// When each open task was armed (ms), keyed by task id — the restart fence's
// input. A background task is a child of the agent process that started it;
// when that process is replaced (crash, kill, account switch, `claude
// --resume`) the task dies with it and no terminal notification is ever
// written, so its start line would keep the session "waiting" forever (the
// 1h decay merely rate-limits the lie). Same rule the web's monitor rows apply
// (monitorRows.effectiveMonitorStatus over agent_started_at).
export type OpenTaskTimes = Map<string, number>;

// The scanner core, threading an existing `open` set so a caller that already
// scanned the first N bytes can feed it only the bytes after N. Open/close are
// order-dependent but purely sequential (a task opens on its start line and
// closes on a later notification/TaskStop line), so scanning the file in two
// halves against the same set gives the same answer as scanning it whole.
// The harness's own "this is now a background task" results, anchored to the
// START of the tool_result: the harness always leads with them, and an
// unanchored scan also fired on a foreground command whose OUTPUT quoted one (an
// agent grepping a transcript for these phrases parked its own session in
// "waiting" on a task id nothing would ever close). Same rule as the web's
// monitorRows scanner.
export function openTaskStartId(text: string): string | undefined {
  return openTaskStart(text)?.id;
}

// What the scanner knows about one open task: the shared report shape (what
// gets published) plus the tool call that armed it. `command` is the FULL
// script here — the process check needs it — and is cut to its first line
// only when reported.
export type OpenTaskInfo = OpenTaskReport & { openedAt?: number };

// The tool_use blocks that can arm a task, remembered until their result lands
// (a result always follows its call closely) so the start result can be joined
// to the description/command the agent gave. Bounded: a call whose result was
// lost (an interrupted turn) must not leak forever.
export type PendingTaskCall = { name: string; description?: string; command?: string };
const PENDING_TASK_CALLS_MAX = 200;
const TASK_ARMING_TOOLS = new Set(["Bash", "Monitor", "Workflow", "Agent"]);

export function scanOpenBackgroundTasksInto(
  open: Set<string>,
  content: string,
  currentSessionId?: string,
  openedAt?: OpenTaskTimes,
  info?: Map<string, OpenTaskInfo>,
  pendingCalls?: Map<string, PendingTaskCall>,
): Set<string> {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let d: {
      type?: string;
      sessionId?: string;
      timestamp?: string;
      operation?: string;
      content?: unknown;
      attachment?: { prompt?: unknown; hookName?: unknown };
      message?: { role?: string; content?: unknown };
    };
    try {
      d = JSON.parse(line);
    } catch {
      continue; // partial/corrupt line (mid-write tail) -> skip
    }
    if (currentSessionId && d.sessionId && d.sessionId !== currentSessionId) continue;
    const lineAt = d.timestamp ? Date.parse(d.timestamp) : NaN;
    // A notification that arrives while the agent is mid-turn is recorded as a
    // queue-operation (top-level content) and an attachment (prompt), never as
    // a plain user message — close on the delivered forms. "remove" = dequeued
    // for delivery; an enqueue alone is left open (the wake hasn't happened
    // yet, so the session is still the harness's move).
    if (d.type === "queue-operation") {
      if (d.operation === "remove" && typeof d.content === "string") closeNotifiedTasks(d.content, open);
      continue;
    }
    if (d.type === "attachment") {
      const prompt = d.attachment?.prompt;
      if (typeof prompt === "string") closeNotifiedTasks(prompt, open);
      // A new agent process starts here: the harness records its SessionStart
      // hooks on startup and on every resume (not on compaction, which keeps
      // the process). Each task still open was a child of an earlier process
      // and died with it, unnoticed. The restart fence (notBefore) drops them
      // too, but only while the daemon still holds the process's start, which
      // it forgets once the process is gone. So the watchdog, which only sees
      // dead processes, revived a dormant session on every exit for ten days
      // over a Monitor that had died on Oct 22 (jx71nrj).
      else if (d.attachment?.hookName === "SessionStart:startup" || d.attachment?.hookName === "SessionStart:resume") {
        for (const id of open) { openedAt?.delete(id); info?.delete(id); }
        open.clear();
      }
      continue;
    }
    if (d.type !== "user" && d.type !== "assistant") continue;
    const blocks = d.message?.content;
    const surface = typeof blocks === "string" ? blocks : "";
    if (!Array.isArray(blocks)) {
      closeNotifiedTasks(surface, open);
      continue;
    }
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      const block = b as { type?: string; id?: string; name?: string; input?: unknown; content?: unknown; text?: string; tool_use_id?: string };
      if (block.type === "text" && block.text) {
        closeNotifiedTasks(block.text, open);
      } else if (block.type === "tool_result") {
        const text = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c) => (c && typeof c === "object" ? String((c as { text?: unknown }).text ?? "") : "")).join(" ")
            : "";
        const started = openTaskStart(text);
        const call = block.tool_use_id && pendingCalls ? pendingCalls.get(block.tool_use_id) : undefined;
        if (block.tool_use_id) pendingCalls?.delete(block.tool_use_id);
        if (started) {
          open.add(started.id);
          if (openedAt && Number.isFinite(lineAt)) openedAt.set(started.id, lineAt);
          info?.set(started.id, {
            id: started.id,
            kind: started.kind,
            ...(call?.description ? { description: call.description } : {}),
            ...(call?.command ? { command: call.command } : {}),
            ...(Number.isFinite(lineAt) ? { started_at: lineAt, openedAt: lineAt } : {}),
            ...(block.tool_use_id ? { tool_use_id: block.tool_use_id } : {}),
          });
        }
      } else if (block.type === "tool_use" && block.name === "TaskStop") {
        const taskId = (block.input as { task_id?: unknown } | undefined)?.task_id;
        if (typeof taskId === "string") open.delete(taskId);
      } else if (block.type === "tool_use" && block.id && block.name && TASK_ARMING_TOOLS.has(block.name) && pendingCalls) {
        const input = (block.input ?? {}) as { description?: unknown; command?: unknown };
        pendingCalls.set(block.id, {
          name: block.name,
          ...(typeof input.description === "string" ? { description: input.description } : {}),
          ...(typeof input.command === "string" ? { command: input.command } : {}),
        });
        if (pendingCalls.size > PENDING_TASK_CALLS_MAX) {
          const oldest = pendingCalls.keys().next().value;
          if (oldest !== undefined) pendingCalls.delete(oldest);
        }
      }
    }
  }
  return open;
}

// One notification can carry SEVERAL <task-id> tags (the harness batches an
// orphan sweep into a single <status>stopped</status> notification) — close
// every id it names, but only when a <status> tag marks it terminal (Monitor
// interim events carry no status and must not close their task).
function closeNotifiedTasks(text: string, open: Set<string>): void {
  if (!text.includes("<task-notification>")) return;
  if (!/<status>[^<]+<\/status>/.test(text)) return;
  for (const m of text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) open.delete(m[1]);
}
