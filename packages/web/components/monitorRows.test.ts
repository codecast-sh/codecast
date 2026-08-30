import { test, expect, describe } from "bun:test";
import { monitorRowsFor, effectiveMonitorStatus, watchingMonitors, isWatchHostDead, liveWatchRowsFor, reportSaysDead, isBackgroundBashToolCall, parseTaskNotificationBlock, isMonitorEventNotification, isMonitorEndedNotification, isOrphanSummaryNotification, monitorNotificationDescription, parseNotificationSummary } from "./monitorRows";

// The wire shapes below mirror a real transcript: a Monitor tool_use, its
// "Monitor started (task <id> …)" result on the next message, then
// <task-notification> user messages carrying events and the stream end.

const monitorCall = (id: string, desc: string, opts: { persistent?: boolean; timeout_ms?: number } = {}) => ({
  role: "assistant",
  timestamp: 1000,
  tool_calls: [{ id, name: "Monitor", input: JSON.stringify({ command: "while true; do tail; done", description: desc, timeout_ms: opts.timeout_ms ?? 1_500_000, persistent: opts.persistent ?? false }) }],
});

const startedResult = (toolUseId: string, taskId: string) => ({
  role: "user",
  timestamp: 1001,
  content: "",
  tool_results: [{ tool_use_id: toolUseId, content: `Monitor started (task ${taskId}, persistent — runs until TaskStop or session end). You will be notified on each event.` }],
});

const eventNotif = (taskId: string, desc: string, event: string, ts: number) => ({
  role: "user",
  timestamp: ts,
  content: `<task-notification>\n<task-id>${taskId}</task-id>\n<summary>Monitor event: "${desc}"</summary>\n<event>${event}</event>\nIf this event is something the user would act on now, send a PushNotification.\n</task-notification>`,
});

const endedNotif = (taskId: string, toolUseId: string, desc: string, ts: number) => ({
  role: "user",
  timestamp: ts,
  content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/tmp/x.output</output-file>\n<status>completed</status>\n<summary>Monitor "${desc}" stream ended</summary>\n</task-notification>`,
});

describe("monitorRowsFor — lifecycle from messages", () => {
  test("armed monitor with a started result is watching, with task id", () => {
    const rows = monitorRowsFor([monitorCall("tu1", "deploy watch"), startedResult("tu1", "b7ry")]);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("watching");
    expect(rows[0].taskId).toBe("b7ry");
    expect(rows[0].description).toBe("deploy watch");
  });

  test("row remembers the message that armed it, when messages carry ids", () => {
    const rows = monitorRowsFor([
      { ...monitorCall("tu1", "deploy watch"), _id: "msg_arm" },
      startedResult("tu1", "b7ry"),
    ]);
    expect(rows[0].startMessageId).toBe("msg_arm");
  });

  test("events accumulate; latest event text is decoded", () => {
    const rows = monitorRowsFor([
      monitorCall("tu1", "deploy watch"),
      startedResult("tu1", "b7ry"),
      eventNotif("b7ry", "deploy watch", "==&gt; Preflight auth checks", 2000),
      eventNotif("b7ry", "deploy watch", "FAILED: Parallel jobs failed | EXIT CODE: 1", 3000),
    ]);
    expect(rows[0].eventCount).toBe(2);
    expect(rows[0].lastEvent).toBe("FAILED: Parallel jobs failed | EXIT CODE: 1");
    expect(rows[0].lastEventAt).toBe(3000);
    expect(rows[0].status).toBe("watching");
  });

  test("stream-ended notification (by tool-use-id) flips to ended", () => {
    const rows = monitorRowsFor([
      monitorCall("tu1", "deploy watch"),
      startedResult("tu1", "b7ry"),
      endedNotif("b7ry", "tu1", "deploy watch", 5000),
    ]);
    expect(rows[0].status).toBe("ended");
    expect(rows[0].endedAt).toBe(5000);
  });

  test("timed-out marker flips status but keeps the last real event", () => {
    const rows = monitorRowsFor([
      monitorCall("tu1", "deploy watch"),
      startedResult("tu1", "b7ry"),
      eventNotif("b7ry", "deploy watch", "==&gt; Building image", 2000),
      eventNotif("b7ry", "deploy watch", "[Monitor timed out — re-arm if needed.]", 4000),
    ]);
    expect(rows[0].status).toBe("timed_out");
    expect(rows[0].lastEvent).toBe("==> Building image");
    expect(rows[0].eventCount).toBe(1);
  });

  test("TaskStop naming the task id flips to stopped", () => {
    const rows = monitorRowsFor([
      monitorCall("tu1", "deploy watch"),
      startedResult("tu1", "b7ry"),
      { role: "assistant", timestamp: 6000, tool_calls: [{ id: "tu2", name: "TaskStop", input: JSON.stringify({ task_id: "b7ry" }) }] },
    ]);
    expect(rows[0].status).toBe("stopped");
  });

  test("an error result means the monitor never armed — row dropped", () => {
    const rows = monitorRowsFor([
      monitorCall("tu1", "deploy watch"),
      { role: "user", timestamp: 1001, tool_results: [{ tool_use_id: "tu1", content: "monitor limit reached", is_error: true }] },
    ]);
    expect(rows.length).toBe(0);
  });

  test("scan is memoized per messages array reference", () => {
    const messages = [monitorCall("tu1", "deploy watch"), startedResult("tu1", "b7ry")];
    expect(monitorRowsFor(messages)).toBe(monitorRowsFor(messages));
  });
});

// Background Bash wire shapes mirror the real transcript jx7652s: a `Bash`
// tool_use with run_in_background, the "Command running in background with
// ID: …" result, then a single terminal <task-notification> (completed with
// exit code, or the "No completion record" stopped notice after a harness
// restart).

const bgBashCall = (id: string, desc: string) => ({
  role: "assistant",
  timestamp: 1000,
  tool_calls: [{ id, name: "Bash", input: JSON.stringify({ command: "while true; do grep done /tmp/x.log && break; sleep 60; done", description: desc, run_in_background: true }) }],
});

const bgStartedResult = (toolUseId: string, taskId: string) => ({
  role: "user",
  timestamp: 1001,
  content: "",
  tool_results: [{ tool_use_id: toolUseId, content: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/tasks/${taskId}.output. You will be notified when it completes. To check interim output, use Read on that file path.` }],
});

const bgCompletedNotif = (taskId: string, toolUseId: string, desc: string, exitCode: number, ts: number) => ({
  role: "user",
  timestamp: ts,
  content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/tmp/tasks/${taskId}.output</output-file>\n<status>completed</status>\n<summary>Background command "${desc}" completed (exit code ${exitCode})</summary>\n</task-notification>`,
});

const bgOrphanStoppedNotif = (taskId: string, toolUseId: string, ts: number) => ({
  role: "user",
  timestamp: ts,
  content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>stopped</status>\n<summary>No completion record was found for this background shell command from the previous session. It may have been stopped (via the UI, Monitor timeout, or agent teardown — these leave no transcript marker), or it may have been running when the previous Claude Code process exited.</summary>\n</task-notification>`,
});

// The orphan scan's aggregate, verbatim from a transcript: several task ids, a
// synthetic marker id, no tool-use-id, and a summary that ends with a sentence
// meant for the parser.
const orphanBatchNotif = (taskIds: string[], ts: number) => ({
  role: "user",
  timestamp: ts,
  content:
    `<task-notification>\n${taskIds.map((id) => `<task-id>${id}</task-id>`).join("\n")}\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>` +
    `\n<summary>${taskIds.length} background shell command task(s) from the previous session have no completion record. They may have been stopped (via the UI, Monitor timeout, or agent teardown — these leave no transcript marker), or they may have been running when the previous Claude Code process exited. They have been marked stopped. Task ids: ${taskIds.join(", ")}. Task ids in this notification beginning with "__orphan_summary" are internal scan markers, not tasks.</summary>\n</task-notification>`,
});

describe("monitorRowsFor — background Bash lifecycle", () => {
  test("armed background command is watching, with task id and kind", () => {
    const rows = monitorRowsFor([bgBashCall("tu1", "Watch all four suite runs"), bgStartedResult("tu1", "bdcgma1cy")]);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("background");
    expect(rows[0].status).toBe("watching");
    expect(rows[0].taskId).toBe("bdcgma1cy");
    expect(rows[0].description).toBe("Watch all four suite runs");
    expect(rows[0].timeoutMs).toBeUndefined();
  });

  test("monitor rows carry kind 'monitor'", () => {
    const rows = monitorRowsFor([monitorCall("tu1", "deploy watch"), startedResult("tu1", "b7ry")]);
    expect(rows[0].kind).toBe("monitor");
  });

  test("completion notification flips to ended and carries the exit code", () => {
    const rows = monitorRowsFor([
      bgBashCall("tu1", "Bounded watcher for all four suite runs (max 4h)"),
      bgStartedResult("tu1", "bltiqn7be"),
      bgCompletedNotif("bltiqn7be", "tu1", "Bounded watcher for all four suite runs (max 4h)", 0, 5000),
    ]);
    expect(rows[0].status).toBe("ended");
    expect(rows[0].endedAt).toBe(5000);
    expect(rows[0].exitCode).toBe(0);
  });

  test("nonzero exit code is preserved for failure styling", () => {
    const rows = monitorRowsFor([
      bgBashCall("tu1", "flaky watch"),
      bgStartedResult("tu1", "t1"),
      bgCompletedNotif("t1", "tu1", "flaky watch", 2, 5000),
    ]);
    expect(rows[0].status).toBe("ended");
    expect(rows[0].exitCode).toBe(2);
  });

  test("failed completion (real wire shape: no parens, status failed) ends the row with its exit code", () => {
    const rows = monitorRowsFor([
      bgBashCall("tu1", "flaky watch"),
      bgStartedResult("tu1", "t3"),
      {
        role: "user",
        timestamp: 5000,
        content: `<task-notification>\n<task-id>t3</task-id>\n<tool-use-id>tu1</tool-use-id>\n<output-file>/tmp/tasks/t3.output</output-file>\n<status>failed</status>\n<summary>Background command "flaky watch" failed with exit code 3</summary>\n</task-notification>`,
      },
    ]);
    expect(rows[0].status).toBe("ended");
    expect(rows[0].exitCode).toBe(3);
  });

  test("orphan 'no completion record' notice flips to stopped", () => {
    const rows = monitorRowsFor([
      bgBashCall("tu1", "suite watch"),
      bgStartedResult("tu1", "b6aw3d3t3"),
      bgOrphanStoppedNotif("b6aw3d3t3", "tu1", 9000),
    ]);
    expect(rows[0].status).toBe("stopped");
    expect(rows[0].endedAt).toBe(9000);
  });

  test("the orphan batch notice stops every row it names, not just the first", () => {
    const rows = monitorRowsFor([
      bgBashCall("tu1", "suite watch"),
      bgStartedResult("tu1", "b1"),
      bgBashCall("tu2", "log tail"),
      bgStartedResult("tu2", "b2"),
      orphanBatchNotif(["b1", "b2"], 9000),
    ]);
    expect(rows.map((r) => r.status)).toEqual(["stopped", "stopped"]);
    expect(rows.map((r) => r.endedAt)).toEqual([9000, 9000]);
  });

  test("TaskStop naming the background task id flips to stopped", () => {
    const rows = monitorRowsFor([
      bgBashCall("tu1", "suite watch"),
      bgStartedResult("tu1", "t9"),
      { role: "assistant", timestamp: 6000, tool_calls: [{ id: "tu2", name: "TaskStop", input: JSON.stringify({ task_id: "t9" }) }] },
    ]);
    expect(rows[0].status).toBe("stopped");
  });

  test("a result that ran synchronously (ordinary output) drops the row", () => {
    const rows = monitorRowsFor([
      bgBashCall("tu1", "suite watch"),
      { role: "user", timestamp: 1001, tool_results: [{ tool_use_id: "tu1", content: "done\nwatcher exit: opus_eval=ok" }] },
    ]);
    expect(rows.length).toBe(0);
  });

  test("foreground Bash calls produce no row", () => {
    const rows = monitorRowsFor([
      { role: "assistant", timestamp: 1000, tool_calls: [{ id: "tu1", name: "Bash", input: JSON.stringify({ command: "ls", description: "list" }) }] },
    ]);
    expect(rows.length).toBe(0);
  });

  test("no defensive expiry without a timeout — still watching hours later", () => {
    const [row] = monitorRowsFor([bgBashCall("tu1", "w"), bgStartedResult("tu1", "t")]);
    expect(effectiveMonitorStatus(row, row.startedAt + 24 * 3600_000)).toBe("watching");
  });
});

describe("isBackgroundBashToolCall", () => {
  test("matches Bash with run_in_background over string or parsed input", () => {
    expect(isBackgroundBashToolCall({ name: "Bash", input: JSON.stringify({ command: "x", run_in_background: true }) })).toBe(true);
    expect(isBackgroundBashToolCall({ name: "Bash", input: { command: "x", run_in_background: true } })).toBe(true);
    expect(isBackgroundBashToolCall({ name: "Bash", input: JSON.stringify({ command: "x" }) })).toBe(false);
    expect(isBackgroundBashToolCall({ name: "Monitor", input: JSON.stringify({ run_in_background: true }) })).toBe(false);
    expect(isBackgroundBashToolCall({ name: "Bash", input: "not json" })).toBe(false);
  });
});

describe("effectiveMonitorStatus — defensive timeout expiry", () => {
  test("persistent monitor never expires — its timeout_ms is ignored by the harness", () => {
    // timeout_ms is a required Monitor param but documented as ignored when
    // persistent: the watch runs until TaskStop or session end. The row must
    // not carry it, or the expiry would hide a genuinely live watcher.
    const [row] = monitorRowsFor([monitorCall("tuP", "reindex watch", { persistent: true, timeout_ms: 3600_000 }), startedResult("tuP", "tsk")]);
    expect(row.timeoutMs).toBeUndefined();
    expect(effectiveMonitorStatus(row, row.startedAt + 24 * 3600_000)).toBe("watching");
    expect(watchingMonitors([row], row.startedAt + 24 * 3600_000).length).toBe(1);
  });

  test("watching past its own timeout + slack reads timed out", () => {
    const [row] = monitorRowsFor([monitorCall("tuX", "w", { timeout_ms: 60_000 }), startedResult("tuX", "tsk")]);
    expect(effectiveMonitorStatus(row, row.startedAt + 30_000)).toBe("watching");
    expect(effectiveMonitorStatus(row, row.startedAt + 60_000 + 3 * 60_000)).toBe("timed_out");
    expect(watchingMonitors([row], row.startedAt + 30_000).length).toBe(1);
    expect(watchingMonitors([row], row.startedAt + 10 * 60_000).length).toBe(0);
  });
});

// The real case this was built for: a session whose agent restarted while four
// `until grep` shells were standing. The two armed before the restart died with
// the old process and were never notified; the two armed after are alive. Only
// the boot time separates them — both pairs are hours old and eventless.
describe("effectiveMonitorStatus — agent restart cuts the watches it armed", () => {
  const HOUR = 3600_000;
  const armedAt = (ts: number) => {
    const [row] = monitorRowsFor([
      { ...bgBashCall("tu", "watch run"), timestamp: ts },
      { ...bgStartedResult("tu", "tsk"), timestamp: ts + 1 },
    ]);
    return row;
  };

  test("a row armed before the current process booted reads stopped", () => {
    const boot = 100 * HOUR;
    const row = armedAt(boot - 2 * HOUR);
    expect(effectiveMonitorStatus(row, boot + 19 * HOUR, boot)).toBe("stopped");
    expect(watchingMonitors([row], boot + 19 * HOUR, boot).length).toBe(0);
  });

  test("a row armed after the boot stays watching, however old it gets", () => {
    const boot = 100 * HOUR;
    const row = armedAt(boot + HOUR);
    expect(effectiveMonitorStatus(row, boot + 17 * HOUR, boot)).toBe("watching");
    expect(watchingMonitors([row], boot + 17 * HOUR, boot).length).toBe(1);
  });

  test("clock skew around the boot instant does not cut a live row", () => {
    const boot = 100 * HOUR;
    // Armed 20s "before" the reported boot — skew, not a previous generation.
    expect(effectiveMonitorStatus(armedAt(boot - 20_000), boot + HOUR, boot)).toBe("watching");
  });

  test("without a known boot time nothing is fenced", () => {
    const boot = 100 * HOUR;
    const row = armedAt(boot - 2 * HOUR);
    expect(effectiveMonitorStatus(row, boot + 19 * HOUR)).toBe("watching");
  });

  test("a row that already ended keeps its own verdict, not the fence's", () => {
    const boot = 100 * HOUR;
    const [row] = monitorRowsFor([
      { ...bgBashCall("tu", "watch run"), timestamp: boot - 2 * HOUR },
      { ...bgStartedResult("tu", "tsk"), timestamp: boot - 2 * HOUR + 1 },
      bgCompletedNotif("tsk", "tu", "watch run", 0, boot - HOUR),
    ]);
    expect(effectiveMonitorStatus(row, boot + HOUR, boot)).toBe("ended");
  });
});

describe("isWatchHostDead — the session can still host the watch", () => {
  const HOUR = 3600_000;
  const NOW = 1_000 * HOUR;
  const quietFor = (ms: number) => NOW - ms;

  test("a waiting session quiet past the trust TTL still hosts its poll (2026-08-17: a live 5h build poll)", () => {
    // Turn ended on an open background task, then nothing for 5 hours — the
    // exact card that lost its bar at the hour and drew "are you polling?".
    expect(isWatchHostDead({ agent_status: "waiting", message_count: 940, updated_at: quietFor(5 * HOUR) }, NOW)).toBe(false);
    // The server's own decay has already coerced that status to plain idle by
    // then; the process is still alive, so the watch is too.
    expect(isWatchHostDead({ agent_status: "idle", message_count: 940, updated_at: quietFor(5 * HOUR) }, NOW)).toBe(false);
  });

  test("an active session quiet past the TTL still hosts (a lost idle transition, not a dead process)", () => {
    expect(isWatchHostDead({ agent_status: "working", message_count: 10, updated_at: quietFor(3 * HOUR) }, NOW)).toBe(false);
  });

  test("a stopped agent hosts nothing — the watch died with the process", () => {
    expect(isWatchHostDead({ agent_status: "stopped", message_count: 10, updated_at: NOW }, NOW)).toBe(true);
  });

  test("a killed row hosts nothing, whatever live fields it froze with", () => {
    expect(isWatchHostDead({ agent_status: "waiting", message_count: 10, updated_at: NOW, inbox_killed_at: NOW - 1 }, NOW)).toBe(true);
  });

  test("a row no daemon speaks for: hosts only inside the idle grace", () => {
    // Statusless and quiet 10s: mid-grace, still plausibly alive.
    expect(isWatchHostDead({ agent_status: null, message_count: 10, updated_at: quietFor(10_000) }, NOW)).toBe(false);
    // Statusless and quiet 5 minutes: nothing anywhere claims a live process —
    // however the row's is_idle reads (an aged-out row freezes it at true).
    expect(isWatchHostDead({ agent_status: null, message_count: 10, updated_at: quietFor(5 * 60_000) }, NOW)).toBe(true);
    expect(isWatchHostDead({ agent_status: undefined, message_count: 10, updated_at: quietFor(17 * 24 * HOUR) }, NOW)).toBe(true);
  });
});

describe("monitorRowsFor — a result that merely QUOTES a start phrase arms nothing", () => {
  test("a foreground grep whose output cites 'moved to the background' births no row", () => {
    const rows = monitorRowsFor([
      { role: "assistant", timestamp: 1000, tool_calls: [{ id: "tu", name: "Bash", input: JSON.stringify({ command: "grep -n 'moved to the background' transcript.jsonl", description: "Inspect the phantom-open task ids" }) }] },
      { role: "user", timestamp: 1001, tool_results: [{ tool_use_id: "tu", content: "252:  Command did not complete within its 60s timeout and was moved to the background (ID: bk2dy02vm). Output is being written to: /tmp/x" }] },
    ]);
    expect(rows.length).toBe(0);
  });

  test("a background call whose (synchronous) output cites 'running in background with ID' is dead, not armed", () => {
    const rows = monitorRowsFor([
      { role: "assistant", timestamp: 1000, tool_calls: [{ id: "tu", name: "Bash", input: JSON.stringify({ command: "grep 'running in background' t.jsonl", description: "grep", run_in_background: true }) }] },
      { role: "user", timestamp: 1001, tool_results: [{ tool_use_id: "tu", content: "18:{\"x\":\"Command running in background with ID: bwxa1nfbs. Output\"}" }] },
    ]);
    expect(rows.length).toBe(0);
  });
});

describe("liveWatchRowsFor — the daemon's verified report merged with the message rows", () => {
  const T0 = 1_000_000_000;
  const armed = (toolUseId: string, taskId: string, ts: number, description = "watch run") => [
    { ...bgBashCall(toolUseId, description), timestamp: ts },
    { ...bgStartedResult(toolUseId, taskId), timestamp: ts + 1 },
  ];
  const report = (ids: string[], at: number, extra: Partial<{ description: string; command: string; started_at: number; tool_use_id: string }> = {}) => ({
    open_tasks: ids.map((id) => ({ id, kind: "background" as const, ...extra })),
    open_tasks_at: at,
  });

  test("no report (old daemon): the messages decide", () => {
    const rows = liveWatchRowsFor({}, armed("tu", "t1", T0), T0 + 60_000);
    expect(rows.map((r) => r.taskId)).toEqual(["t1"]);
  });

  test("a message row the report does not list, armed before the report, is dead (harness lost the notice)", () => {
    const host = report([], T0 + 30_000);
    expect(reportSaysDead(host, { taskId: "t1", startedAt: T0 })).toBe(true);
    expect(liveWatchRowsFor(host, armed("tu", "t1", T0), T0 + 60_000)).toEqual([]);
  });

  test("a message row armed AFTER the report is unknown to it and stands", () => {
    const host = report([], T0 - 30_000);
    expect(reportSaysDead(host, { taskId: "t1", startedAt: T0 })).toBe(false);
    expect(liveWatchRowsFor(host, armed("tu", "t1", T0), T0 + 60_000).map((r) => r.taskId)).toEqual(["t1"]);
  });

  test("a reported task the loaded messages don't cover gets a row from the report alone", () => {
    const host = report(["srv1"], T0 + 30_000, { description: "Wait for EAS build to finish", command: "until s=$(eas build:view x); do sleep 60; done", started_at: T0 + 10, tool_use_id: "toolu_x" });
    const rows = liveWatchRowsFor(host, undefined, T0 + 60_000);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ kind: "background", taskId: "srv1", toolUseId: "toolu_x", description: "Wait for EAS build to finish", command: "until s=$(eas build:view x); do sleep 60; done", startedAt: T0 + 10, status: "watching" });
  });

  test("a task both sides know renders once, from the messages (they carry the start message id and events)", () => {
    const host = report(["t1"], T0 + 30_000);
    const rows = liveWatchRowsFor(host, armed("tu", "t1", T0), T0 + 60_000);
    expect(rows.length).toBe(1);
    expect(rows[0].toolUseId).toBe("tu");
  });

  test("workflow tasks in the report are left to the workflow bar", () => {
    const host = { open_tasks: [{ id: "wf1", kind: "workflow" as const }], open_tasks_at: T0 };
    expect(liveWatchRowsFor(host, undefined, T0 + 60_000)).toEqual([]);
  });

  test("a report from before the current process booted adds nothing (its shells died with the old one)", () => {
    const boot = T0 + 3600_000;
    const stale = { ...report(["t1"], boot - 60_000), agent_started_at: boot };
    expect(liveWatchRowsFor(stale, armed("tu", "t1", T0), boot + 120_000)).toEqual([]);
    // A report made AFTER the boot that lists the task is fresh evidence: the
    // daemon checked it against the new process, so it stands.
    const fresh = { ...report(["t1"], boot + 60_000, { started_at: boot + 30_000 }), agent_started_at: boot };
    expect(liveWatchRowsFor(fresh, undefined, boot + 120_000).map((r) => r.taskId)).toEqual(["t1"]);
  });
});

describe("notification parsing helpers", () => {
  test("event notifications are classified and carry the description", () => {
    const n = parseTaskNotificationBlock(eventNotif("t1", "deploy watch", "EXIT CODE: 1", 0).content);
    expect(isMonitorEventNotification(n)).toBe(true);
    expect(isMonitorEndedNotification(n)).toBe(false);
    expect(monitorNotificationDescription(n)).toBe("deploy watch");
    expect(n.event).toBe("EXIT CODE: 1");
  });

  test("stream-ended notifications are classified with tool-use-id", () => {
    const n = parseTaskNotificationBlock(endedNotif("t1", "tu9", "deploy watch", 0).content);
    expect(isMonitorEndedNotification(n)).toBe(true);
    expect(isMonitorEventNotification(n)).toBe(false);
    expect(n.toolUseId).toBe("tu9");
    expect(n.status).toBe("completed");
  });

  test("the orphan batch notice keeps every real id and drops the scan marker", () => {
    const n = parseTaskNotificationBlock(orphanBatchNotif(["b1", "b2", "b3"], 0).content);
    expect(n.taskIds).toEqual(["b1", "b2", "b3"]);
    expect(n.taskId).toBe("b1");
    expect(isOrphanSummaryNotification(n)).toBe(true);
    // The sentence about "__orphan_summary" ids is addressed to the parser.
    expect(n.summary).not.toContain("__orphan_summary");
    expect(n.summary).toContain("have no completion record");
  });

  test("a single-task notice is not a batch", () => {
    const n = parseTaskNotificationBlock(bgOrphanStoppedNotif("b6aw3d3t3", "tu1", 0).content);
    expect(n.taskIds).toEqual(["b6aw3d3t3"]);
    expect(isOrphanSummaryNotification(n)).toBe(false);
  });

  test("a terminal summary splits into kind, description, and exit code", () => {
    expect(parseNotificationSummary('Background command "Restart mac-m4pro allocation retry loop (8h window)" completed (exit code 0)')).toEqual({
      kind: "background command",
      description: "Restart mac-m4pro allocation retry loop (8h window)",
      exitCode: 0,
    });
    expect(parseNotificationSummary('Background command "flaky watch" failed with exit code 3')).toEqual({
      kind: "background command",
      description: "flaky watch",
      exitCode: 3,
    });
    expect(parseNotificationSummary('Background agent "researcher" completed')).toEqual({
      kind: "background agent",
      description: "researcher",
      exitCode: undefined,
    });
  });

  test("unquoted prose notices yield no parts — the surface keeps the sentence", () => {
    const n = parseTaskNotificationBlock(bgOrphanStoppedNotif("b6aw3d3t3", "tu1", 0).content);
    expect(parseNotificationSummary(n.summary)).toBeUndefined();
  });
});


// A FOREGROUND Bash the harness promoted to the background on timeout. The
// daemon's turn-end scan counts it as open work (the session settles "waiting"
// → Dormant), so the card must show the same row or the park has no visible
// reason — the first live Dormant review found exactly that gap.
describe("monitorRowsFor — timeout-promoted foreground commands", () => {
  const fgCall = (id: string) => ({
    role: "assistant",
    timestamp: 1000,
    tool_calls: [{ id, name: "Bash", input: JSON.stringify({ command: "until tmux has-session -t wr; do sleep 5; done", description: "Wait for the pane", timeout: 400000 }) }],
  });
  const promoted = (toolUseId: string, taskId: string) => ({
    role: "user",
    timestamp: 1400,
    content: "",
    tool_results: [{ tool_use_id: toolUseId, content: `Command did not complete within its 400s timeout and was moved to the background (ID: ${taskId}). Output is being written to: /tmp/tasks/${taskId}.output. You will be notified when it completes.` }],
  });

  test("births a watching background row keyed to the promoted task id", () => {
    const rows = monitorRowsFor([fgCall("tu9"), promoted("tu9", "bpzok")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("background");
    expect(rows[0].taskId).toBe("bpzok");
    expect(rows[0].status).toBe("watching");
    expect(rows[0].description).toBe("Wait for the pane");
    expect(rows[0].startedAt).toBe(1000);
  });

  test("its terminal notification closes it like any background task", () => {
    const rows = monitorRowsFor([fgCall("tu9"), promoted("tu9", "bpzok"), endedNotif("bpzok", "tu9", "Wait for the pane", 2000)]);
    expect(rows[0].status).not.toBe("watching");
  });

  test("an ordinary foreground result arms nothing", () => {
    const rows = monitorRowsFor([fgCall("tu9"), { role: "user", timestamp: 1001, content: "", tool_results: [{ tool_use_id: "tu9", content: "ok\n" }] }]);
    expect(rows).toHaveLength(0);
  });
});
