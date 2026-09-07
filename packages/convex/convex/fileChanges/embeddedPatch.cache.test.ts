import { expect, it, spyOn } from "bun:test";
import { getToolPatchInputs } from "./embeddedPatch";
import { extractFileChanges } from "./extractor";

const patch = "*** Begin Patch\n*** Add File: example.ts\n+export const value = 1;\n*** End Patch";
const input = JSON.stringify({ code: `await tools.apply_patch(${JSON.stringify(patch)})` });

it("reuses immutable patch inputs without reparsing unchanged historical calls", () => {
  const call = { name: "functions.exec", input };
  const parse = spyOn(JSON, "parse");
  try {
    const first = getToolPatchInputs(call);
    const reads = parse.mock.calls.length;
    expect(first).toEqual([patch]);
    expect(getToolPatchInputs(call)).toBe(first);
    expect(parse.mock.calls.length).toBe(reads);
    expect(Object.isFrozen(first)).toBe(true);
  } finally {
    parse.mockRestore();
  }
});

it("invalidates when a streaming call changes its name or input", () => {
  const call = { name: "functions.exec", input };
  expect(getToolPatchInputs(call)).toEqual([patch]);
  call.input = JSON.stringify({ code: "await tools.exec_command({cmd: 'pwd'})" });
  expect(getToolPatchInputs(call)).toEqual([]);
  call.input = input;
  call.name = "read_file";
  expect(getToolPatchInputs(call)).toEqual([]);
  call.name = "functions.exec";
  expect(getToolPatchInputs(call)).toEqual([patch]);
});

it("reuses parsed calls while still honoring newly arrived tool failures", () => {
  const call = { id: "call-1", name: "functions.exec", input };
  const message = { _id: "message-1", timestamp: 1, tool_calls: [call] };
  expect(extractFileChanges([message])).toHaveLength(1);
  const failed = { _id: "message-2", timestamp: 2, tool_results: [{ tool_use_id: call.id, content: "failed", is_error: true }] };
  expect(extractFileChanges([message, failed])).toEqual([]);
  expect(extractFileChanges([message])).toHaveLength(1);
});
