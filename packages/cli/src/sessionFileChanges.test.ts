import { describe, expect, test } from "bun:test";
import { parseCodexSessionFile, parseGeminiSessionFile, parseOpencodeSessionFile, parsePiSessionFile, parseGrokSessionFile, type ParsedMessage } from "./parser";
import { threadItemToMessage } from "./codexAppServer";
import { extractFileChanges, hasFileChangeToolCall, type ExtractableMessage } from "../../convex/convex/fileChanges/extractor";

function synced(messages: ParsedMessage[]): ExtractableMessage[] {
  return messages.map((message, i) => ({
    _id: message.uuid ?? `message-${i}`,
    timestamp: message.timestamp,
    tool_calls: message.toolCalls?.map((call) => ({ ...call, input: JSON.stringify(call.input) })),
    tool_results: message.toolResults?.map((result) => ({
      tool_use_id: result.toolUseId, content: result.content, is_error: result.isError,
    })),
  }));
}

describe("agent transcripts reach the session file diff extractor", () => {
  test("Grok write tools use the same file change list", () => {
    const transcript = [
      { timestamp: 1000, method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "write", title: "write", rawInput: { file_path: "grok.ts", content: "created" } } } },
      { timestamp: 1001, method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "write", status: "completed", content: [{ type: "diff", path: "grok.ts", oldText: "", newText: "created" }] } } },
    ].map(line => JSON.stringify(line)).join("\n");
    expect(extractFileChanges(synced(parseGrokSessionFile(transcript)))[0]).toMatchObject({ filePath: "grok.ts", newContent: "created" });
  });
  test("Codex additions and deletions carry raw file content rather than patch text", () => {
    const message = threadItemToMessage({
      type: "fileChange", id: "files", status: "completed",
      changes: [
        { path: "/repo/new.ts", kind: { type: "add" }, diff: "new file\n" },
        { path: "/repo/old.ts", kind: { type: "delete" }, diff: "old file\n" },
        { path: "/repo/empty.ts", kind: { type: "add" }, diff: "" },
      ],
    });
    expect(extractFileChanges(synced([message!])).map((change) => [change.filePath, change.oldContent, change.newContent]))
      .toEqual([["/repo/new.ts", undefined, "new file"], ["/repo/old.ts", "old file", ""], ["/repo/empty.ts", undefined, ""]]);
  });
  test("Codex app-server keeps headerless patches for two separate files", () => {
    const message = threadItemToMessage({
      type: "fileChange", id: "patch", status: "completed",
      changes: [
        { path: "/repo/a.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old a\n+new a" },
        { path: "/repo/b.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old b\n+new b" },
      ],
    });
    expect(extractFileChanges(synced([message!])).map((change) => [change.filePath, change.oldContent, change.newContent]))
      .toEqual([["/repo/a.ts", "old a", "new a"], ["/repo/b.ts", "old b", "new b"]]);
  });

  test.each(["failed", "declined"])("Codex %s patches are excluded", (status) => {
    const message = threadItemToMessage({
      type: "fileChange", id: "patch", status,
      changes: [{ path: "/repo/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }],
    });
    expect(extractFileChanges(synced([message!]))).toEqual([]);
  });

  test("Codex namespaced raw patches and separately recorded results", () => {
    const input = "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch";
    const transcript = [
      { type: "response_item", timestamp: "2026-09-04T12:00:00Z", payload: { type: "custom_tool_call", call_id: "patch", name: "functions.apply_patch", input } },
      { type: "response_item", timestamp: "2026-09-04T12:00:01Z", payload: { type: "custom_tool_call_output", call_id: "patch", output: "Success. Updated a.ts" } },
    ].map((row) => JSON.stringify(row)).join("\n");
    const messages = synced(parseCodexSessionFile(transcript));
    expect(messages.some(hasFileChangeToolCall)).toBe(true);
    expect(extractFileChanges(messages)[0]).toMatchObject({ filePath: "a.ts", oldContent: "old", newContent: "new" });
  });

  test("Gemini tool-only edits survive parsing, including deletions and empty writes", () => {
    const messages = parseGeminiSessionFile(JSON.stringify({ messages: [{
      id: "gemini", type: "gemini", timestamp: "2026-09-04T12:00:00Z", content: "",
      toolCalls: [
        { id: "edit", name: "replace", args: { file_path: "a.ts", old_string: "remove", new_string: "" }, status: "success", result: [{ functionResponse: { response: { output: "done" } } }] },
        { id: "write", name: "write_file", args: { file_path: "empty.txt", content: "" }, status: "success" },
        { id: "error", name: "replace", args: { file_path: "bad.ts", old_string: "a", new_string: "b" }, status: "error" },
      ],
    }] }));
    expect(messages).toHaveLength(1);
    expect(extractFileChanges(synced(messages)).map((change) => [change.filePath, change.newContent]))
      .toEqual([["a.ts", ""], ["empty.txt", ""]]);
  });

  test("OpenCode camelCase edit and patchText calls", () => {
    const messages = parseOpencodeSessionFile(JSON.stringify({ messages: [{
      info: { id: "open", role: "assistant", time: { created: 1000 } },
      parts: [
        { id: "1", type: "tool", tool: "edit", callID: "edit", state: { status: "completed", input: { filePath: "open.ts", oldString: "a", newString: "b" }, output: "done" } },
        { id: "2", type: "tool", tool: "apply_patch", callID: "patch", state: { status: "completed", input: { patchText: "*** Begin Patch\n*** Add File: empty.txt\n*** End Patch" }, output: "done" } },
      ],
    }] }));
    expect(extractFileChanges(synced(messages)).map((change) => change.filePath)).toEqual(["open.ts", "empty.txt"]);
  });

  test("Pi lowercase edit tools use path, oldText and newText", () => {
    const transcript = JSON.stringify({ type: "message", id: "pi", parentId: null, timestamp: "2026-09-04T12:00:00Z", message: {
      role: "assistant", content: [{ type: "toolCall", id: "edit", name: "edit", arguments: { path: "pi.ts", oldText: "before", newText: "after" } }],
    } });
    expect(extractFileChanges(synced(parsePiSessionFile(transcript)))[0]).toMatchObject({ filePath: "pi.ts", oldContent: "before", newContent: "after" });
  });
});
