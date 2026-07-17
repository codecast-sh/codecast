import { test, expect, describe } from "bun:test";
import { monitorRowsFor, effectiveMonitorStatus, watchingMonitors, parseTaskNotificationBlock, isMonitorEventNotification, isMonitorEndedNotification, monitorNotificationDescription } from "./monitorRows";

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

describe("effectiveMonitorStatus — defensive timeout expiry", () => {
  test("watching past its own timeout + slack reads timed out", () => {
    const [row] = monitorRowsFor([monitorCall("tuX", "w", { timeout_ms: 60_000 }), startedResult("tuX", "tsk")]);
    expect(effectiveMonitorStatus(row, row.startedAt + 30_000)).toBe("watching");
    expect(effectiveMonitorStatus(row, row.startedAt + 60_000 + 3 * 60_000)).toBe("timed_out");
    expect(watchingMonitors([row], row.startedAt + 30_000).length).toBe(1);
    expect(watchingMonitors([row], row.startedAt + 10 * 60_000).length).toBe(0);
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
});
