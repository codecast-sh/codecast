// Monitors (the harness `Monitor` tool) projected onto the UI — the model:
//
//   A monitor is a background watch the agent arms inside one conversation:
//   it runs a command, streams events back as <task-notification> messages,
//   and ends on its timeout, a TaskStop, or session end. Unlike schedules
//   (agent_tasks), monitors have NO server-side row — their whole lifecycle
//   is legible from the conversation's own messages, so every surface
//   (conversation block, inbox bars) derives rows from the loaded message
//   window here. A conversation whose messages aren't in the store simply
//   shows no monitor state — we never guess.
//
// Lifecycle stitched from three message shapes:
//   1. assistant tool_use `Monitor` {command, description, timeout_ms,
//      persistent} — the row is born "watching";
//   2. its tool_result "Monitor started (task <id> …)" — yields the task id
//      that later event notifications are keyed by (an error result kills the
//      row: the monitor never existed);
//   3. user <task-notification> messages — an <event> keyed by task-id
//      (including the "[Monitor timed out …]" marker), and the final
//      completed notification keyed by the original tool-use-id.
//   Plus a TaskStop tool_use naming the task id → "stopped".

export type MonitorStatus = "watching" | "ended" | "timed_out" | "stopped";

export type MonitorRow = {
  toolUseId: string;
  // Parsed from the "Monitor started (task <id> …)" result; undefined while
  // the result hasn't landed (or on agents that never echoed it).
  taskId?: string;
  description: string;
  command: string;
  persistent: boolean;
  timeoutMs?: number;
  startedAt: number;
  status: MonitorStatus;
  eventCount: number;
  // Latest real event text (entity-decoded). The timed-out marker flips the
  // status but doesn't overwrite the last thing the monitor actually saw.
  lastEvent?: string;
  lastEventAt?: number;
  endedAt?: number;
};

// The minimal structural shape shared by the store's Message and
// ConversationView's local Message type.
type ScanMessage = {
  role: string;
  content?: string;
  timestamp: number;
  tool_calls?: Array<{ id?: string; name?: string; input?: unknown }>;
  tool_results?: Array<{ tool_use_id?: string; content?: unknown; is_error?: boolean }>;
};

// Notification fields both this module and the conversation's notification
// line read. One parser so the two surfaces can't disagree about a payload.
export type ParsedTaskNotification = {
  taskId: string;
  toolUseId?: string;
  status: string;
  summary: string;
  event?: string;
  outputFile?: string;
};

const TAG = (name: string, inner: string) => inner.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseTaskNotificationBlock(block: string): ParsedTaskNotification {
  return {
    taskId: TAG("task-id", block)?.trim() || "",
    toolUseId: TAG("tool-use-id", block)?.trim(),
    status: TAG("status", block)?.trim() || "",
    summary: TAG("summary", block)?.trim() || "",
    event: TAG("event", block)?.trim(),
    outputFile: TAG("output-file", block)?.trim(),
  };
}

// A monitor-event notification's summary: `Monitor event: "<description>"`.
export function isMonitorEventNotification(n: Pick<ParsedTaskNotification, "summary">): boolean {
  return n.summary.startsWith("Monitor event:");
}

// The final notification for a monitor: `Monitor "<description>" stream ended`.
export function isMonitorEndedNotification(n: Pick<ParsedTaskNotification, "summary">): boolean {
  return /^Monitor .* stream ended/.test(n.summary);
}

// The quoted description inside either monitor summary form.
export function monitorNotificationDescription(n: Pick<ParsedTaskNotification, "summary">): string | undefined {
  return n.summary.match(/[“"](.*?)[”"]/)?.[1];
}

const TIMED_OUT_MARKER = "[Monitor timed out";

const EMPTY: MonitorRow[] = [];
// Keyed on the messages array reference: the mutative store hands back a new
// array only when this conversation's messages actually changed, so one scan
// is shared by every Monitor block in the transcript plus the session card's
// bars, and re-runs only on real message sync.
const rowsCache = new WeakMap<object, MonitorRow[]>();

export function monitorRowsFor(messages: readonly ScanMessage[] | undefined): MonitorRow[] {
  if (!messages?.length) return EMPTY;
  const cached = rowsCache.get(messages as object);
  if (cached) return cached;

  const rows: MonitorRow[] = [];
  const byToolUseId = new Map<string, MonitorRow>();
  const byTaskId = new Map<string, MonitorRow>();
  // Rows whose start result came back as an error — never armed, not shown.
  const dead = new Set<MonitorRow>();

  for (const msg of messages) {
    for (const tc of msg.tool_calls ?? []) {
      if (!tc?.name) continue;
      let input: any = tc.input;
      if (typeof input === "string") {
        try { input = JSON.parse(input); } catch { input = {}; }
      }
      if (tc.name === "Monitor" && tc.id) {
        const row: MonitorRow = {
          toolUseId: tc.id,
          description: (input?.description && String(input.description)) || "background watch",
          command: (input?.command && String(input.command)) || "",
          persistent: !!input?.persistent,
          timeoutMs: typeof input?.timeout_ms === "number" ? input.timeout_ms : undefined,
          startedAt: msg.timestamp,
          status: "watching",
          eventCount: 0,
        };
        rows.push(row);
        byToolUseId.set(tc.id, row);
      } else if (tc.name === "TaskStop" && input?.task_id) {
        const row = byTaskId.get(String(input.task_id));
        if (row && row.status === "watching") {
          row.status = "stopped";
          row.endedAt = msg.timestamp;
        }
      }
    }

    for (const tr of msg.tool_results ?? []) {
      const row = tr?.tool_use_id ? byToolUseId.get(tr.tool_use_id) : undefined;
      if (!row || row.taskId) continue;
      const content = typeof tr.content === "string" ? tr.content : "";
      const started = content.match(/Monitor started \(task ([\w-]+)/);
      if (started) {
        row.taskId = started[1];
        byTaskId.set(started[1], row);
      } else if (tr.is_error) {
        dead.add(row);
      }
    }

    if (msg.role === "user" && msg.content && msg.content.includes("<task-notification>")) {
      for (const block of msg.content.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
        const n = parseTaskNotificationBlock(block);
        const row = (n.toolUseId && byToolUseId.get(n.toolUseId)) || (n.taskId && byTaskId.get(n.taskId)) || undefined;
        if (!row) continue;
        if (n.event) {
          if (n.event.startsWith(TIMED_OUT_MARKER)) {
            if (row.status === "watching") {
              row.status = "timed_out";
              row.endedAt = msg.timestamp;
            }
          } else {
            row.eventCount++;
            row.lastEvent = decodeEntities(n.event);
            row.lastEventAt = msg.timestamp;
          }
        } else if (n.toolUseId && (n.status === "completed" || isMonitorEndedNotification(n))) {
          if (row.status === "watching") row.status = "ended";
          row.endedAt ??= msg.timestamp;
        }
      }
    }
  }

  const result = dead.size ? rows.filter((r) => !dead.has(r)) : rows;
  rowsCache.set(messages as object, result);
  return result;
}

// Defensive expiry for a "watching" row whose end notification we can't see
// (tail not loaded/synced): past its own timeout plus slack it can't still be
// running. Time-dependent, so it lives OUTSIDE the memoized scan.
const TIMEOUT_SLACK_MS = 2 * 60_000;
export function effectiveMonitorStatus(row: MonitorRow, now: number): MonitorStatus {
  if (row.status === "watching" && row.timeoutMs !== undefined && now - row.startedAt > row.timeoutMs + TIMEOUT_SLACK_MS) {
    return "timed_out";
  }
  return row.status;
}

export function watchingMonitors(rows: MonitorRow[], now: number): MonitorRow[] {
  return rows.filter((r) => effectiveMonitorStatus(r, now) === "watching");
}
