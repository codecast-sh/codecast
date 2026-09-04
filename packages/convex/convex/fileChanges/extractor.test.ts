import { describe, expect, test } from "bun:test";
import { extractFileChanges, hasFileChangeToolCall } from "./extractor";

const patch = "*** Begin Patch\n*** Update File: example.ts\n@@\n-before\n+after\n*** End Patch";
const changes = (name: string, input: unknown, isError = false) => extractFileChanges([{
  _id: "message", timestamp: 1, tool_calls: [{ id: "tool", name, input: JSON.stringify(input) }],
  tool_results: [{ tool_use_id: "tool", content: "done", is_error: isError }],
}]);

describe("shared file change formats", () => {
  test.each(["Edit", "edit", "file_edit", "replace", "functions.edit"])("recognizes %s including deletion to empty text", (name) => {
    expect(changes(name, { file_path: "a.ts", old_string: "old", new_string: "" })[0]).toMatchObject({ filePath: "a.ts", newContent: "" });
    expect(hasFileChangeToolCall({ _id: "m", timestamp: 1, tool_calls: [{ id: "t", name, input: "{}" }] })).toBe(true);
  });
  test("MultiEdit keeps every replacement with stable ids", () => {
    expect(changes("MultiEdit", { file_path: "a.ts", edits: [
      { old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" },
    ] }).map((change) => change.id)).toEqual(["tool:0", "tool:1"]);
  });
  test("Codex code-mode patch calls are decoded without executing code", () => {
    const code = `text(await tools.apply_patch(${JSON.stringify(patch)}));`;
    expect(changes("exec", { input: code })[0]).toMatchObject({ filePath: "example.ts", oldContent: "before", newContent: "after" });
    expect(changes("functions.exec", { input: code }, true)).toEqual([]);
  });
  test("literal templates work and interpolated templates are excluded", () => {
    expect(changes("exec", { input: 'await tools.apply_patch(`' + patch + '`)' })).toHaveLength(1);
    expect(changes("exec", { input: 'await tools.apply_patch(`' + patch.replace("before", "${before}") + '`)' })).toEqual([]);
  });
  test("patch calls inside comments or quoted examples are not edits", () => {
    const code = `await tools.apply_patch(${JSON.stringify(patch)})`;
    expect(changes("exec", { input: `text(${JSON.stringify(code)}); // ${code}\n/* ${code} */` })).toEqual([]);
  });
  test("Codex shell-command apply_patch heredocs keep the patch", () => {
    expect(changes("shell_command", { command: `cd /repo && apply_patch <<'PATCH'\n${patch}\nPATCH` })[0]).toMatchObject({ filePath: "example.ts", newContent: "after" });
    expect(changes("shell_command", { command: `cat <<'PATCH'\n${patch}\nPATCH` })).toEqual([]);
    expect(changes("shell_command", { command: `cat <<'SCRIPT'\napply_patch <<'PATCH'\n${patch}\nPATCH\nSCRIPT` })).toEqual([]);
  });
  test("a result in another message is associated with its call", () => {
    expect(extractFileChanges([
      { _id: "call", timestamp: 1, tool_calls: [{ id: "t", name: "apply_patch", input: patch }] },
      { _id: "result", timestamp: 2, tool_results: [{ tool_use_id: "t", content: "failed", is_error: true }] },
    ])).toEqual([]);
  });
});
