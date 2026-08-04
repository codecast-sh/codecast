import { describe, expect, test } from "bun:test";
import { reconciledStatusWithTasks, scanOpenBackgroundTasks } from "./daemon.js";

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
});
