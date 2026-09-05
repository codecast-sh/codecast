import { describe, expect, test } from "bun:test";
import { buildCodexImportContext, CODEX_IMPORT_MAX_BYTES, CODEX_IMPORT_MAX_ITEMS, type CodexImportItem } from "./codexImportContext";
import { generateCodexJsonl, type ExportResult } from "./jsonlGenerator";
import { parseCodexSessionFile } from "./parser";

const msg = (role: string, text: string): CodexImportItem => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
const setup = [msg("developer", "permissions"), msg("user", "project"), msg("user", "environment")];
const bytes = (items: CodexImportItem[]) => Buffer.byteLength(JSON.stringify(items));

function bounded(items: CodexImportItem[]) {
  const result = buildCodexImportContext(items, "jx7b88a")!;
  expect(result).toBeDefined();
  expect(result.length).toBeLessThanOrEqual(CODEX_IMPORT_MAX_ITEMS);
  expect(bytes(result)).toBeLessThanOrEqual(CODEX_IMPORT_MAX_BYTES);
  expect(result.every(item => item.type === "message")).toBe(true);
  expect(JSON.stringify(result)).toContain("cast read jx7b88a");
  return result;
}

describe("bounded Codex import context", () => {
  test("small imports retain their exact native history", () => {
    expect(buildCodexImportContext([...setup, msg("user", "Help"), msg("assistant", "Done")], "thread")).toBeUndefined();
  });

  test("28,000 tiny items stay within the API item cap and retain instructions in order", () => {
    const request = msg("user", "Original mandate");
    const constraint = msg("user", "Never deploy without the green gate");
    const decision = msg("user", "Hold until the gate is green");
    const items = [...setup, request, ...Array.from({ length: 28_000 }, (_, i) => msg("assistant", `step ${i}`))];
    items.splice(100, 0, constraint);
    items.push(decision);
    const result = bounded(items);
    expect(result).toContainEqual(request);
    expect(result).toContainEqual(constraint);
    expect(result.at(-1)).toEqual(decision);
    expect(result.indexOf(request)).toBeLessThan(result.indexOf(constraint));
  });

  test("large tool history is retained as quoted activity without dangling tool calls", () => {
    const items = [...setup, msg("user", "Original mandate"), ...Array.from({ length: 1000 }, (_, i) => [
      { type: "function_call", call_id: `call-${i}`, name: "exec", arguments: '{"cmd":"check"}' },
      { type: "function_call_output", call_id: `call-${i}`, output: "evidence ".repeat(500) },
    ]).flat(), msg("user", "Hold until the gate is green")];
    const result = bounded(items);
    expect(JSON.stringify(result)).toContain("call-999");
    expect(JSON.stringify(result)).toContain("Historical function_call_output");
    expect(result.at(-1)).toEqual(items.at(-1)!);
  });

  test("oversized Unicode instructions and trailing outputs cannot exceed the byte budget", () => {
    const items = [...setup, msg("user", "BEGIN " + "界\"\\".repeat(100_000) + " ORIGINAL END"),
      msg("user", "LATEST START " + "界".repeat(100_000) + " HOLD DEPLOY"),
      { type: "function_call_output", call_id: "missing", output: "界".repeat(200_000) }];
    const result = bounded(items);
    const text = JSON.stringify(result);
    for (const marker of ["BEGIN", "ORIGINAL END", "LATEST START", "HOLD DEPLOY", "Truncated for model context"]) expect(text).toContain(marker);
    expect(items[3]).toEqual(msg("user", "BEGIN " + "界\"\\".repeat(100_000) + " ORIGINAL END"));
  });

  test("many earlier user messages cannot overflow the reserved instruction budget", () => {
    bounded([...setup, ...Array.from({ length: 20_000 }, (_, i) => msg("user", `instruction ${i}`))]);
  });

  test("generated checkpoint preserves every archival row and never duplicates restored messages", () => {
    const timestamp = "2026-09-05T00:00:00.000Z";
    const data: ExportResult = {
      conversation: { id: "jx7b88a", title: "Mandate", session_id: "session", agent_type: "claude", project_path: "/tmp/project", model: null, message_count: 20_002, started_at: timestamp, updated_at: timestamp },
      messages: [
        { role: "user", content: "Original mandate", timestamp },
        ...Array.from({ length: 20_000 }, (_, i) => ({ role: "assistant", content: `historical step ${i}`, timestamp })),
        { role: "user", content: "Hold until the gate is green", timestamp },
      ],
    };
    for (const restore of [false, true]) {
      const { jsonl } = generateCodexJsonl(data, restore ? { sessionId: "session" } : {});
      const rows = jsonl.trim().split("\n").map(line => JSON.parse(line));
      expect(rows.filter(row => row.type === "response_item")).toHaveLength(data.messages.length + 3);
      expect(rows.at(-1).type).toBe("compacted");
      const context = rows.at(-1).payload.replacement_history;
      expect(context.length).toBeLessThanOrEqual(CODEX_IMPORT_MAX_ITEMS);
      expect(bytes(context)).toBeLessThanOrEqual(CODEX_IMPORT_MAX_BYTES);
      expect(JSON.stringify(context.at(-1))).toContain("Hold until the gate is green");
      const archive = rows.slice(0, -1).map(row => JSON.stringify(row)).join("\n");
      expect(parseCodexSessionFile(jsonl)).toEqual(parseCodexSessionFile(archive));
    }
  });
});
