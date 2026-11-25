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

for (const tool of ["Agent", "Task", "UnknownTool"]) test(`unproven ${tool} is preserved`, () => {
  const scan = new HibernationWorkScan(sid);
  scan.consume(call(tool, { run_in_background: true }));
  scan.consume(result("Unrecognized launch response"));
  expect(scan.reason()).toBe("background-work-unproven");
});

// Each of these stayed pending for the life of the process when it failed, and
// the idle reaper reads the same verdict, so the pane could not be reaped either.
for (const tool of ["Bash", "Monitor", "Workflow"]) {
  test(`a ${tool} launch that failed started nothing`, () => {
    const scan = new HibernationWorkScan(sid);
    scan.consume(call(tool, { run_in_background: true }));
    scan.consume({ type: "user", sessionId: sid, message: { content: [{ type: "tool_result", tool_use_id: "call", is_error: true, content: "Error: command not allowed" }] } });
    expect(scan.reason()).toBeNull();
  });
  test(`a ${tool} answered with no launch notice settles`, () => {
    const scan = new HibernationWorkScan(sid);
    scan.consume(call(tool, { run_in_background: true }));
    scan.consume(result("Unrecognized launch response"));
    expect(scan.reason()).toBeNull();
  });
  test(`a ${tool} call with no answer yet stays unproven`, () => {
    const scan = new HibernationWorkScan(sid);
    scan.consume(call(tool, { run_in_background: true }));
    expect(scan.reason()).toBe("background-work-unproven");
  });
}

test("a foreground command without background work is clear", () => {
  const scan = new HibernationWorkScan(sid);
  scan.consume(call("Bash"));
  scan.consume(result("ok"));
  expect(scan.reason()).toBeNull();
});

// A Monitor that runs out of time ends with an event and no <status>, so it
// stayed open for good: d1eaa950 refused open-background-work every hour from
// 2026-11-23 on.
describe("a Monitor that runs out of time", () => {
  const started = () => {
    const scan = new HibernationWorkScan(sid);
    scan.consume(call("Monitor", {}));
    scan.consume(result("Monitor started (task bmon1)"));
    return scan;
  };
  const event = (text: string) => delivered(`<task-notification>\n<task-id>bmon1</task-id>\n<summary>Monitor event: "ci watch"</summary>\n<event>${text}</event>\n</task-notification>`);
  for (const text of [
    "[Monitor expired after 30m with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]",
    "[Monitor expired after 30m with 3 events delivered. Re-arm it if you still need the watch.]",
    "[Monitor expired after 4m 30s with 1 event delivered. Re-arm it if you still need the watch.]",
    "[Monitor timed out — re-arm if needed.]",
  ]) test(`has ended: ${text.slice(0, 40)}`, () => {
    const scan = started();
    expect(scan.reason()).toBe("open-background-work");
    scan.consume(event(text));
    expect(scan.reason()).toBeNull();
  });
  test("an event that is a line of its own output has not", () => {
    const scan = started();
    for (const text of ["EXIT 1", "[killed]", "judge job exited", "12 pass 0 fail [exited with code 0]"]) scan.consume(event(text));
    expect(scan.reason()).toBe("open-background-work");
  });
});

describe("TaskStop", () => {
  const started = () => {
    const scan = new HibernationWorkScan(sid);
    scan.consume(call("Bash", { run_in_background: true }));
    scan.consume(result("Command running in background with ID: job"));
    return scan;
  };
  test("its confirmation closes the task it stopped", () => {
    const scan = started();
    scan.consume(call("TaskStop", { task_id: "job" }, "stop"));
    scan.consume(result(JSON.stringify({ message: "Successfully stopped task: job (sleep 600)", task_id: "job", task_type: "local_bash" }), "stop"));
    expect(scan.reason()).toBeNull();
  });
  test("a failed stop, or a stop of another task, leaves it open", () => {
    const scan = started();
    scan.consume(call("TaskStop", { task_id: "job" }, "stop"));
    scan.consume(result("No task found with ID: job", "stop"));
    scan.consume(call("TaskStop", { task_id: "other" }, "stop2"));
    scan.consume(result("Successfully stopped task: other", "stop2"));
    expect(scan.reason()).toBe("open-background-work");
  });
  test("the confirmation text quoted by another tool closes nothing", () => {
    const scan = started();
    scan.consume(call("TaskStop", { task_id: "job" }, "stop"));
    scan.consume(result("Successfully stopped task: job", "grep"));
    expect(scan.reason()).toBe("open-background-work");
  });
});

describe("Agent", () => {
  const launched = () => {
    const scan = new HibernationWorkScan(sid);
    scan.consume(call("Agent", { prompt: "go" }));
    scan.consume(result("Async agent launched successfully. (This tool result is internal metadata.)\nagentId: a1b2c3 (internal ID)"));
    return scan;
  };
  test("a launched agent is open work until its notification ends it", () => {
    const scan = launched();
    expect(scan.reason()).toBe("open-background-work");
    scan.consume(delivered(notification("a1b2c3", "completed")));
    expect(scan.reason()).toBeNull();
  });
  test("an agent call with no answer yet stays unproven", () => {
    const scan = new HibernationWorkScan(sid);
    scan.consume(call("Agent", { prompt: "go" }));
    expect(scan.reason()).toBe("background-work-unproven");
  });
  test("a failed agent call settles: no agent ran", () => {
    const scan = new HibernationWorkScan(sid);
    scan.consume(call("Agent", { prompt: "go", run_in_background: true }));
    scan.consume({ type: "user", sessionId: sid, message: { content: [{ type: "tool_result", tool_use_id: "call", is_error: true, content: 'Failed to resolve base branch "HEAD"' }] } });
    expect(scan.reason()).toBeNull();
  });
});

// The shape a foreground agent's completion takes (3 on this Mac, 2026-11-24):
// its reply, then its id and a usage block.
const completion = "Here is what I found.\nagentId: ab5cb6761f4e1c03e (use SendMessage with to: 'ab5cb6761f4e1c03e', summary: '<5-10 word recap>' to continue this agent)\n<usage>subagent_tokens: 4450\ntool_uses: 1\nduration_ms: 5451</usage>";

describe("foreground Agent", () => {
  test("its completion settles the call", () => {
    const scan = new HibernationWorkScan(sid);
    scan.consume(call("Task", { prompt: "go" }));
    scan.consume(result(completion));
    expect(scan.reason()).toBeNull();
  });
  test("one sent to the background is open under the agentId its answer names, until its notification", () => {
    const scan = new HibernationWorkScan(sid);
    scan.consume(call("Task", { prompt: "go" }));
    scan.consume(result("Agent moved to the background.\nagentId: a0a1b2c3d4e5f6789 (internal ID)"));
    expect(scan.reason()).toBe("open-background-work");
    scan.consume(delivered(notification("a0a1b2c3d4e5f6789", "completed")));
    expect(scan.reason()).toBeNull();
  });
  test("any other answer that names no agent stays unproven", () => {
    for (const answer of ["Agent moved to the background. You will be notified when it finishes.", "Here is what I found."]) {
      const scan = new HibernationWorkScan(sid);
      scan.consume(call("Task", { prompt: "go" }));
      scan.consume(result(answer));
      expect(scan.reason()).toBe("background-work-unproven");
    }
  });
});

// 2026-11-24: four live sessions refused background-work-unproven forever, on
// teammate spawns. A teammate runs inside this process and waits on its
// mailbox, possibly mid-call, and a resume does not bring it back, so the lead
// stays awake until each teammate it spawned has shut down.
describe("teammates", () => {
  const spawned = (name = "reviewer", agentId = "areviewer-0a1b2c3d") => {
    const scan = new HibernationWorkScan(sid);
    scan.consume(call("Agent", { name, team_name: "t", run_in_background: true }));
    scan.consume(result(`Spawned successfully. (This tool result is internal metadata.)\nagent_id: ${agentId}\nname: ${name}\nThe agent is now running and will receive instructions via mailbox.`));
    return scan;
  };
  const from = (name: string, message: object) =>
    delivered(`Another Claude session sent a message:\n<teammate-message teammate_id="${name}" color="blue">\n${JSON.stringify(message)}\n</teammate-message>`);

  test("a spawned teammate keeps its lead awake, idle or not", () => {
    const scan = spawned();
    expect(scan.reason()).toBe("team-active");
    scan.consume(from("reviewer", { type: "idle_notification", from: "reviewer", idleReason: "available" }));
    expect(scan.reason()).toBe("team-active");
  });
  test("an approved shutdown ends it", () => {
    const scan = spawned();
    scan.consume(from("reviewer", { type: "shutdown_response", request_id: "r1", approve: true }));
    expect(scan.reason()).toBeNull();
  });
  test("a rejected shutdown, or another teammate's, does not", () => {
    const scan = spawned();
    scan.consume(from("reviewer", { type: "shutdown_response", request_id: "r1", approve: false }));
    scan.consume(from("other", { type: "shutdown_response", request_id: "r2", approve: true }));
    expect(scan.reason()).toBe("team-active");
  });
  test("a terminal notification or a confirmed stop under its id ends it", () => {
    const notified = spawned();
    notified.consume(delivered(notification("areviewer-0a1b2c3d", "killed")));
    expect(notified.reason()).toBeNull();
    const stopped = spawned();
    stopped.consume(call("TaskStop", { task_id: "areviewer-0a1b2c3d" }, "stop"));
    stopped.consume(result("Successfully stopped task: areviewer-0a1b2c3d", "stop"));
    expect(stopped.reason()).toBeNull();
  });
  test("a spawn answer that names no teammate stays unproven", () => {
    const scan = new HibernationWorkScan(sid);
    scan.consume(call("Agent", { name: "reviewer", team_name: "t" }));
    scan.consume(result("Spawned successfully. (This tool result is internal metadata.)"));
    expect(scan.reason()).toBe("background-work-unproven");
  });
});

describe("completion marked on the result", () => {
  test("a background call whose result came back completed settles", () => {
    const scan = new HibernationWorkScan(sid);
    scan.consume(call("Agent", { prompt: "go", run_in_background: true }));
    scan.consume({ ...result("Here is what I found."), toolUseResult: { status: "completed" } });
    expect(scan.reason()).toBeNull();
  });
  test("a usage block settles a background call too", () => {
    const scan = new HibernationWorkScan(sid);
    scan.consume(call("Agent", { prompt: "go", run_in_background: true }));
    scan.consume(result(completion));
    expect(scan.reason()).toBeNull();
  });
});

// A SendMessage to a finished agent resumes it inside this process: 417 such
// replies on this Mac (2026-11-24), most followed by a notification under the
// agent's full id.
describe("a resumed agent", () => {
  const resume = (reply: object) => {
    const scan = new HibernationWorkScan(sid);
    scan.consume(call("SendMessage", { to: "aeab593", message: "again" }, "send"));
    scan.consume(result(JSON.stringify(reply), "send"));
    return scan;
  };
  test("is open work until its notification ends it", () => {
    const scan = resume({ success: true, message: "Resuming agent aeab593", resumedAgentId: "aeab5930123456789" });
    expect(scan.reason()).toBe("open-background-work");
    scan.consume(delivered(notification("aeab5930123456789", "completed")));
    expect(scan.reason()).toBeNull();
  });
  test("a reply naming only a short id is closed by the notification it prefixes", () => {
    const scan = resume({ success: true, message: "Resuming agent aeab593" });
    expect(scan.reason()).toBe("open-background-work");
    scan.consume(delivered(notification("aeab5930123456789", "completed")));
    expect(scan.reason()).toBeNull();
  });
  // ~38 resumes here named the agent rather than its id; the notice that ends
  // it carries the id, so opening the name kept the session awake for good.
  test("a reply naming the agent opens it under the pin's id", () => {
    const scan = resume({ success: true, message: "Resuming agent impl-98565", pin: { id: "a9b7743e510087e0c", name: "impl-98565", ref: "d2656f" } });
    expect(scan.reason()).toBe("open-background-work");
    scan.consume(delivered(notification("a9b7743e510087e0c", "completed")));
    expect(scan.reason()).toBeNull();
  });
  test("or under the result's revivedAgentId", () => {
    const scan = new HibernationWorkScan(sid);
    scan.consume(call("SendMessage", { to: "impl-98565", message: "again" }, "send"));
    scan.consume({ ...result(JSON.stringify({ success: true, message: "Resuming agent impl-98565" }), "send"), toolUseResult: { success: true, revivedAgentId: "a9b7743e510087e0c" } });
    scan.consume(delivered(notification("a9b7743e510087e0c", "completed")));
    expect(scan.reason()).toBeNull();
  });
  test("a reply naming the agent only by name opens nothing: no notice carries a name", () => {
    expect(resume({ success: true, message: "Resuming agent impl-98565" }).reason()).toBeNull();
  });
  test("an ordinary message reply opens nothing", () => {
    expect(resume({ success: true, message: "Message sent to reviewer" }).reason()).toBeNull();
  });
});

// In-process work dies with the process. A resume starts a new one, so an
// agent, teammate or workflow a row dated before it left open is gone.
describe("work from an earlier process", () => {
  const start = Date.parse("2026-11-24T12:00:00.000Z");
  const before = "2026-11-24T11:00:00.000Z";
  const after = "2026-11-24T12:30:00.000Z";
  const dated = <T extends object>(row: T, timestamp: string) => ({ ...row, timestamp });
  const spawn = (timestamp: string) => {
    const scan = new HibernationWorkScan(sid, start);
    scan.consume(dated(call("Agent", { name: "reviewer", team_name: "t" }), timestamp));
    scan.consume(dated(result("Spawned successfully.\nagent_id: areviewer-0a1b\nname: reviewer\n"), timestamp));
    return scan;
  };
  test("a teammate spawned before the process started is not team-active", () => {
    expect(spawn(before).reason()).toBeNull();
  });
  test("a teammate spawned by this process is", () => {
    expect(spawn(after).reason()).toBe("team-active");
  });
  test("an agent launched or left unanswered before it is gone", () => {
    const scan = new HibernationWorkScan(sid, start);
    scan.consume(dated(call("Agent", { prompt: "go" }, "a"), before));
    scan.consume(dated(call("Agent", { prompt: "go" }, "b"), before));
    scan.consume(dated(result("Async agent launched successfully.\nagentId: a1b2c3 (internal ID)", "b"), before));
    expect(scan.reason()).toBeNull();
  });
  test("a background command from before does not refuse: it died or was orphaned, and the park's kill-set check guards an orphan", () => {
    const scan = new HibernationWorkScan(sid, start);
    scan.consume(dated(call("Bash", { run_in_background: true }), before));
    scan.consume(dated(result("Command running in background with ID: job"), before));
    scan.consume(dated(call("Monitor", {}, "mon"), before));
    expect(scan.reason()).toBeNull();
  });
  test("a background command this process started does", () => {
    const scan = new HibernationWorkScan(sid, start);
    scan.consume(dated(call("Bash", { run_in_background: true }), after));
    scan.consume(dated(result("Command running in background with ID: job"), after));
    expect(scan.reason()).toBe("open-background-work");
  });
  test("a row with no date counts as this process's", () => {
    const scan = new HibernationWorkScan(sid, start);
    scan.consume(call("Agent", { name: "reviewer", team_name: "t" }));
    scan.consume(result("Spawned successfully.\nagent_id: areviewer-0a1b\nname: reviewer\n"));
    expect(scan.reason()).toBe("team-active");
  });
});

