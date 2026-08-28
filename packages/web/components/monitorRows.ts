// Monitors (the harness `Monitor` tool) and background commands (`Bash` with
// run_in_background) projected onto the UI — the model:
//
//   Both are background watches the agent arms inside one conversation: a
//   command runs detached, reports back as <task-notification> messages, and
//   ends on completion, a TaskStop, or session end (monitors also stream
//   interim events and can time out). Unlike schedules (agent_tasks), neither
//   has a server-side row — their whole lifecycle is legible from the
//   conversation's own messages, so every surface (conversation block, inbox
//   bars) derives rows from the loaded message window here. A conversation
//   whose messages aren't in the store simply shows no state — we never guess.
//   (Workflow runs are NOT projected here: they have a real server row —
//   workflow_runs, ingested from the runtime's snapshot — and their own
//   surfaces: WorkflowToolBlock, the run cards, and the inbox chip fed by
//   conversations.workflow_run_id.)
//
// Lifecycle stitched from three message shapes:
//   1. assistant tool_use `Monitor` {command, description, timeout_ms,
//      persistent} or `Bash` {command, description, run_in_background: true}
//      — the row is born "watching";
//   2. its tool_result — "Monitor started (task <id> …)" / "Command running
//      in background with ID: <id>" — yields the task id that later
//      notifications are keyed by (an error result kills the row: the watch
//      never armed; so does a background Bash whose result shows it ran
//      synchronously — nothing standing);
//   3. user <task-notification> messages — an <event> keyed by task-id
//      (including the "[Monitor timed out …]" marker), and the final
//      completed/failed notification keyed by the original tool-use-id.
//   Plus a TaskStop tool_use naming the task id → "stopped".

import { AGENT_IDLE_GRACE_MS, type OpenTaskReport } from "@codecast/shared/contracts";

export type MonitorStatus = "watching" | "ended" | "timed_out" | "stopped";

export type MonitorRow = {
  // Which tool armed the watch — presentation varies (eyebrow, badge labels)
  // but the lifecycle machinery is shared.
  kind: "monitor" | "background";
  toolUseId: string;
  // The message that armed the watch (the tool_use turn) — lets surfaces jump
  // the conversation to where this row was born. Present whenever the scanned
  // messages carry ids (the store window does; test fixtures may not).
  startMessageId?: string;
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
  // Parsed from the completion summary's "(exit code N)" — background rows
  // only. Nonzero means the command failed; surfaces must not render it as a
  // calm "ended".
  exitCode?: number;
  // Latest real event text (entity-decoded). The timed-out marker flips the
  // status but doesn't overwrite the last thing the monitor actually saw.
  lastEvent?: string;
  lastEventAt?: number;
  endedAt?: number;
};

// The minimal structural shape shared by the store's Message and
// ConversationView's local Message type.
type ScanMessage = {
  _id?: string;
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
  // Every task the notice names. Usually one; the orphan scan's summary notice
  // marks a whole batch stopped in a single message and lists them all.
  taskIds: string[];
  toolUseId?: string;
  status: string;
  summary: string;
  event?: string;
  outputFile?: string;
};

// The orphan scan pads its aggregate notice with a synthetic id and a sentence
// telling the reader that id is not a task. Both are addressed to the agent
// parsing the block, not to a person reading the transcript, so neither reaches
// a surface.
const ORPHAN_MARKER = "__orphan_summary__";
const ORPHAN_MARKER_SENTENCE = /\s*Task ids in this notification beginning with [“"']?__orphan_summary[^.]*\.\s*/;

// The aggregate carries no tool-use-id — it belongs to a batch, not to one
// armed watch — so surfaces name the batch by its own list instead of pinning
// the whole notice on whichever id happened to come first.
export function isOrphanSummaryNotification(n: Pick<ParsedTaskNotification, "taskIds">): boolean {
  return n.taskIds.length > 1;
}

const TAG = (name: string, inner: string) => inner.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

// A `Bash` call the harness detaches into a background task — same standing
// "a machine will wake this session" state as a Monitor, so it wears the same
// row anatomy everywhere. Accepts raw (string) or parsed input so the message
// scan, the tool-block router, and condensed-feed visibility share one
// predicate.
export function isBackgroundBashToolCall(tc: { name?: string; input?: unknown }): boolean {
  if (tc.name !== "Bash") return false;
  let input: any = tc.input;
  if (typeof input === "string") {
    // Cheap prefilter: condensed feeds call this for every Bash input, and
    // almost none are backgrounded — skip the parse unless the key appears.
    if (!input.includes("run_in_background")) return false;
    try { input = JSON.parse(input); } catch { return false; }
  }
  return input?.run_in_background === true;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseTaskNotificationBlock(block: string): ParsedTaskNotification {
  const taskIds = [...block.matchAll(/<task-id>([\s\S]*?)<\/task-id>/g)]
    .map((m) => m[1].trim())
    .filter((id) => id && !id.startsWith(ORPHAN_MARKER));
  return {
    taskId: taskIds[0] || "",
    taskIds,
    toolUseId: TAG("tool-use-id", block)?.trim(),
    status: TAG("status", block)?.trim() || "",
    summary: (TAG("summary", block)?.trim() || "").replace(ORPHAN_MARKER_SENTENCE, " ").trim(),
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

// A terminal notification's summary is one machine sentence — `Background
// command "X" completed (exit code 0)`, `Background agent "Y" failed with
// exit code 3`. Split it into the parts a surface renders as visual elements:
// what kind of thing finished (the words before the quote), which one (the
// quoted description), and the exit code when the sentence carries one. The
// orphan/no-completion-record notices are unquoted prose and yield undefined —
// the surface falls back to the sentence itself.
export type NotificationSummaryParts = { kind: string; description: string; exitCode?: number };

export function parseNotificationSummary(summary: string): NotificationSummaryParts | undefined {
  const m = summary.match(/^([A-Za-z][A-Za-z ]{0,40}?)\s*[“"](.+?)[”"]/);
  if (!m) return undefined;
  const exit = summary.match(/exit code (\d+)/);
  return { kind: m[1].trim().toLowerCase(), description: m[2], exitCode: exit ? Number(exit[1]) : undefined };
}

const TIMED_OUT_MARKER = "[Monitor timed out";
// The harness's own "this is now a background task" results, and the id each
// carries. Anchored to the START of the result: the harness always leads with
// them, and an unanchored match also fired on a foreground command whose
// OUTPUT quoted one (an agent grepping a transcript for these very phrases
// birthed a phantom "running" row nothing could ever close).
const BACKGROUND_STARTED_RE = /^\s*(?:Monitor started \(task ([\w-]+)|Command running in background with ID: ([\w-]+)|Command did not complete within its \d+s timeout and was moved to the background \(ID: ([\w-]+)\))/;
export function backgroundStartedTaskId(content: string): string | undefined {
  const m = content.match(BACKGROUND_STARTED_RE);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}
// The timeout-promotion form alone — a FOREGROUND call's result that says the
// harness moved it to the background, which births a row after the fact.
const PROMOTED_TO_BACKGROUND_RE = /^\s*Command did not complete within its \d+s timeout and was moved to the background \(ID: /;
const TERMINAL_STATUSES = new Set(["completed", "failed", "killed", "stopped"]);

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
  // Every FOREGROUND Bash call, by tool_use id, so a result that reports the
  // harness promoted it to the background on timeout ("moved to the background
  // (ID: …)") can birth its row after the fact — the call itself carried no
  // run_in_background, so nothing below armed it up front. Values are the raw
  // pieces a row needs; parsing the input is deferred to that (rare) result.
  const foregroundBash = new Map<string, { msg: ScanMessage; input: unknown }>();

  for (const msg of messages) {
    for (const tc of msg.tool_calls ?? []) {
      if (!tc?.name) continue;
      let input: any = tc.input;
      if (typeof input === "string") {
        try { input = JSON.parse(input); } catch { input = {}; }
      }
      const kind: MonitorRow["kind"] | undefined =
        tc.name === "Monitor" ? "monitor"
        : isBackgroundBashToolCall({ name: tc.name, input }) ? "background"
        : undefined;
      if (!kind && tc.name === "Bash" && tc.id) foregroundBash.set(tc.id, { msg, input });
      if (kind && tc.id) {
        const row: MonitorRow = {
          kind,
          toolUseId: tc.id,
          startMessageId: msg._id,
          description: (input?.description && String(input.description)) || (kind === "monitor" ? "background watch" : "background command"),
          command: (input?.command && String(input.command)) || "",
          persistent: !!input?.persistent,
          // Background tasks carry no timeout, and a persistent monitor's
          // timeout_ms is ignored by the harness (required input, but the
          // watch runs until TaskStop or session end) — neither gets one
          // here, so the defensive expiry below never applies to them.
          timeoutMs: kind === "monitor" && !input?.persistent && typeof input?.timeout_ms === "number" ? input.timeout_ms : undefined,
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
      let row = tr?.tool_use_id ? byToolUseId.get(tr.tool_use_id) : undefined;
      const content = typeof tr.content === "string" ? tr.content : "";
      if (!row && tr?.tool_use_id && PROMOTED_TO_BACKGROUND_RE.test(content)) {
        // A foreground command the harness promoted on timeout: arm its row
        // now, from the call we indexed above (or a bare stub if the call was
        // outside this window).
        const call = foregroundBash.get(tr.tool_use_id);
        const input: any = call?.input ?? {};
        row = {
          kind: "background",
          toolUseId: tr.tool_use_id,
          startMessageId: call?.msg._id ?? msg._id,
          description: (input?.description && String(input.description)) || "background command",
          command: (input?.command && String(input.command)) || "",
          persistent: false,
          timeoutMs: undefined,
          startedAt: call?.msg.timestamp ?? msg.timestamp,
          status: "watching",
          eventCount: 0,
        };
        rows.push(row);
        byToolUseId.set(tr.tool_use_id, row);
      }
      if (!row || row.taskId) continue;
      // The third shape is a foreground command the harness promoted to the
      // background on timeout ("did not complete within its Ns timeout and was
      // moved to the background (ID: …)"). The daemon's turn-end scan counts it
      // as open work (the session settles "waiting" → Dormant), so the card
      // must show the row too — otherwise the park has no visible reason.
      const started = backgroundStartedTaskId(content);
      if (started) {
        row.taskId = started;
        byTaskId.set(started, row);
      } else if (tr.is_error || (row.kind === "background" && content)) {
        // Error → never armed. A background Bash whose result is ordinary
        // output means the harness ran it synchronously — nothing standing.
        dead.add(row);
      }
    }

    if (msg.role === "user" && msg.content && msg.content.includes("<task-notification>")) {
      for (const block of msg.content.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
        const n = parseTaskNotificationBlock(block);
        const row = (n.toolUseId && byToolUseId.get(n.toolUseId)) || (n.taskId && byTaskId.get(n.taskId)) || undefined;
        if (n.event) {
          if (!row) continue;
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
        } else if (TERMINAL_STATUSES.has(n.status) || isMonitorEndedNotification(n)) {
          // "stopped" arrives on the orphan notice after a harness restart
          // ("No completion record was found …"); "killed" from an outside
          // teardown. Both mean the watch was cut, not that it finished.
          //
          // The orphan scan's aggregate names a whole batch and carries no
          // tool-use-id, so it ends every row it lists — not just the first.
          const targets = n.toolUseId && row ? [row] : n.taskIds.map((id) => byTaskId.get(id)).filter((r): r is MonitorRow => !!r);
          for (const target of targets) {
            if (target.status === "watching") {
              target.status = n.status === "killed" || n.status === "stopped" ? "stopped" : "ended";
            }
            target.endedAt ??= msg.timestamp;
            const exit = n.summary.match(/exit code (\d+)/);
            if (exit) target.exitCode = Number(exit[1]);
          }
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

// A watch is a child of the agent process that armed it, so it cannot outlive
// that process. When the agent restarts (`claude --resume` after a crash, a
// kill, an account switch), every shell it was babysitting dies with it — but
// the new process inherits only the transcript, so no completion notification
// is ever written for them and the scan above leaves the rows "watching"
// forever. Two dead `until grep` loops sat at a green "running for 19h" in the
// inbox this way while their siblings, armed after the restart, were genuinely
// alive: age can't tell them apart, but boot generation can.
//
// `agentStartedAt` is when the CURRENT agent process booted. A row armed
// before it belongs to a process that is gone, so the watch was cut, not
// finished — "stopped", the same verdict a kill notice produces. The slack
// absorbs clock skew between the transcript's timestamps and the reported boot
// (both come from the agent's own machine, so it only needs to be small); a
// row armed after the boot is left entirely alone.
const BOOT_SKEW_SLACK_MS = 60_000;

export function effectiveMonitorStatus(row: MonitorRow, now: number, agentStartedAt?: number): MonitorStatus {
  if (row.status !== "watching") return row.status;
  if (agentStartedAt !== undefined && row.startedAt < agentStartedAt - BOOT_SKEW_SLACK_MS) {
    return "stopped";
  }
  if (row.timeoutMs !== undefined && now - row.startedAt > row.timeoutMs + TIMEOUT_SLACK_MS) {
    return "timed_out";
  }
  return row.status;
}

export function watchingMonitors(rows: MonitorRow[], now: number, agentStartedAt?: number): MonitorRow[] {
  return rows.filter((r) => effectiveMonitorStatus(r, now, agentStartedAt) === "watching");
}

// Whether the session hosting a watch can still be running it. A watch is a
// child of the agent process, so it lives exactly as long as that process: a
// retired (killed) row or a dead ("stopped") agent hosts nothing, and a row no
// daemon speaks for (no agent_status at all — an unmanaged import, a row the
// liveness overlay no longer covers) can claim a live process only inside the
// idle grace after its last activity. Any daemon-reported status short of
// "stopped" is proof of a live process: the server coerces a lapsed heartbeat
// to "stopped" (caught here) and a quiet-but-alive agent only to "idle".
//
// Deliberately NOT the status-trust decay (isLivenessStale / STATUS_TRUST_TTL_MS).
// That decay says "an active status this quiet can no longer be believed" —
// right for the card's WORKING claim, wrong for a watch: a poll on a long build
// is quiet BY DESIGN while its process is alive. Gating the bar on that decay
// hid a live build poll the moment it crossed the hour and left the human
// asking "are you polling?" (2026-08-17). A restart is fenced separately by
// effectiveMonitorStatus over agent_started_at, and the harness itself writes
// a "stopped" notice for the tasks a resume orphaned.
export function isWatchHostDead(
  session: { agent_status?: string | null; message_count?: number; updated_at?: number; inbox_killed_at?: number | null },
  now: number,
): boolean {
  if (session.inbox_killed_at) return true;
  if (session.agent_status === "stopped") return true;
  if (session.agent_status) return false;
  return (session.message_count ?? 0) > 0 && now - (session.updated_at || 0) >= AGENT_IDLE_GRACE_MS;
}

// ---- The daemon's report, merged with the message-derived rows -------------
// The daemon publishes the open tasks it VERIFIED (matched to a live child
// shell of the agent — see shared/contracts/openTasks) as `open_tasks`, stamped
// `open_tasks_at`. Two things it gives a surface that the messages cannot:
//   - rows for a conversation whose messages are not loaded (a Dormant card
//     the user never opened, or whose arming turn fell out of the warm window)
//     — the "↳ Background …" row is the reason the card is parked, so it must
//     draw from the row alone;
//   - a verdict on message-derived rows: a watch armed BEFORE the report that
//     the report does not list is one the daemon found dead (a lost completion
//     notice, a shell that died) — hide it rather than claim "running".
// A watch armed AFTER the report is unknown to it and stands on the messages.
// No report at all (an older daemon, a non-Claude agent): the messages decide.
export type WatchHost = { open_tasks?: OpenTaskReport[] | null; open_tasks_at?: number | null; agent_started_at?: number | null };
// The transcript's clock and the daemon's are close, not identical.
const REPORT_SKEW_MS = 5_000;

export function reportSaysDead(host: WatchHost, row: Pick<MonitorRow, "taskId" | "startedAt">): boolean {
  if (!host.open_tasks || !host.open_tasks_at || !row.taskId) return false;
  if (row.startedAt > host.open_tasks_at - REPORT_SKEW_MS) return false;
  return !host.open_tasks.some((t) => t.id === row.taskId);
}

function rowFromReport(t: OpenTaskReport, reportedAt: number): MonitorRow {
  return {
    kind: t.kind === "monitor" ? "monitor" : "background",
    toolUseId: t.tool_use_id ?? `task:${t.id}`,
    taskId: t.id,
    description: t.description || (t.kind === "monitor" ? "background watch" : "background command"),
    command: t.command ?? "",
    persistent: false,
    startedAt: t.started_at ?? reportedAt,
    status: "watching",
    eventCount: 0,
  };
}

// The watches a card should show as running: message-derived rows that are
// still watching (own lifecycle, restart fence, the daemon's verdict), plus
// the daemon's reported tasks the messages don't cover. Workflow tasks are
// left out — the run has its own bar (WorkflowBar) fed by workflow_run_*.
export function liveWatchRowsFor(host: WatchHost, messages: readonly ScanMessage[] | undefined, now: number): MonitorRow[] {
  const fromMessages = watchingMonitors(monitorRowsFor(messages), now, host.agent_started_at ?? undefined)
    .filter((r) => !reportSaysDead(host, r));
  const report = host.open_tasks;
  const at = host.open_tasks_at;
  if (!report || !at) return fromMessages;
  // A report from before the current agent process booted describes shells
  // that died with the old one — it can retire rows (above) but adds none.
  if (host.agent_started_at && at < host.agent_started_at - REPORT_SKEW_MS) return fromMessages;
  const covered = new Set(fromMessages.map((r) => r.taskId).filter(Boolean));
  const extra = report
    .filter((t) => t.kind !== "workflow" && !covered.has(t.id))
    .map((t) => rowFromReport(t, at));
  return extra.length ? [...fromMessages, ...extra] : fromMessages;
}

