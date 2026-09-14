import { expect, spyOn, test } from "bun:test";
import { BROWSER_BATCH_TOOL, extractNestedActions, summarizeNestedActions } from "./toolCall";
test("unchanged wrappers do not reparse when another transcript row changes", () => {
  const call = { name: "exec", input: JSON.stringify({ input: 'await tools.exec_command({cmd: "git status"}); await tools.read_file({path:"notes.md"})' }) };
  const parse = spyOn(JSON, "parse");
  try {
    const first = extractNestedActions(call);
    expect(first.map(x=>x.name)).toEqual(["exec_command", "read_file"]);
    const count = parse.mock.calls.length;
    expect(count).toBeGreaterThan(0);
    expect(extractNestedActions(call)).toEqual(first);
    expect(parse.mock.calls.length).toBe(count);
  } finally { parse.mockRestore(); }
});
test("edits, name changes, malformed and incomplete wrappers replace old actions", () => {
  const call = { name: "exec", input: JSON.stringify({input:'await tools.exec_command({cmd:"ls"})'}) };
  expect(JSON.parse(extractNestedActions(call)[0].input)).toEqual({cmd:"ls"});
  call.input = JSON.stringify({input:'await tools.read_file({path:"changed.md"})'});
  expect(extractNestedActions(call).map(x=>x.name)).toEqual(["read_file"]);
  call.name = "Bash";
  expect(extractNestedActions(call)).toEqual([]);
  call.name = BROWSER_BATCH_TOOL;
  call.input = JSON.stringify({actions:[{name:"navigate",input:{url:"https://example.com"}}]});
  expect(extractNestedActions(call)[0].name).toBe("mcp__claude-in-chrome__navigate");
  expect(summarizeNestedActions(extractNestedActions(call))).toContain("example.com");
  call.input = '{"actions":[';
  expect(extractNestedActions(call)).toEqual([]);
  call.input = JSON.stringify({actions:[{name:"navigate",input:{url:"https://example.org"}}]});
  expect(summarizeNestedActions(extractNestedActions(call))).toContain("example.org");
});
