// Muse (`muse` CLI) session.jsonl parsing + tail classification + cwd.
// The fixture below is FULLY SYNTHETIC — hand-composed to the session.jsonl
// envelope shape (verified byte-shape against a real captured session, then
// written from scratch with throwaway run/message ids and fabricated tool
// output, no real user data).
import { test, expect, describe } from "bun:test";
import {
  parseMuseSessionFile,
  parseTranscriptFor,
  extractMuseCwd,
} from "./parser.js";
import { classifyMuseTranscriptTail } from "./workers/ingestMetadata.js";
import { classifyTranscriptTailFor } from "./daemon.js";

const RUN = "0a5a259f-41ac-43a0-88a8-aaca8a4b4f79";
const MODEL = "muse-spark-1.3-contributor";

function env(kind: string, event: unknown, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    schema_version: 1,
    id: "53ed805d-75a0-4549-a84d-5689a6c422b7",
    stream: { kind: "session", id: "01a0b4fd-4cc4-7a82-b681-d0caa9b1e479" },
    recorded_at: 1789742968906636,
    payload_type: "runtime.session",
    payload: { kind, run_id: RUN, event, ...(extra ?? {}) },
  });
}

const FIXTURE = [
  // line-1 style retained permission frame (no payload envelope shape) is skipped
  JSON.stringify({ retained_frame: "session_permission_transaction", children: [] }),
  JSON.stringify({
    schema_version: 1,
    recorded_at: 1789742894286414,
    payload_type: "runtime.session",
    payload: { kind: "route_facts", record: { cwd: "/tmp/muse-probe", pid: 1 } },
  }),
  JSON.stringify({
    schema_version: 1,
    recorded_at: 1789742894286415,
    payload_type: "runtime.session",
    payload: { kind: "run_model", record: { run_stream: { kind: "run", id: RUN }, model_id: MODEL } },
  }),
  env("run", { kind: "started", prompt: "list the workspace root" }),
  env("run", {
    kind: "assistant_tool_calls_committed",
    message_id: "msg-calls",
    tool_calls: [
      { id: "fc_1", call_id: "call_1", name: "bash", args: JSON.stringify({ command: "ls -la", description: "List root" }) },
      // non-JSON args degrade to {} instead of failing the parse
      { id: "fc_2", call_id: "call_2", name: "bash", args: "not-json{{{ " },
    ],
  }),
  env("run", {
    kind: "tool_result_batch_committed",
    batch_id: "batch-1",
    results: [{ tool_call_index: 0, tool_call_id: "call_1", text: "total 8\ndrwxr-xr-x 3 staff 96 .\n" }],
  }),
  env("run", { kind: "assistant_message_committed", message_id: "msg-1", text: "The root holds three entries." }),
  env("run", { kind: "reasoning_summary_committed", message_id: "m1", text: "Listed the directory." }),
  env("run", { kind: "model_completed", usage: { input_tokens: 100, output_tokens: 20, cached_tokens: 40 } }),
  env("run", { kind: "terminal", terminal: "completed", reason: null }),
  // raw chain-of-thought is skipped, never synced
  env("run", { kind: "reasoning_committed", message_id: "m2", text: "verbatim internal reasoning" }),
  // torn tail line is skipped, never fails
  '{"schema_version": 1, "payload": {"kind": "run", "event": {"kind": "star',
].join("\n");

describe("parseMuseSessionFile", () => {
  const messages = parseMuseSessionFile(FIXTURE);

  test("dispatches through parseTranscriptFor('muse', …)", () => {
    expect(parseTranscriptFor("muse", FIXTURE)).toEqual(messages);
  });

  test("emits the user turn with the run_id as uuid", () => {
    expect(messages[0]).toMatchObject({ uuid: RUN, role: "user", content: "list the workspace root" });
  });

  test("maps tool calls with parsed JSON args; bad args become {}", () => {
    const withCalls = messages.find((m) => m.toolCalls?.length === 2);
    expect(withCalls).toBeDefined();
    expect(withCalls!.toolCalls![0]).toEqual({ id: "call_1", name: "bash", input: { command: "ls -la", description: "List root" } });
    expect(withCalls!.toolCalls![1].input).toEqual({});
  });

  test("maps tool results onto an assistant message keyed by batch", () => {
    const withResults = messages.find((m) => m.toolResults?.length === 1);
    expect(withResults).toMatchObject({ role: "assistant", uuid: "batch-1" });
    expect(withResults!.toolResults![0]).toMatchObject({ toolUseId: "call_1" });
    expect(withResults!.toolResults![0].content).toContain("total 8");
  });

  test("stamps the run_model model id on assistant messages", () => {
    const assistant = messages.find((m) => m.role === "assistant" && m.content);
    expect(assistant?.model).toBe(MODEL);
  });

  test("attaches the reasoning summary as thinking and usage on the turn", () => {
    const assistant = messages.find((m) => m.role === "assistant" && m.content);
    expect(assistant?.thinking).toBe("Listed the directory.");
    expect(assistant?.usage).toMatchObject({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 });
  });

  test("never surfaces raw chain-of-thought or the torn tail", () => {
    expect(JSON.stringify(messages)).not.toContain("verbatim internal reasoning");
    expect(messages.length).toBe(4);
  });

  test("extractMuseCwd reads the route_facts record", () => {
    expect(extractMuseCwd(FIXTURE)).toBe("/tmp/muse-probe");
    expect(extractMuseCwd("")).toBeUndefined();
  });

  test("timestamps convert microseconds to millis", () => {
    expect(messages[0].timestamp).toBe(1789742968906);
  });
});

describe("classifyMuseTranscriptTail", () => {
  const tail = (kinds: string[]) =>
    kinds.map((k) => env("run", { kind: k })).join("\n");

  test("terminal reads idle; open turns read active", () => {
    expect(classifyMuseTranscriptTail(tail(["started"]))).toBe("active");
    expect(classifyMuseTranscriptTail(tail(["started", "assistant_message_committed"]))).toBe("active");
    expect(classifyMuseTranscriptTail(tail(["started", "terminal"]))).toBe("idle");
    expect(classifyMuseTranscriptTail(tail(["started", "assistant_tool_calls_committed"]))).toBe("active");
  });

  test("an unresolved approval wait reads active, a resolved one scans past", () => {
    const started = JSON.stringify({
      payload_type: "approval_wait.effect.started",
      payload: { kind: "approval_wait", event: { kind: "started" } },
    });
    const terminal = JSON.stringify({
      payload_type: "approval_wait.effect.terminal",
      payload: { kind: "approval_wait", event: { kind: "terminal" } },
    });
    expect(classifyMuseTranscriptTail(`${tail(["started"])}\n${started}`)).toBe("active");
    expect(classifyMuseTranscriptTail(`${tail(["started"])}\n${started}\n${terminal}`)).toBe("active");
    expect(classifyMuseTranscriptTail(`${tail(["started", "terminal"])}\n${started}\n${terminal}`)).toBe("idle");
  });

  test("empty and housekeeping-only tails defer", () => {
    expect(classifyMuseTranscriptTail("")).toBe("unknown");
    expect(classifyMuseTranscriptTail(tail(["task_stream_linked", "goal_usage_attribution"]))).toBe("unknown");
  });

  test("wires into the daemon classifier map", () => {
    expect(classifyTranscriptTailFor("muse")).toBe(classifyMuseTranscriptTail);
  });
});
