import { describe, expect, test } from "bun:test";
import { CodexAppServer } from "./codexAppServer";
import { parseCodexSessionFile } from "./parser";
import { classifyApiErrorBanner } from "@codecast/shared/contracts";

const message = "This request was blocked by our safety systems. Reason: Potentially unintended activity.";
const timestamp = "2026-09-05T15:36:22.260Z";
const jsonl = (entries: object[]) => entries.map(entry => JSON.stringify({ timestamp, ...entry })).join("\n");

describe("Codex failed-turn ingestion", () => {
  test("imports a structured rollout failure as a separate stable banner after partial output", () => {
    const transcript = jsonl([
      { type: "turn_context", payload: { model: "gpt-6-astra" } },
      { type: "response_item", payload: { type: "message", id: "partial", role: "assistant", content: [{ type: "output_text", text: "No. The repository pages are" }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn1", error: { message, codex_error_info: "misalignment_policy_violation" } } },
    ]);
    const messages = parseCodexSessionFile(transcript);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("No. The repository pages are");
    expect(messages[1]).toMatchObject({ uuid: "codex-turn-error-turn1", timestamp: Date.parse(timestamp), model: "gpt-6-astra", role: "assistant" });
    expect(classifyApiErrorBanner(messages[1].content)).toBe("safety");
    expect(parseCodexSessionFile(transcript)[1].uuid).toBe(messages[1].uuid);
  });

  test.each([false, true])("live app-server emits the same safety banner with partial output=%s", partial => {
    const server = new CodexAppServer({ log: () => {} });
    let result: any[] = [];
    server.on("turnCompleted", (...args) => { result = args; });
    const notify = (method: string, params: object) => (server as any).handleNotification({ method, params: { threadId: "thread1", ...params } });
    notify("turn/started", { turn: { id: "turn1" } });
    if (partial) notify("item/completed", { turnId: "turn1", item: { type: "agentMessage", id: "partial", text: "Partial answer" } });
    const error = { codexErrorInfo: "misalignmentPolicyViolation", message };
    notify("turn/completed", { turn: { id: "turn1", status: "failed", error } });
    const messages = result[2];
    expect(messages).toHaveLength(partial ? 2 : 1);
    expect(messages.at(-1).uuid).toBe("codex-turn-error-turn1");
    expect(classifyApiErrorBanner(messages.at(-1).content)).toBe("safety");
    if (partial) expect(messages[1].timestamp).toBeGreaterThan(messages[0].timestamp);
    expect(result[3]).toBe("failed");
    expect(result[4]).toEqual(error);
  });

  test("completed and interrupted turns do not invent an error", () => {
    expect(parseCodexSessionFile(jsonl([{ type: "event_msg", payload: { type: "task_complete", turn_id: "ok" } }]))).toEqual([]);
    const server = new CodexAppServer({ log: () => {} });
    const results: any[] = [];
    server.on("turnCompleted", (...args) => results.push(args));
    for (const status of ["completed", "interrupted"]) {
      (server as any).handleNotification({ method: "turn/completed", params: { threadId: "thread1", turn: { id: status, status } } });
    }
    expect(results.map(r => r[2])).toEqual([[], []]);
  });
});
