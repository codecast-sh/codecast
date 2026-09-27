import { describe, expect, mock, test } from "bun:test";
import { liveWatchRowsFor } from "../components/monitorRows";
import { resolveWatchMessage, resolveWorkflowMessage } from "./resolveWatchMessage";

const START = 1_000;
const call = {
  _id: "start-message",
  role: "assistant",
  timestamp: START,
  tool_calls: [{ id: "tool-watch", name: "Bash", input: { command: "sleep 60", run_in_background: true } }],
};
const result = {
  _id: "result-message",
  role: "user",
  timestamp: START + 1,
  tool_results: [{ tool_use_id: "tool-watch", content: "Command running in background with ID: task-watch" }],
};
const host = {
  open_tasks_at: START + 100,
  open_tasks: [{ id: "task-watch", kind: "background" as const, started_at: START + 1, tool_use_id: "tool-watch" }],
};
const reportRow = () => liveWatchRowsFor(host, undefined, START + 100)[0];

describe("background task message jumps", () => {
  test("a daemon-only bar resolves its original call outside the loaded window", async () => {
    const row = reportRow();
    expect(row.startMessageId).toBeUndefined();
    const loadAround = mock(async () => ({ messages: [call, result] }));
    expect(await resolveWatchMessage(row, [], loadAround)).toEqual({ messageId: call._id, timestamp: START });
    expect(loadAround).toHaveBeenCalledWith(START + 1);
    expect(loadAround).toHaveBeenCalledTimes(1);
  });

  test("a message-backed bar needs no network lookup", async () => {
    const row = liveWatchRowsFor(host, [call, result], START + 100)[0];
    const loadAround = mock(async () => null);
    expect(await resolveWatchMessage(row, [call, result], loadAround)).toEqual({ messageId: call._id, timestamp: START });
    expect(loadAround).not.toHaveBeenCalled();
  });

  test("messages loaded since the bar rendered are used before fetching", async () => {
    const loadAround = mock(async () => null);
    expect(await resolveWatchMessage(reportRow(), [call, result], loadAround)).toEqual({ messageId: call._id, timestamp: START });
    expect(loadAround).not.toHaveBeenCalled();
  });

  test("a report without a tool id resolves through the background task id", async () => {
    const row = liveWatchRowsFor({ ...host, open_tasks: [{ ...host.open_tasks[0], tool_use_id: undefined }] }, undefined, START + 100)[0];
    expect(await resolveWatchMessage(row, [], async () => ({ messages: [call, result] }))).toEqual({ messageId: call._id, timestamp: START });
  });

  test("a monitor resolves through its start result too", async () => {
    const row = liveWatchRowsFor({ ...host, open_tasks: [{ ...host.open_tasks[0], kind: "monitor", tool_use_id: undefined }] }, undefined, START + 100)[0];
    const monitorResult = { ...result, tool_results: [{ tool_use_id: "tool-watch", content: "Monitor started (task task-watch, persistent)." }] };
    expect(await resolveWatchMessage(row, [], async () => ({ messages: [call, monitorResult] }))).toEqual({ messageId: call._id, timestamp: START });
  });

  test("a promoted command can land on its result when the call is outside the window", async () => {
    const promoted = { ...result, tool_results: [{ tool_use_id: "tool-watch", content: "Command did not complete within its 400s timeout and was moved to the background (ID: task-watch)." }] };
    expect(await resolveWatchMessage(reportRow(), [], async () => ({ messages: [promoted] }))).toEqual({ messageId: result._id, timestamp: result.timestamp });
  });

  test("unrelated messages and denied access never become a false jump target", async () => {
    expect(await resolveWatchMessage(reportRow(), [], async () => ({ messages: [{ ...call, tool_calls: [{ id: "other-tool" }] }] }))).toBeNull();
    expect(await resolveWatchMessage(reportRow(), [], async () => null)).toBeNull();
  });
});

describe("workflow run message jumps", () => {
  const RUN = 50_000_000;
  const msg = (id: string, timestamp: number, tool?: { name: string; input: unknown }) => ({
    _id: id,
    timestamp,
    tool_calls: tool ? [{ id: `${id}-tool`, ...tool }] : undefined,
  });
  const olderRun = msg("older-launch", RUN - 60 * 60_000, { name: "Workflow", input: "{}" });
  const launch = msg("launch", RUN - 2_000, { name: "Workflow", input: "{}" });
  const chatter = msg("chatter", RUN + 5_000);

  test("lands on the Workflow call that launched the run, not an earlier run's", async () => {
    const loadAround = mock(async () => null);
    expect(await resolveWorkflowMessage(RUN, [olderRun, launch, chatter], loadAround)).toEqual({ messageId: "launch", timestamp: RUN - 2_000 });
    expect(loadAround).not.toHaveBeenCalled();
  });

  test("a shell cast workflow run counts as the launch", async () => {
    const shell = msg("shell", RUN - 1_000, { name: "Bash", input: JSON.stringify({ command: "cd /x && cast workflow run flow.cast --task ct-1" }) });
    expect(await resolveWorkflowMessage(RUN, [shell], async () => null)).toEqual({ messageId: "shell", timestamp: RUN - 1_000 });
  });

  test("pages in around the run start when the launch is not loaded", async () => {
    const loadAround = mock(async () => ({ messages: [launch, chatter] }));
    expect(await resolveWorkflowMessage(RUN, [olderRun], loadAround)).toEqual({ messageId: "launch", timestamp: RUN - 2_000 });
    expect(loadAround).toHaveBeenCalledWith(RUN);
  });

  test("a run started from outside the session lands where it began", async () => {
    const before = msg("before", RUN - 10_000);
    expect(await resolveWorkflowMessage(RUN, [], async () => ({ messages: [before, chatter] }))).toEqual({ messageId: "chatter", timestamp: RUN + 5_000 });
  });
});
