import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { loopHoldBoundMs, measureLoopHold } from "./test-helpers/loopHold.js";
import { blockAt, functionBlock } from "./test-helpers/sourceRegion.js";
import { SCAN_CHUNK_BYTES, readFileTailAsync, readFileTailSync, extractPendingToolUseFromTail, extractPendingToolUseFromTranscriptAsync, resolveTurnEndStatus, openTaskScanOffset, primeOpenTaskScan, readCompleteLinesSync, reconcileStatusFromTranscript, registerManagedStartedSession, resetSessionFileIndexForTests, transcriptTailTurnStartTs, openBackgroundTaskIds, openBackgroundTasks, reconciledStatusWithTasks, scanOpenBackgroundTasks, declaredSettleVerdict, latestTurnStartTs, markTurnStarted, statusFlipStartsTurn, verifyOpenTasks, parseProcessTable, taskProcessNeedle, toOpenTaskReports, paneReconcileTarget, type OpenTaskInfo } from "./daemon.js";

// Regression tests for the "settled turn with live background work reads as
// needs_input" bug (session jx7e6ex, 2026-08-03). A turn that ends while a
// run_in_background command or Monitor is still open is NOT the user's move —
// the harness re-invokes the agent when the task finishes — so the daemon must
// settle such a turn into "waiting" (an active substate), never plain "idle".
//
// scanOpenBackgroundTasks derives the open set from the transcript alone:
// opens from tool_result text, closes from terminal <task-notification>
// messages (the ones carrying a <status> tag) and TaskStop tool calls.

const SID = "3ed92d44-c5db-441c-a3aa-b307931f3005";

const line = (obj: unknown) => JSON.stringify(obj);
const toolResult = (text: string, sessionId = SID) =>
  line({ type: "user", sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: text }] } });
const bgStart = (id: string, sessionId = SID) =>
  toolResult(`Command running in background with ID: ${id}. Output is being written to: /tmp/tasks/${id}.output`, sessionId);
const timeoutPromoted = (id: string) =>
  toolResult(`Command did not complete within its 300s timeout and was moved to the background (ID: ${id}).`);
const monitorStart = (id: string) =>
  toolResult(`Monitor started (task ${id}, timeout 900000ms). You will be notified on each event.`);
const workflowStart = (id: string) =>
  toolResult(`Workflow launched in background. Task ID: ${id}\nSummary: Implement the thing\nTranscript dir: /x/subagents/workflows/wf_abc\nScript file: /x/workflows/scripts/my-flow-wf_abc.js`);
const notification = (id: string, status?: string, sessionId = SID) =>
  line({
    type: "user",
    sessionId,
    message: {
      role: "user",
      content: `<task-notification>\n<task-id>${id}</task-id>\n${status ? `<status>${status}</status>\n` : ""}<summary>x</summary>\n</task-notification>`,
    },
  });
const taskStop = (id: string) =>
  line({ type: "assistant", sessionId: SID, message: { role: "assistant", content: [{ type: "tool_use", name: "TaskStop", input: { task_id: id } }] } });

const transcript = (...lines: string[]) => lines.join("\n");

describe("scanOpenBackgroundTasks", () => {
  test("a result that merely QUOTES a start phrase opens nothing (a grep over a transcript is not a task)", () => {
    // 2026-08-17: an agent inspecting phantom-open task ids grepped its own
    // transcript; the unanchored scan read the quoted line as a fresh start and
    // parked the session in "waiting" on an id nothing would ever close.
    expect([...scanOpenBackgroundTasks(transcript(
      toolResult("252:  Command did not complete within its 60s timeout and was moved to the background (ID: bk2dy02vm). Output is being written to: /tmp/x"),
      toolResult('18:{"x":"Command running in background with ID: bwxa1nfbs. Output"}'),
    ))]).toEqual([]);
    // Leading whitespace is fine — the harness's own text still leads.
    expect([...scanOpenBackgroundTasks(transcript(toolResult("  Command running in background with ID: b9. Output is being written to: /tmp/x")))]).toEqual(["b9"]);
  });

  test("a started background command is open until its terminal notification", () => {
    expect([...scanOpenBackgroundTasks(transcript(bgStart("b1")))]).toEqual(["b1"]);
    expect([...scanOpenBackgroundTasks(transcript(bgStart("b1"), notification("b1", "completed")))]).toEqual([]);
    expect([...scanOpenBackgroundTasks(transcript(bgStart("b1"), notification("b1", "failed")))]).toEqual([]);
    expect([...scanOpenBackgroundTasks(transcript(bgStart("b1"), notification("b1", "stopped")))]).toEqual([]);
  });

  test("timeout-promoted commands and Monitors count as open tasks", () => {
    const open = scanOpenBackgroundTasks(transcript(timeoutPromoted("b2"), monitorStart("m1")));
    expect([...open].sort()).toEqual(["b2", "m1"]);
  });

  test("a launched Workflow is open until its terminal notification (jx70xxy shape)", () => {
    // A session that ends its turn right after launching a multi-agent
    // Workflow is the harness's move, not the user's — it must read as open
    // work, or the inbox shows an "idle" session with 6 agents running.
    expect([...scanOpenBackgroundTasks(transcript(workflowStart("wdbvz98da")))]).toEqual(["wdbvz98da"]);
    expect([...scanOpenBackgroundTasks(transcript(workflowStart("wdbvz98da"), notification("wdbvz98da", "completed")))]).toEqual([]);
    expect([...scanOpenBackgroundTasks(transcript(workflowStart("wdbvz98da"), notification("wdbvz98da", "stopped")))]).toEqual([]);
  });

  test("Monitor interim event notifications (no <status>) do NOT close the task", () => {
    const open = scanOpenBackgroundTasks(transcript(monitorStart("m1"), notification("m1"), notification("m1")));
    expect([...open]).toEqual(["m1"]);
  });

  test("TaskStop closes a task without a notification", () => {
    expect([...scanOpenBackgroundTasks(transcript(bgStart("b1"), taskStop("b1")))]).toEqual([]);
  });

  test("notification as a text content block (not raw string) also closes", () => {
    const blockNotification = line({
      type: "user",
      sessionId: SID,
      message: { role: "user", content: [{ type: "text", text: "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>" }] },
    });
    expect([...scanOpenBackgroundTasks(transcript(bgStart("b1"), blockNotification))]).toEqual([]);
  });

  test("resume-replayed history from a prior run is ignored via sessionId scoping", () => {
    // A resumed session's file replays old lines verbatim (original sessionId
    // preserved); those runs' tasks died with their process.
    const content = transcript(bgStart("dead1", "old-run-uuid"), bgStart("live1"));
    expect([...scanOpenBackgroundTasks(content, SID)]).toEqual(["live1"]);
    // Without a sessionId to scope by, everything counts.
    expect([...scanOpenBackgroundTasks(content)].sort()).toEqual(["dead1", "live1"]);
  });

  test("mid-turn delivery shapes close: queue-operation remove and attachment", () => {
    // A notification arriving while the agent is mid-turn is recorded as
    // queue-operation + attachment lines, never as a plain user message.
    const notifText = "<task-notification>\n<task-id>b1</task-id>\n<status>failed</status>\n</task-notification>";
    const queueRemove = line({ type: "queue-operation", operation: "remove", sessionId: SID, content: notifText });
    const attachment = line({ type: "attachment", sessionId: SID, attachment: { type: "queued_command", prompt: notifText } });
    expect([...scanOpenBackgroundTasks(transcript(bgStart("b1"), queueRemove), SID)]).toEqual([]);
    expect([...scanOpenBackgroundTasks(transcript(bgStart("b1"), attachment), SID)]).toEqual([]);
    // An enqueue alone is NOT delivery — the wake hasn't happened yet.
    const queueEnqueue = line({ type: "queue-operation", operation: "enqueue", sessionId: SID, content: notifText });
    expect([...scanOpenBackgroundTasks(transcript(bgStart("b1"), queueEnqueue), SID)]).toEqual(["b1"]);
  });

  test("a batched notification with several task-ids closes all of them", () => {
    const batched = line({
      type: "user",
      sessionId: SID,
      message: { role: "user", content: "<task-notification>\n<task-id>b1</task-id>\n<task-id>b2</task-id>\n<status>stopped</status>\n</task-notification>" },
    });
    expect([...scanOpenBackgroundTasks(transcript(bgStart("b1"), bgStart("b2"), batched), SID)]).toEqual([]);
  });

  test("corrupt / partial lines are skipped, not fatal", () => {
    expect([...scanOpenBackgroundTasks(transcript(bgStart("b1"), '{"type":"user","mess'))]).toEqual(["b1"]);
  });

  test("multiple opens in the real interleaving stay open (jx7e6ex shape)", () => {
    // The reported session: turn ended ("No response requested.") right after
    // starting a retry pull, with earlier tasks closed. Must read as open work.
    const content = transcript(
      bgStart("bkch1nbow"),
      bgStart("btl4g35sh"),
      notification("bkch1nbow", "completed"),
      notification("btl4g35sh", "failed"),
      bgStart("bj14hd03m"),
      line({ type: "assistant", sessionId: SID, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "No response requested." }] } }),
    );
    expect([...scanOpenBackgroundTasks(content, SID)]).toEqual(["bj14hd03m"]);
  });
});

describe("reconciledStatusWithTasks", () => {
  test("turn-ended correction lands on waiting while tasks are open", () => {
    expect(reconciledStatusWithTasks("working", "idle", true)).toBe("waiting");
    expect(reconciledStatusWithTasks("thinking", "idle", true)).toBe("waiting");
    expect(reconciledStatusWithTasks("working", "idle", false)).toBe("idle");
  });

  test("stored waiting self-heals in both directions, defers otherwise", () => {
    expect(reconciledStatusWithTasks("waiting", "active", false)).toBe("working"); // notification arrived, hook lost
    expect(reconciledStatusWithTasks("waiting", "idle", false)).toBe("idle");      // tasks drained, lost final Stop
    expect(reconciledStatusWithTasks("waiting", "idle", true)).toBeNull();         // still waiting — no correction
    expect(reconciledStatusWithTasks("waiting", "unknown", false)).toBeNull();     // ambiguity defers
  });

  test("non-idle corrections pass through unchanged", () => {
    expect(reconciledStatusWithTasks("idle", "active", false)).toBe("working");
    expect(reconciledStatusWithTasks("idle", "active", true)).toBe("working");
    expect(reconciledStatusWithTasks("connected", "idle", true)).toBeNull();
  });

  test("a declaration made this turn outranks the open-task waiting on any settle", () => {
    expect(reconciledStatusWithTasks("working", "idle", true, "dormant")).toBe("dormant");
    expect(reconciledStatusWithTasks("working", "idle", false, "done")).toBe("done");
    // Stored waiting draining with a declaration lands on the declaration.
    expect(reconciledStatusWithTasks("waiting", "idle", false, "dormant")).toBe("dormant");
    // Still-open tasks keep a stored waiting put even with a stamp — no churn.
    expect(reconciledStatusWithTasks("waiting", "idle", true, "done")).toBeNull();
  });

  test("a stored declared verdict holds until the transcript goes active", () => {
    expect(reconciledStatusWithTasks("dormant", "idle", false)).toBeNull();
    expect(reconciledStatusWithTasks("done", "idle", true)).toBeNull();
    expect(reconciledStatusWithTasks("dormant", "unknown", false)).toBeNull();
    // The wake: transcript active → working, whatever the stored verdict.
    expect(reconciledStatusWithTasks("dormant", "active", false)).toBe("working");
    expect(reconciledStatusWithTasks("done", "active", true)).toBe("working");
  });
});

describe("declaredSettleVerdict", () => {
  const NOW = 1_700_000_000_000;
  test("a dormant/done stamp written after the turn began is the settle verdict", () => {
    expect(declaredSettleVerdict(SID, NOW, NOW - 60_000, { at: NOW - 1_000, status: "dormant" })).toBe("dormant");
    expect(declaredSettleVerdict(SID, NOW, NOW - 60_000, { at: NOW - 1_000, status: "done" })).toBe("done");
  });
  test("a stamp older than the current turn is spent — the next settle must earn its own", () => {
    expect(declaredSettleVerdict(SID, NOW, NOW - 60_000, { at: NOW - 120_000, status: "dormant" })).toBeNull();
  });
  test("working / blocked / no status never produce a verdict", () => {
    expect(declaredSettleVerdict(SID, NOW, NOW - 60_000, { at: NOW - 1_000, status: "working" })).toBeNull();
    expect(declaredSettleVerdict(SID, NOW, NOW - 60_000, { at: NOW - 1_000, status: "blocked" })).toBeNull();
    expect(declaredSettleVerdict(SID, NOW, NOW - 60_000, { at: NOW - 1_000 })).toBeNull();
    expect(declaredSettleVerdict(SID, NOW, NOW - 60_000, null)).toBeNull();
  });
  test("with no known turn start, only a stamp newer than the daemon's boot is trusted", () => {
    // turnStart undefined → the module's DAEMON_BOOTED_AT stands in, which is
    // "now" for this test process: a stamp from before it is not trusted…
    expect(declaredSettleVerdict(SID, Date.now(), undefined, { at: Date.now() - 24 * 3_600_000, status: "dormant" })).toBeNull();
    // …a stamp written just now is.
    expect(declaredSettleVerdict(SID, Date.now() + 5, undefined, { at: Date.now() + 1, status: "dormant" })).toBe("dormant");
  });
});

// Turn-boundary regressions (session jx71a1g, 2026-08-20): the agent declared
// `cast state --status dormant`, a workflow subagent's activity hook flipped the
// status to working 2s later, and the settle then read the stamp as an older
// turn's — filing the parked session under needs-input. A turn starts on
// DELIVERED INPUT (a synced user turn), never on hook noise the session's own
// background machinery generates.

describe("statusFlipStartsTurn", () => {
  test("settled → active is a turn start", () => {
    expect(statusFlipStartsTurn(undefined, "working")).toBe(true);
    expect(statusFlipStartsTurn("idle", "working")).toBe(true);
    expect(statusFlipStartsTurn("waiting", "thinking")).toBe(true);
    expect(statusFlipStartsTurn("stopped", "working")).toBe(true);
  });
  test("active → active is the same turn", () => {
    expect(statusFlipStartsTurn("working", "working")).toBe(false);
    expect(statusFlipStartsTurn("thinking", "working")).toBe(false);
    expect(statusFlipStartsTurn("resuming", "working")).toBe(false);
  });
  test("a flip off a declared dormant/done is NOT a turn start — subagent hooks and Stop continuations must not spend the declaration", () => {
    expect(statusFlipStartsTurn("dormant", "working")).toBe(false);
    expect(statusFlipStartsTurn("dormant", "thinking")).toBe(false);
    expect(statusFlipStartsTurn("done", "working")).toBe(false);
  });
  test("settling is never a turn start", () => {
    expect(statusFlipStartsTurn("working", "idle")).toBe(false);
    expect(statusFlipStartsTurn("working", "waiting")).toBe(false);
    expect(statusFlipStartsTurn("working", "dormant")).toBe(false);
  });
});

describe("latestTurnStartTs", () => {
  const T = 1_700_000_000_000;
  test("picks the newest real user turn in the batch", () => {
    expect(latestTurnStartTs([
      { role: "user", timestamp: T },
      { role: "assistant", timestamp: T + 1_000 },
      { role: "user", timestamp: T + 2_000 },
    ])).toBe(T + 2_000);
  });
  test("tool_result replies ride inside a turn and don't count", () => {
    expect(latestTurnStartTs([
      { role: "user", timestamp: T, toolResults: [{ toolUseId: "t1", content: "ok" }] },
      { role: "assistant", timestamp: T + 1_000 },
    ])).toBeNull();
  });
  test("assistant-only batches carry no turn start", () => {
    expect(latestTurnStartTs([{ role: "assistant", timestamp: T }])).toBeNull();
    expect(latestTurnStartTs([])).toBeNull();
  });
});

describe("markTurnStarted + declaredSettleVerdict", () => {
  test("a dormant stamp survives status noise after it — only a delivered turn spends it", () => {
    const sid = "turn-mark-noise-survival";
    const T = Date.now();
    markTurnStarted(sid, T - 120_000); // the user's message began the turn
    const stamp = { at: T - 60_000, status: "dormant" as const };
    // Subagent hook flips never call markTurnStarted (statusFlipStartsTurn
    // rejects dormant→working), so at settle the stamp still covers this turn:
    expect(declaredSettleVerdict(sid, T, undefined, stamp)).toBe("dormant");
    // A genuine wake is a delivered user turn — it spends the declaration:
    markTurnStarted(sid, T - 30_000);
    expect(declaredSettleVerdict(sid, T, undefined, stamp)).toBeNull();
  });
  test("the mark is monotonic — a replayed old batch cannot resurrect a spent stamp", () => {
    const sid = "turn-mark-monotonic";
    const T = Date.now();
    markTurnStarted(sid, T - 10_000); // the real, current turn
    markTurnStarted(sid, T - 120_000); // stale backlog replay must not rewind
    expect(declaredSettleVerdict(sid, T, undefined, { at: T - 60_000, status: "dormant" })).toBeNull();
  });
});

// openBackgroundTaskIds is the on-disk, incremental form. It used to re-read the
// whole transcript on every size change — and the sessions it's called for
// ("waiting" on background work) grow on every heartbeat, so it re-materialized
// multi-MB files as strings each tick (+140MB RSS per 31MB file, measured
// 2026-08-15; daemon peak footprint 934MB). It now keeps the scanner's set and
// a byte offset and reads only appended bytes. These pin: same verdict as a
// whole-file scan across appends, a torn tail is deferred not consumed, and a
// rewrite (size shrinks) restarts from zero.
describe("openBackgroundTaskIds (incremental)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const tmpTranscript = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "open-tasks-"));
    dirs.push(d);
    return path.join(d, `${SID}.jsonl`);
  };
  const wholeFile = (p: string) => [...scanOpenBackgroundTasks(fs.readFileSync(p, "utf8"), SID)].sort();

  test("the restart fence drops tasks armed before the agent process started", () => {
    // Timestamped lines: one task armed at T0, one at T0+10min. An agent
    // process that started at T0+5min inherited only the transcript — the
    // first task's shell died with the process that spawned it, and no
    // terminal notification will ever be written for it.
    const T0 = Date.parse("2026-08-17T15:00:00.000Z");
    const stamped = (obj: Record<string, unknown>, at: number) => JSON.stringify({ ...obj, timestamp: new Date(at).toISOString() });
    const open = (id: string, at: number) =>
      stamped({ type: "user", sessionId: SID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: `Command did not complete within its 400s timeout and was moved to the background (ID: ${id}).` }] } }, at);
    const p = tmpTranscript();
    fs.writeFileSync(p, open("old", T0) + "\n" + open("fresh", T0 + 10 * 60_000) + "\n");
    // No fence: both open.
    expect(openBackgroundTaskIds(p, SID).sort()).toEqual(["fresh", "old"]);
    // Process started between them: only the later one survives.
    expect(openBackgroundTaskIds(p, SID, T0 + 5 * 60_000)).toEqual(["fresh"]);
    // 60s of skew slack: a task armed just before the recorded start still counts.
    expect(openBackgroundTaskIds(p, SID, T0 + 30_000).sort()).toEqual(["fresh", "old"]);
    // A process started after both: nothing is open — the session settles idle.
    expect(openBackgroundTaskIds(p, SID, T0 + 20 * 60_000)).toEqual([]);
  });

  test("matches a whole-file scan after each append", () => {
    const p = tmpTranscript();
    fs.writeFileSync(p, transcript(bgStart("b1"), monitorStart("m1")) + "\n");
    expect(openBackgroundTaskIds(p, SID).sort()).toEqual(["b1", "m1"]);
    expect(openBackgroundTaskIds(p, SID).sort()).toEqual(wholeFile(p));

    fs.appendFileSync(p, notification("b1", "completed") + "\n" + bgStart("b2") + "\n");
    expect(openBackgroundTaskIds(p, SID).sort()).toEqual(["b2", "m1"]);
    expect(openBackgroundTaskIds(p, SID).sort()).toEqual(wholeFile(p));

    fs.appendFileSync(p, taskStop("m1") + "\n" + notification("b2", "stopped") + "\n");
    expect(openBackgroundTaskIds(p, SID)).toEqual([]);
    expect(openBackgroundTaskIds(p, SID)).toEqual(wholeFile(p));
  });

  test("a torn trailing line is not consumed until its newline lands", () => {
    const p = tmpTranscript();
    const closeLine = notification("b1", "completed");
    fs.writeFileSync(p, bgStart("b1") + "\n" + closeLine.slice(0, 40)); // mid-write tail
    expect(openBackgroundTaskIds(p, SID)).toEqual(["b1"]);
    fs.appendFileSync(p, closeLine.slice(40) + "\n");                       // rest of the line arrives
    expect(openBackgroundTaskIds(p, SID)).toEqual([]);
  });

  test("a rewritten (shorter) transcript restarts the scan from zero", () => {
    const p = tmpTranscript();
    fs.writeFileSync(p, transcript(bgStart("b1"), bgStart("b2"), notification("b1", "failed")) + "\n");
    expect(openBackgroundTaskIds(p, SID)).toEqual(["b2"]);
    fs.writeFileSync(p, bgStart("b9") + "\n"); // shorter than the consumed offset
    expect(openBackgroundTaskIds(p, SID)).toEqual(["b9"]);
  });

  test("a transcript larger than one 4MB scan chunk gets the same verdict as a whole-file scan", () => {
    const p = tmpTranscript();
    // ~6MB of filler lines with opens/closes placed so state must carry across
    // chunk boundaries: b1 opens early (chunk 1) and never closes; b2 opens in
    // chunk 1 and closes in the last chunk; m1 opens near the end.
    const filler = line({ type: "assistant", sessionId: SID, message: { role: "assistant", content: [{ type: "text", text: "x".repeat(4000) }] } });
    const parts: string[] = [bgStart("b1"), bgStart("b2")];
    for (let i = 0; i < 1500; i++) parts.push(filler);
    parts.push(notification("b2", "completed"), monitorStart("m1"));
    fs.writeFileSync(p, parts.join("\n") + "\n");
    expect(fs.statSync(p).size).toBeGreaterThan(4 * 1024 * 1024);
    expect(openBackgroundTaskIds(p, SID).sort()).toEqual(["b1", "m1"]);
    expect(openBackgroundTaskIds(p, SID).sort()).toEqual(wholeFile(p));
  });

  test("a single line larger than the scan chunk does not wedge the scan", () => {
    const p = tmpTranscript();
    const huge = line({ type: "assistant", sessionId: SID, message: { role: "assistant", content: [{ type: "text", text: "y".repeat(5 * 1024 * 1024) }] } });
    fs.writeFileSync(p, transcript(bgStart("b1"), huge, monitorStart("m1")) + "\n");
    expect(openBackgroundTaskIds(p, SID).sort()).toEqual(["b1", "m1"]);
  });

  test("a different sessionId filter invalidates the cached state", () => {
    const p = tmpTranscript();
    fs.writeFileSync(p, transcript(bgStart("mine", SID), bgStart("theirs", "other-session")) + "\n");
    expect(openBackgroundTaskIds(p, SID)).toEqual(["mine"]);
    expect(openBackgroundTaskIds(p, undefined).sort()).toEqual(["mine", "theirs"]);
    expect(openBackgroundTaskIds(p, SID)).toEqual(["mine"]);
  });
});

// ---- The daemon knows WHAT is open, and checks it against live processes ----
describe("openBackgroundTasks — the scanner joins each start to the call that armed it", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "open-tasks-"));
  const bgCall = (id: string, description: string, command: string, run_in_background = true) =>
    line({ type: "assistant", sessionId: SID, message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command, description, run_in_background } }] } });
  const bgResult = (toolUseId: string, taskId: string) =>
    line({ type: "user", sessionId: SID, timestamp: "2026-08-17T18:58:38.000Z", message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/tasks/${taskId}.output` }] } });
  const monCall = (id: string, description: string, command: string) =>
    line({ type: "assistant", sessionId: SID, message: { role: "assistant", content: [{ type: "tool_use", id, name: "Monitor", input: { command, description, timeout_ms: 60000, persistent: false } }] } });
  const monResult = (toolUseId: string, taskId: string) =>
    line({ type: "user", sessionId: SID, message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content: `Monitor started (task ${taskId}, timeout 60000ms). You will be notified on each event.` }] } });

  test("background Bash and Monitor starts carry kind, description, command, tool_use_id and start time", () => {
    const d = dir();
    const f = path.join(d, "t.jsonl");
    fs.writeFileSync(f, transcript(
      bgCall("tu1", "Wait for EAS build to finish", "until s=$(eas build:view x); do sleep 60; done\necho BUILD $s"),
      bgResult("tu1", "byd1rplmv"),
      monCall("tu2", "errors in deploy.log", "tail -f deploy.log | grep --line-buffered ERROR"),
      monResult("tu2", "mon1"),
    ) + "\n");
    const tasks = openBackgroundTasks(f, SID);
    expect(tasks.map((t) => t.id).sort()).toEqual(["byd1rplmv", "mon1"]);
    const bg = tasks.find((t) => t.id === "byd1rplmv")!;
    expect(bg).toMatchObject({ kind: "background", description: "Wait for EAS build to finish", tool_use_id: "tu1", started_at: Date.parse("2026-08-17T18:58:38.000Z") });
    expect(bg.command).toBe("until s=$(eas build:view x); do sleep 60; done\necho BUILD $s");
    expect(tasks.find((t) => t.id === "mon1")).toMatchObject({ kind: "monitor", description: "errors in deploy.log", tool_use_id: "tu2" });
    // The published shape cuts the command to its first line and drops scan-private fields.
    const reports = toOpenTaskReports(tasks);
    expect(reports.find((r) => r.id === "byd1rplmv")).toEqual({ id: "byd1rplmv", kind: "background", description: "Wait for EAS build to finish", command: "until s=$(eas build:view x); do sleep 60; done", started_at: Date.parse("2026-08-17T18:58:38.000Z"), tool_use_id: "tu1" });
    expect(Object.keys(reports[0])).not.toContain("openedAt");
    fs.rmSync(d, { recursive: true, force: true });
  });

  test("a promoted foreground command keeps its call's description and command", () => {
    const d = dir();
    const f = path.join(d, "t.jsonl");
    fs.writeFileSync(f, transcript(
      bgCall("tu9", "Confirm second deploy", "until tmux capture-pane -p | grep -q DEPLOY_DONE; do sleep 5; done", false),
      line({ type: "user", sessionId: SID, message: { role: "user", content: [{ tool_use_id: "tu9", type: "tool_result", content: "Command did not complete within its 400s timeout and was moved to the background (ID: bpzokfxpp). Output is being written to: /tmp/x" }] } }),
    ) + "\n");
    expect(openBackgroundTasks(f, SID)[0]).toMatchObject({ id: "bpzokfxpp", kind: "promoted", description: "Confirm second deploy", command: "until tmux capture-pane -p | grep -q DEPLOY_DONE; do sleep 5; done" });
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("verifyOpenTasks — a shell-backed task is alive while its child shell exists", () => {
  const AGENT = 53695;
  const NOW = 1_800_000_000_000;
  const wrapper = (cmd: string) =>
    `/bin/bash -c source /Users/x/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && shopt -u extglob 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval '${cmd}' < /dev/null && pwd -P >| /tmp/claude-6e5b-cwd`;
  const snap = (procs: Array<{ pid: number; ppid: number; command: string }>) => ({ at: NOW, procs });
  const task = (over: Partial<OpenTaskInfo>): OpenTaskInfo => ({ id: "t1", kind: "background", command: "sleep 240; echo done-probe-task", openedAt: NOW - 10 * 60_000, ...over });

  test("alive: a child of the agent whose command line carries eval '<command>", () => {
    const s = snap([{ pid: 41719, ppid: AGENT, command: wrapper("sleep 240; echo done-probe-task") }]);
    expect(verifyOpenTasks([task({})], s, AGENT).alive.map((t) => t.id)).toEqual(["t1"]);
  });

  test("dead: no such child (the harness lost the notice, or the shell died) — the 2026-08-17 phantom", () => {
    const s = snap([{ pid: 1, ppid: 0, command: "/sbin/launchd" }, { pid: AGENT, ppid: 100, command: "claude --resume abc" }]);
    const v = verifyOpenTasks([task({ id: "bpzokfxpp", kind: "promoted", command: "until tmux capture-pane; do sleep 5; done" })], s, AGENT);
    expect(v.dead.map((t) => t.id)).toEqual(["bpzokfxpp"]);
    expect(v.alive).toEqual([]);
  });

  test("a matching shell under ANOTHER agent does not count (same command text, different session)", () => {
    const s = snap([{ pid: 900, ppid: 777, command: wrapper("sleep 240; echo done-probe-task") }]);
    expect(verifyOpenTasks([task({})], s, AGENT).dead.length).toBe(1);
  });

  test("an orphaned shell (reparented to launchd after the agent died) does not count", () => {
    const s = snap([{ pid: 3579, ppid: 1, command: wrapper("sleep 240; echo done-probe-task") }]);
    expect(verifyOpenTasks([task({})], s, AGENT).dead.length).toBe(1);
  });

  test("a monitor's script is checked the same way (single quotes stop the needle, not the match)", () => {
    const s = snap([{ pid: 44447, ppid: AGENT, command: wrapper(`sleep 200; echo probe-monitor-'"'"'it'"'"''"'"'s'"'"'-done`) }]);
    expect(verifyOpenTasks([task({ kind: "monitor", command: "sleep 200; echo probe-monitor-'it''s'-done" })], s, AGENT).alive.length).toBe(1);
  });

  test("lenient by construction: no snapshot, no agent pid, a workflow, an unusable command, a task younger than the snapshot", () => {
    const empty = snap([]);
    expect(verifyOpenTasks([task({})], undefined, AGENT).alive.length).toBe(1);
    expect(verifyOpenTasks([task({})], empty, undefined).alive.length).toBe(1);
    expect(verifyOpenTasks([task({ kind: "workflow", command: undefined })], empty, AGENT).alive.length).toBe(1);
    expect(verifyOpenTasks([task({ command: "'quoted first'" })], empty, AGENT).alive.length).toBe(1);
    expect(verifyOpenTasks([task({ openedAt: NOW - 5_000 })], empty, AGENT).alive.length).toBe(1);
    // …and past the grace it is judged.
    expect(verifyOpenTasks([task({ openedAt: NOW - 60_000 })], empty, AGENT).dead.length).toBe(1);
  });

  test("taskProcessNeedle stops at the first quote or newline", () => {
    expect(taskProcessNeedle("until grep -q 'x' f; do sleep 5; done")).toBe("eval 'until grep -q ");
    expect(taskProcessNeedle("cd /a\nnpm run dev")).toBe("eval 'cd /a");
    expect(taskProcessNeedle("'x'")).toBeUndefined();
    expect(taskProcessNeedle(undefined)).toBeUndefined();
  });

  test("parseProcessTable folds a multi-line command back onto its row", () => {
    const procs = parseProcessTable("  10  1 /sbin/launchd\n 41719 53695 /bin/bash -c eval 'cd /a\nnpm run dev' < /dev/null\n 42 10 tail -f x\n");
    expect(procs.length).toBe(3);
    expect(procs[1]).toEqual({ pid: 41719, ppid: 53695, command: "/bin/bash -c eval 'cd /a\nnpm run dev' < /dev/null" });
  });
});

describe("paneReconcileTarget — a parked waiting over an idle pane is re-derived", () => {
  test("stored waiting + idle pane -> idle (the caller re-runs the settle verdict, which re-checks the tasks)", () => {
    expect(paneReconcileTarget("idle", "waiting")).toBe("idle");
    // A stored idle re-derives too — the climb-back for a waiting a false
    // task-death verdict collapsed (stale cached agent pid, 2026-08-30).
    expect(paneReconcileTarget("idle", "idle")).toBe("idle");
    // Declared verdicts are still left alone by the pane: nothing to re-check.
    expect(paneReconcileTarget("idle", "dormant")).toBeNull();
    expect(paneReconcileTarget("idle", "done")).toBeNull();
  });
});


// The restart-proof turn fence: the transcript's own last delivered input,
// read from a raw JSONL tail. Before this existed, every daemon restart read
// pre-boot `cast state dormant|done` stamps as untrusted and the boot
// reconcile republished "idle" over 17 parked sessions' declared verdicts
// (2026-08-31).
describe("transcriptTailTurnStartTs", () => {
  const line = (o: object) => JSON.stringify(o) + "\n";
  const T1 = "2026-08-31T10:00:00.000Z";
  const T2 = "2026-08-31T11:00:00.000Z";

  test("returns the newest real user turn's timestamp", () => {
    const tail =
      line({ type: "user", sessionId: "s1", timestamp: T1, message: { role: "user", content: "do the thing" } }) +
      line({ type: "assistant", sessionId: "s1", timestamp: T2, message: { role: "assistant", content: [] } }) +
      line({ type: "user", sessionId: "s1", timestamp: T2, message: { role: "user", content: "and this" } });
    expect(transcriptTailTurnStartTs(tail, "s1")).toBe(Date.parse(T2));
  });

  test("tool_result replies ride inside a turn and never start one", () => {
    const tail =
      line({ type: "user", sessionId: "s1", timestamp: T1, message: { role: "user", content: "go" } }) +
      line({ type: "user", sessionId: "s1", timestamp: T2, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
    expect(transcriptTailTurnStartTs(tail, "s1")).toBe(Date.parse(T1));
  });

  test("a resumed file's replayed prior-run lines are scoped out", () => {
    const tail =
      line({ type: "user", sessionId: "old", timestamp: T2, message: { role: "user", content: "prior run" } }) +
      line({ type: "user", sessionId: "s1", timestamp: T1, message: { role: "user", content: "this run" } });
    expect(transcriptTailTurnStartTs(tail, "s1")).toBe(Date.parse(T1));
  });

  test("no user turn in the window (or a torn tail) -> null", () => {
    expect(transcriptTailTurnStartTs("", "s1")).toBeNull();
    expect(transcriptTailTurnStartTs('{"type":"assistant"', "s1")).toBeNull();
  });

  test("a stamp written after the tail's turn start is the current turn's declaration", () => {
    const tail = line({ type: "user", sessionId: "s1", timestamp: T1, message: { role: "user", content: "park yourself" } });
    const turnStart = transcriptTailTurnStartTs(tail, "s1")!;
    // The stamp postdates the delivered input -> trusted, however old the daemon is.
    expect(declaredSettleVerdict("s1", Date.parse(T2), turnStart, { at: Date.parse(T1) + 5_000, status: "dormant" })).toBe("dormant");
  });
});

// The scan window: a line longer than one chunk grows the buffer one chunk
// per step, never to the whole remaining file, and the async prime leaves
// nothing for the synchronous hook path scan to read.
describe("openBackgroundTasks window growth and primeOpenTaskScan", () => {
  const dir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "open-tasks-window-"));
    cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
    return d;
  };
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
  // A big tool result: one record, `bytes` long, that carries no task text.
  const bigLine = (bytes: number) => toolResult("x".repeat(bytes));
  // Enough short records to fill `bytes`.
  const filler = (bytes: number) => {
    const out: string[] = [];
    for (let n = 0; n < bytes; ) {
      const l = toolResult(`filler ${out.length} ` + "y".repeat(50_000));
      out.push(l);
      n += l.length + 1;
    }
    return out;
  };

  test("a 9MB single line grows the scan buffer one chunk at a time and the task after it is still found", () => {
    const d = dir();
    const f = path.join(d, "t.jsonl");
    fs.writeFileSync(f, transcript(bigLine(9 * 1024 * 1024), ...filler(20 * 1024 * 1024), bgStart("after-big")) + "\n");
    const size = fs.statSync(f).size;
    // The scan's first window, read the way openBackgroundTasks reads it:
    // windows of 4, 8 and 16MB reach the 9MB line's newline, so the window
    // holds at most 16MB. The old escape jumped to the whole 29MB file.
    const fd = fs.openSync(f, "r");
    try {
      const first = readCompleteLinesSync(fd, 0, size, { step: SCAN_CHUNK_BYTES });
      expect(first.steps).toBe(3);
      expect(first.bytesConsumed).toBeGreaterThan(9 * 1024 * 1024);
      expect(first.bytesConsumed).toBeLessThanOrEqual(4 * SCAN_CHUNK_BYTES);
    } finally {
      fs.closeSync(fd);
    }
    expect(openBackgroundTasks(f, SID).map((t) => t.id)).toEqual(["after-big"]);
    expect(openTaskScanOffset(f)).toBe(size);
  }, 60_000);

  test("primeOpenTaskScan reads a fresh 30MB transcript off the loop and leaves the sync scan nothing to read", async () => {
    const d = dir();
    const f = path.join(d, "t.jsonl");
    fs.writeFileSync(f, transcript(...filler(30 * 1024 * 1024), bgStart("primed-task")) + "\n");
    const size = fs.statSync(f).size;
    const { maxGapMs, ticks } = await measureLoopHold(() => primeOpenTaskScan(f, SID));
    expect(ticks).toBeGreaterThan(0);
    expect(maxGapMs).toBeLessThan(loopHoldBoundMs(200));
    expect(openTaskScanOffset(f)).toBe(size);
    // With the file unreadable, a sync scan that still had bytes to read would
    // fail and claim no tasks; the primed answer survives because it reads nothing.
    fs.chmodSync(f, 0o000);
    cleanups.push(() => fs.chmodSync(f, 0o644));
    expect(openBackgroundTasks(f, SID).map((t) => t.id)).toEqual(["primed-task"]);
    expect(openTaskScanOffset(f)).toBe(size);
  }, 60_000);

  // The semaphore bounds the reads, not the stat: a transcript the scan has
  // already covered answers at once, however many whole transcript primes
  // are queued ahead of it (the recovered session scan queues the fleet).
  test("a primed transcript does not wait behind the fleet's reads for a prime slot", async () => {
    const d = dir();
    const primed = path.join(d, "primed.jsonl");
    fs.writeFileSync(primed, transcript(...filler(64 * 1024), bgStart("early")) + "\n");
    await primeOpenTaskScan(primed, SID);
    expect(openTaskScanOffset(primed)).toBe(fs.statSync(primed).size);
    // Five whole transcript primes: four take every slot, the fifth queues.
    const big = Array.from({ length: 5 }, (_, i) => {
      const f = path.join(d, `big-${i}.jsonl`);
      fs.writeFileSync(f, transcript(...filler(9 * 1024 * 1024)) + "\n");
      return primeOpenTaskScan(f, `${SID.slice(0, -1)}${i}`).then(() => "big");
    });
    const cheap = primeOpenTaskScan(primed, SID).then(() => "cheap");
    expect(await Promise.race([cheap, ...big])).toBe("cheap");
    await Promise.all(big);
    expect(openBackgroundTasks(primed, SID).map((t) => t.id)).toEqual(["early"]);
  }, 60_000);

  // The prime awaits each read; a Stop hook landing meanwhile runs the sync
  // scan on the same state. The chunk in flight must then be dropped, or its
  // lines replay after later ones (a task closed later reopens) and the
  // offset lands past EOF (the next sync scan reads that as a shrink and
  // rescans the whole transcript on the loop).
  test("a sync scan landing while the prime has a read in flight never replays a chunk", async () => {
    const d = dir();
    // Proof the interleave happened at all: the sync scan must land before
    // the prime finished in at least one round, or the test proves nothing.
    let interleaved = 0;
    for (const delayMs of [0, 4, 16, 40]) {
      const f = path.join(d, `t-${delayMs}.jsonl`);
      fs.writeFileSync(f, transcript(...filler(1024 * 1024)) + "\n");
      openBackgroundTasks(f, SID);
      fs.appendFileSync(f, transcript(
        ...filler(8 * 1024 * 1024), bgStart("closed-later"),
        ...filler(8 * 1024 * 1024), notification("closed-later", "completed"),
        ...filler(8 * 1024 * 1024), bgStart("still-open"),
      ) + "\n");
      const size = fs.statSync(f).size;
      const prime = primeOpenTaskScan(f, SID);
      await new Promise((r) => setTimeout(r, delayMs));
      if ((openTaskScanOffset(f) ?? 0) < size) interleaved++;
      openBackgroundTasks(f, SID);
      await prime;
      expect(openTaskScanOffset(f)).toBe(size);
      expect(openBackgroundTasks(f, SID).map((t) => t.id)).toEqual(["still-open"]);
      expect(openTaskScanOffset(f)).toBe(size);
    }
    expect(interleaved).toBeGreaterThan(0);
  }, 120_000);

  // The fleet is tmux managed, and those sessions take the pane verdict, not
  // the transcript one. They still get the prime on the maintenance
  // reconcile, so the pane path's and the Stop hook's sync scan is a delta.
  test("a tmux managed claude session is primed by the maintenance reconcile", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "open-tasks-managed-"));
    const prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    resetSessionFileIndexForTests();
    cleanups.push(() => {
      process.env.HOME = prevHome;
      resetSessionFileIndexForTests();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });
    const sid = "bbbbbbbb-0000-4000-8000-000000000002";
    const projectDir = path.join(tmpHome, ".claude", "projects", "-Users-x-proj");
    fs.mkdirSync(projectDir, { recursive: true });
    const f = path.join(projectDir, `${sid}.jsonl`);
    fs.writeFileSync(f, transcript(...filler(9 * 1024 * 1024), bgStart("managed-task", sid)) + "\n");
    const size = fs.statSync(f).size;
    registerManagedStartedSession("conv-managed", sid, "cc-managed-test");
    expect(openTaskScanOffset(f)).toBeUndefined();
    const { maxGapMs } = await measureLoopHold(() => reconcileStatusFromTranscript(sid, {} as any));
    expect(maxGapMs).toBeLessThan(loopHoldBoundMs(200));
    expect(openTaskScanOffset(f)).toBe(size);
    expect(openBackgroundTasks(f, sid).map((t) => t.id)).toEqual(["managed-task"]);
  }, 60_000);
});

// The hook's idle settle runs on the daemon's loop, so handleStatusData
// primes the open task scan and reads the transcript tail off the loop first,
// then re-enters with `{ primed: true, tail }`; resolveTurnEndStatus takes
// that tail instead of reading 64KB itself.
describe("hook idle settle: the tail read off the loop is the one the settle uses", () => {
  test("a known tail replaces the sync read; an interrupted tail settles idle over open work", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-settle-tail-"));
    const p = path.join(dir, `${SID}.jsonl`);
    try {
      fs.writeFileSync(p, bgStart("t1") + "\n");
      const file = { path: p, agentType: "claude" as const };
      // Open work in the file, no tail given: the settle reads the file and parks the turn.
      expect(resolveTurnEndStatus(SID, file)).toBe("waiting");
      // The same file with a tail the caller read: the tail decides.
      expect(resolveTurnEndStatus(SID, file, "")).toBe("waiting");
      const interrupted = line({ type: "user", sessionId: SID, message: { role: "user", content: "[Request interrupted by user]" } });
      expect(resolveTurnEndStatus(SID, file, interrupted)).toBe("idle");
      // A failed read (null) is not a reason to read again.
      expect(resolveTurnEndStatus(SID, { path: path.join(dir, "missing.jsonl"), agentType: "claude" }, null)).toBe("idle");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handleStatusData hands the async tail to the settle and never reads it on the loop", () => {
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "daemon.ts"), "utf8");
    const body = functionBlock(src, "handleStatusData", { from: src.indexOf("async function main(") }).text;
    expect(body.length).toBeGreaterThan(5000);
    expect(body).toContain("readFileTailAsync(transcript)");
    expect(body).toContain("{ primed: true, tail }");
    expect(body).toContain("opts?.tail,");
    expect(body).not.toContain("readFileTailSync");
    // A newer status that lands during the hop wins: the ts guards run
    // before the primed re-entry reaches the settle.
    expect(body.indexOf("prev.ts > data.ts")).toBeLessThan(body.indexOf("primed: true"));
  });
});

// The hook path reads transcript tails and writes status files off the loop.
// The async readers must return exactly what the sync twins return, and the
// status persist must chain so two writes for one session land in order.
describe("hook path off the loop: async readers and the persist chain", () => {
  test("readFileTailAsync returns the same bytes as readFileTailSync at every size", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-tail-async-"));
    try {
      const cases: Array<[string, string]> = [
        ["empty", ""],
        ["small", "héllo\nwörld\n"],
        ["exact", "x".repeat(64 * 1024)],
        ["large", `${"ü".repeat(40_000)}\n${"y".repeat(70_000)}\n`],
      ];
      for (const [name, content] of cases) {
        const p = path.join(dir, `${name}.jsonl`);
        fs.writeFileSync(p, content);
        expect(await readFileTailAsync(p), name).toBe(readFileTailSync(p));
        expect(await readFileTailAsync(p, 100), `${name} 100 bytes`).toBe(readFileTailSync(p, 100));
      }
      expect((await readFileTailAsync(path.join(dir, "large.jsonl"))).length).toBeLessThanOrEqual(64 * 1024);
      await expect(readFileTailAsync(path.join(dir, "missing.jsonl"))).rejects.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the async pending tool extractor matches the tail extractor and answers null for a missing file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pending-tool-"));
    try {
      const p = path.join(dir, `${SID}.jsonl`);
      fs.writeFileSync(
        p,
        transcript(
          line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "rm -rf build" } }] } }),
        ) + "\n",
      );
      const viaAsync = await extractPendingToolUseFromTranscriptAsync(p);
      expect(viaAsync).toEqual(extractPendingToolUseFromTail(readFileTailSync(p, 32768)));
      expect(viaAsync?.tool_name).toBe("Bash");
      expect(viaAsync?.arguments_preview).toBe("rm -rf build");
      expect(await extractPendingToolUseFromTranscriptAsync(path.join(dir, "missing.jsonl"))).toBeNull();
      expect(await extractPendingToolUseFromTranscriptAsync("")).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persistHookStatus writes through one ordered promise chain, and the boot replay reads the status dir async", () => {
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "daemon.ts"), "utf8");
    const main = src.indexOf("async function main(");
    const persist = functionBlock(src, "persistHookStatus", { from: main }).text;
    expect(persist).toContain("persistChain = persistChain");
    expect(persist).toContain("fs.promises.writeFile(");
    expect(persist).not.toContain("writeFileSync");
    const statusFile = functionBlock(src, "handleStatusFile", { from: main }).text;
    expect(statusFile).toContain("fs.promises.readFile(");
    expect(statusFile).not.toContain("readFileSync");
    // The replay of on disk status files at boot goes through the shared
    // async reader, not a readdirSync loop.
    const replay = src.slice(main, src.indexOf("function claudeTranscriptFor", main));
    expect(replay).toContain("readAgentStatusFiles().then(");
    expect(replay).not.toContain("readdirSync(AGENT_STATUS_DIR)");
  });

  test("the hook callback persists once per status: the idle hop's re-entry persists, the callback skips", () => {
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "daemon.ts"), "utf8");
    const main = src.indexOf("async function main(");
    const handle = functionBlock(src, "handleStatusData", { from: main }).text;
    // The hop reports the deferral, after scheduling its own persist.
    const hop = handle.indexOf("persistHookStatus(sessionId, settle)");
    expect(hop).toBeGreaterThan(0);
    expect(handle.indexOf("return true;")).toBeGreaterThan(hop);
    const callback = blockAt(src, src.indexOf("setHookStatusSink(", main)).text;
    expect(callback).toContain("const deferred = handleStatusData(sessionId, data);");
    expect(callback).toContain("if (!deferred) persistHookStatus(sessionId, data);");
  });

  test("a permission record is created only if the session still says permission_blocked after the tail read", () => {
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "daemon.ts"), "utf8");
    const handle = functionBlock(src, "handleStatusData", { from: src.indexOf("async function main(") }).text;
    const read = handle.indexOf("extractPendingToolUseFromTranscriptAsync(transcriptPath");
    const gate = handle.indexOf('lastHookStatus.get(sessionId)?.status !== "permission_blocked"');
    const create = handle.indexOf("Creating permission record");
    expect(read).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(read);
    expect(create).toBeGreaterThan(gate);
  });
});
