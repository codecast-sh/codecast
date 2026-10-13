import { describe, expect, test } from "bun:test";
import { generateCodexJsonl, type ExportResult } from "./jsonlGenerator";

const timestamp = "2026-09-04T21:39:00.000Z";
const importedId = "interactive-prompt-724d7618-2899-484e-a2ef-c5092c34fdc2-f52c1423b993f5fd";

function generate(ids: string[], restore: boolean) {
  const data: ExportResult = {
    conversation: {
      id: "conversation", title: "Imported workflow", session_id: "session",
      agent_type: "claude", model: null, project_path: "/tmp/project",
      message_count: ids.length * 2, started_at: timestamp, updated_at: timestamp,
    },
    messages: ids.flatMap((id, index) => [
      { role: "assistant", content: "", timestamp,
        tool_calls: [{ id, name: "AskUserQuestion", input: '{"question":"Continue?"}' }] },
      { role: index % 2 ? "assistant" : "user", content: "", timestamp,
        tool_results: [{ tool_use_id: id, content: "Continue", is_error: Boolean(index % 2) }] },
    ]),
  };
  return generateCodexJsonl(data, restore ? { sessionId: "session" } : {}).jsonl
    .trim().split("\n").map(line => JSON.parse(line))
    .filter(entry => entry.type === "response_item" && entry.payload.call_id)
    .map(entry => entry.payload);
}

describe("Codex import tool-call IDs", () => {
  for (const restore of [false, true]) {
    test(`${restore ? "restoring" : "importing"} bounds IDs and preserves call/result pairing`, () => {
      const ids = [importedId, importedId.slice(0, -1) + "e", "toolu_valid", "x".repeat(64)];
      const rows = generate(ids, restore);
      expect(rows).toHaveLength(8);
      expect(rows.every(row => row.call_id.length <= 64)).toBe(true);
      expect(new Set(rows.filter(row => row.type === "function_call").map(row => row.call_id)).size).toBe(4);
      ids.forEach((id, index) => {
        const call = rows[index * 2];
        const result = rows[index * 2 + 1];
        expect(call.type).toBe("function_call");
        expect(result.type).toBe("function_call_output");
        expect(result.call_id).toBe(call.call_id);
        expect(result.output).toContain("Continue");
        if (id.length <= 64) expect(call.call_id).toBe(id);
      });
      expect(generate(ids, restore)).toEqual(rows);
    });
  }
});
