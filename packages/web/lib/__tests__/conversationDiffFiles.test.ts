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
