import { expect, test } from "bun:test";
import { extractFileChanges } from "../fileChangeExtractor";
import { computeCumulativeFiles } from "../conversationDiffFiles";

test("the conversation file tree includes new empty files from agent patches", () => {
  const changes = extractFileChanges([{ _id: "message", timestamp: 1, tool_calls: [{
    id: "patch", name: "apply_patch", input: "*** Begin Patch\n*** Add File: empty.txt\n*** End Patch",
  }] }]);
  expect(computeCumulativeFiles(changes, null)).toMatchObject([{ filename: "empty.txt", status: "added", additions: 0, deletions: 0 }]);
});

test("the session tree combines edits to the same file from different agents", () => {
  const changes = extractFileChanges([{ _id: "message", timestamp: 1, tool_calls: [
    { id: "a", name: "Edit", input: JSON.stringify({ file_path: "same.ts", old_string: "before", new_string: "middle" }) },
    { id: "b", name: "edit", input: JSON.stringify({ path: "same.ts", oldText: "middle", newText: "after" }) },
  ] }]);
  const files = computeCumulativeFiles(changes, null);
  expect(files).toHaveLength(1);
  expect(files[0].patch).toContain("-before");
  expect(files[0].patch).toContain("+after");
  expect(files[0].patch).not.toContain("middle");
});

// Changes the daemon observed on disk around a Bash call (packages/cli/src/
// shellChanges.ts): whole-file writes that know the text before them, and
// deletions. Neither comes out of a tool call, so they are built directly.
function observed(id: string, filePath: string, changeType: "write" | "delete", newContent: string, oldContent?: string) {
  return { id, toolCallId: "toolu_1", sequenceIndex: 0, messageId: "m", filePath, changeType, oldContent, newContent, timestamp: 1 };
}

test("a whole-file write that knows the text before it renders as a modification, not a new file", () => {
  const files = computeCumulativeFiles([observed("a", "src/a.ts", "write", "one\n2\nthree\n", "one\ntwo\nthree\n")], null);
  expect(files).toMatchObject([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 1 }]);
  expect(files[0].patch).toContain("-two");
  expect(files[0].patch).toContain("+2");
});

test("a whole-file write with no prior text is a new file, and a deletion is deleted", () => {
  const files = computeCumulativeFiles([
    observed("n", "src/new.ts", "write", "hi\n"),
    observed("g", "src/gone.ts", "delete", "", "bye\n"),
  ], null);
  expect(files.map((f) => [f.filename, f.status, f.additions, f.deletions])).toEqual([
    ["src/gone.ts", "deleted", 0, 1],
    ["src/new.ts", "added", 1, 0],
  ]);
});

test("a shell rewrite after string edits diffs from the session's true original", () => {
  const edit = extractFileChanges([{ _id: "m", timestamp: 1, tool_calls: [
    { id: "e", name: "Edit", input: JSON.stringify({ file_path: "src/a.ts", old_string: "two", new_string: "2" }) },
  ] }]);
  const rewrite = { ...observed("w", "src/a.ts", "write", "one\n2\n3\n", "one\n2\nthree\n"), sequenceIndex: 1, timestamp: 2 };
  const files = computeCumulativeFiles([...edit, rewrite], null);
  expect(files).toHaveLength(1);
  expect(files[0].status).toBe("modified");
  expect(files[0].patch).toContain("-two");
  expect(files[0].patch).toContain("-three");
  expect(files[0].patch).toContain("+2");
  expect(files[0].patch).toContain("+3");
  expect(files[0].patch).not.toContain("-2");
});
