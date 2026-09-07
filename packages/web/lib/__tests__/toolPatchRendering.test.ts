import { describe, expect, test } from "bun:test";
import { getToolPatchInputs, parseApplyPatchSections } from "../applyPatchParser";
import { extractFileChanges } from "../fileChangeExtractor";
import { computeCumulativeFiles } from "../conversationDiffFiles";

const patch = "*** Begin Patch\n*** Update File: src/session.ts\n@@\n-const idle = false;\n+const idle = true;\n*** Add File: src/new.ts\n+export const active = false;\n*** Delete File: src/old.ts\n*** End Patch";
const source = `text(await tools.apply_patch(${JSON.stringify(patch)}));`;
const tool = (input: string, name = "exec") => ({ id: "call_patch", name, input });
const sections = (input: string, name?: string) => getToolPatchInputs(tool(input, name)).flatMap(parseApplyPatchSections);

describe("Codex patches in conversation cards", () => {
  test.each([
    JSON.stringify({ input: source }),
    JSON.stringify({ code: source }),
    JSON.stringify({ script: source }),
    JSON.stringify(source),
    source,
  ])("renders stored and raw script envelopes using the direct-patch sections", (input) => {
    expect(sections(input)).toEqual(sections(patch, "apply_patch"));
    expect(sections(input).map((section) => [section.filePath, section.operation])).toEqual([
      ["src/session.ts", "Update"], ["src/new.ts", "Add"], ["src/old.ts", "Delete"],
    ]);
  });

  test("namespaced calls and multiple patch calls retain every file in order", () => {
    const extraPatch = "*** Begin Patch\n*** Add File: src/second.ts\n+second\n*** End Patch";
    const mixed = `await tools.exec_command({cmd: "git status --short"});\n${source}\ntext(await functions.apply_patch(${JSON.stringify(extraPatch)}));`;
    const call = tool(JSON.stringify({ input: mixed }), "functions.exec");
    const rendered = getToolPatchInputs(call).flatMap(parseApplyPatchSections);
    const extracted = extractFileChanges([{ _id: "message", timestamp: 1, tool_calls: [call] }]);
    expect(rendered).toHaveLength(4);
    expect(rendered.map((section) => section.filePath)).toEqual(extracted.map((change) => change.filePath));
    expect(extracted.map((change) => change.id)).toEqual(["call_patch:0", "call_patch:1", "call_patch:2", "call_patch:3"]);
    expect(extracted.every((change) => change.toolCallId === call.id)).toBe(true);
    expect(computeCumulativeFiles(extracted, null).find((file) => file.filename === "src/session.ts")?.patch).toContain("+const idle = true;");
  });

  test("shell heredocs use the same inline patch sections", () => {
    expect(sections(JSON.stringify({ cmd: `apply_patch <<'PATCH'\n${patch}\nPATCH` }), "exec_command")).toEqual(sections(patch, "apply_patch"));
  });

  test("ordinary output, comments, examples, and runtime patches are not classified as edits", () => {
    for (const input of [
      'text(await tools.exec_command({cmd: "git diff"}));',
      `text(${JSON.stringify(source)}); // ${source}\n/* ${source} */`,
      'await tools.apply_patch(patch);',
      `await tools.apply_patch(${JSON.stringify(patch)} + dynamicPatch);`,
      'await tools.apply_patch(`*** Begin Patch\n${runtimePatch}\n*** End Patch`);',
    ]) expect(sections(JSON.stringify({ input }))).toEqual([]);
    expect(sections(JSON.stringify({ output: patch }))).toEqual([]);
  });

  test("a failed call retains the proposed inline diff without entering completed file changes", () => {
    const call = tool(JSON.stringify({ input: source }));
    expect(getToolPatchInputs(call).flatMap(parseApplyPatchSections)).toHaveLength(3);
    expect(extractFileChanges([
      { _id: "message", timestamp: 1, tool_calls: [call] },
      { _id: "result", timestamp: 2, tool_results: [{ tool_use_id: call.id, content: "Patch failed", is_error: true }] },
    ])).toEqual([]);
  });
});
