import { describe, expect, test } from "bun:test";
import { HibernationWorkScan } from "./hibernationWork.js";

const sid = "session";
const call = (name: string, input = {}, id = "call") => ({ type: "assistant", sessionId: sid, message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (content: string, id = "call") => ({ type: "user", sessionId: sid, message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
const notification = (id: string, status?: string) => `<task-notification><task-id>${id}</task-id>${status ? `<status>${status}</status>` : ""}<summary>Update</summary></task-notification>`;
const delivered = (content: string) => ({ type: "user", sessionId: sid, message: { content } });
const starts = [
  ["Bash", "Command running in background with ID: job"],
  ["Bash", "Command did not complete within its 10s timeout and was moved to the background (ID: job)"],
  ["Monitor", "Monitor started (task job)"],
  ["Workflow", "Workflow launched in background. Task ID: job"],
];

for (const [tool, start] of starts) describe(tool + " " + start, () => {
  const setup = () => {
    const scan = new HibernationWorkScan(sid);
    scan.consume(call(tool, { run_in_background: true }));
    scan.consume(result(start));
    return scan;
  };
  test("silence, an idle assistant, and interim events never finish a job", () => {
    const scan = setup();
    scan.consume({ type: "assistant", message: { content: "Done for now; waiting overnight." } });
    scan.consume(delivered(notification("job")));
    scan.consume(delivered(notification("job", "running")));
    expect(scan.reason()).toBe("open-background-work");
  });
  for (const status of ["completed", "failed", "stopped", "killed"]) test(`delivered ${status} allows parking`, () => {
    const scan = setup();
    scan.consume(delivered(notification("job", status)));
    expect(scan.reason()).toBeNull();
  });
  test("queued completion keeps the process until the wake is delivered", () => {
    const scan = setup();
    scan.consume({ type: "queue-operation", operation: "enqueue", content: notification("job", "completed") });
    expect(scan.reason()).toBe("open-background-work");
    scan.consume({ type: "queue-operation", operation: "remove", content: notification("job", "completed") });
    expect(scan.reason()).toBeNull();
  });
  test("attachment completion is accepted", () => {
    const scan = setup();
    scan.consume({ type: "attachment", attachment: { prompt: notification("job", "completed") } });
    expect(scan.reason()).toBeNull();
  });
  test("quoted output, another session, or another job cannot finish this one", () => {
    const scan = setup();
    scan.consume(result(notification("job", "completed"), "grep"));
    scan.consume({ type: "assistant", message: { content: [{ type: "text", text: notification("job", "completed") }] } });
    scan.consume({ ...delivered(notification("job", "completed")), sessionId: "other" });
    scan.consume(delivered(notification("other", "completed")));
    scan.consume(delivered("Quoted example: " + notification("job", "completed")));
    expect(scan.reason()).toBe("open-background-work");
  });
  test("a TaskStop request without confirmation is not completion", () => {
    const scan = setup();
    scan.consume(call("TaskStop", { task_id: "job" }));
    expect(scan.reason()).toBe("open-background-work");
  });
});

test("completion for one notification does not close an adjacent running job", () => {
  const scan = new HibernationWorkScan(sid);
  scan.consume(result("Command running in background with ID: first"));
  scan.consume(result("Command running in background with ID: second"));
  scan.consume(delivered(notification("first", "completed") + notification("second", "running")));
  expect(scan.reason()).toBe("open-background-work");
  scan.consume(delivered(notification("second", "completed")));
  expect(scan.reason()).toBeNull();
});

for (const tool of ["Bash", "Monitor", "Workflow", "Agent", "Task", "UnknownTool"]) test(`unproven ${tool} is preserved`, () => {
  const scan = new HibernationWorkScan(sid);
  scan.consume(call(tool, { run_in_background: true }));
  scan.consume(result("Unrecognized launch response"));
  expect(scan.reason()).toBe("background-work-unproven");
});

test("a foreground command without background work is clear", () => {
  const scan = new HibernationWorkScan(sid);
  scan.consume(call("Bash"));
  scan.consume(result("ok"));
  expect(scan.reason()).toBeNull();
});
