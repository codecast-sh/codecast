// The whole-transcript passes ConversationView runs on every streamed update
// (known paths, the composer's file mentions, task subjects, tool results)
// memoize per tool call. Each memoized pass must equal the plain pass over the
// same messages, through appends, edits to earlier messages, removals and a
// page push that decodes every message afresh, and must parse only the calls
// that changed.
import { describe, expect, test } from "bun:test";
import type { Message } from "../../components/conversation/types";
import { namedAbsolutePaths } from "../../lib/filePathLinks";
import { extractFilePaths } from "../../lib/conversationProcessor";
import { typedPollAnswerTexts } from "../../lib/pollPayload";
import { ToolCallMemo, keepIfSameRecord, sameElements } from "../toolCallMemo";
import { knownPathsKeyOf, toolResultMapOf } from "../useToolResultMaps";
import { taskSubjectMapOf } from "../useConversationTaskMaps";
import { sessionFilePathsOf } from "../useSessionMentions";

const HOME = "/Users/ada";

let ts = 1_000;
const call = (id: string, name: string, input: unknown) => ({ id, name, input: typeof input === "string" ? input : JSON.stringify(input) });
const assistant = (id: string, tool_calls: ReturnType<typeof call>[], content = ""): Message => ({ _id: id, role: "assistant", content, timestamp: ts++, tool_calls });
const results = (id: string, tool_results: Message["tool_results"], content = ""): Message => ({ _id: id, role: "user", content, timestamp: ts++, tool_results });

function transcript(): Message[] {
  return [
    results("m0", [], "start"),
    assistant("m1", [
      call("t1", "Write", { file_path: "/Users/ada/repo/src/a.ts", content: "import x from '/Users/ada/repo/src/b.ts';\n".repeat(200) }),
      call("t2", "Read", { file_path: "~/notes/todo.md" }),
    ]),
    results("m2", [{ tool_use_id: "t1", content: "ok" }, { tool_use_id: "t2", content: "read" }]),
    assistant("m3", [
      call("t3", "Bash", { command: "cat /Users/ada/repo/README.md && ls /Users/ada/repo/src/index.ts" }),
      call("t4", "TaskCreate", { subject: "Fix the race", description: "see /Users/ada/repo/src/race.ts" }),
      call("t5", "Edit", { file_path: "/Users/ada/repo/src/a.ts", old_string: "a", new_string: "b" }),
      call("t6", "Glob", "not json /Users/ada/repo/odd.ts"),
    ]),
    results("m4", [{ tool_use_id: "t3", content: "readme" }, { tool_use_id: "t4", content: "Task #7 created" }, { tool_use_id: "t5", content: "edited" }]),
    assistant("m5", [call("t7", "AskUserQuestion", { questions: [{ question: "Which?", options: [{ label: "A" }] }] })]),
    results("m6", [{ tool_use_id: "t7", content: "The user doesn't want to proceed with this tool use." }]),
    results("m7", [], "Neither, use C"),
  ];
}

// The passes as they were before the memo, verbatim.
function plainKnownPaths(messages: Message[], home: string | undefined): string {
  const inputs: string[] = [];
  for (const msg of messages) for (const tc of msg.tool_calls ?? []) inputs.push(tc.input);
  return namedAbsolutePaths(inputs, home).join("\n");
}
function plainTaskSubjects(messages: Message[]): Record<string, string> {
  const createInputs: Record<string, string> = {};
  const idMap: Record<string, string> = {};
  for (const msg of messages) {
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.name === "TaskCreate") {
          try {
            const inp = JSON.parse(tc.input);
            if (inp.subject) createInputs[tc.id] = String(inp.subject);
          } catch {}
        }
      }
    }
    if (msg.tool_results) {
      for (const tr of msg.tool_results) {
        if (createInputs[tr.tool_use_id]) {
          const m = tr.content.match(/Task #(\d+)/);
          if (m) idMap[m[1]] = createInputs[tr.tool_use_id];
        }
      }
    }
  }
  return idMap;
}
function plainToolResults(messages: Message[]) {
  const map: Record<string, any> = {};
  for (const msg of messages) for (const tr of msg.tool_results ?? []) map[tr.tool_use_id] = tr;
  for (const [id, typed_answer] of Object.entries(typedPollAnswerTexts(messages))) {
    if (map[id]) map[id] = { ...map[id], typed_answer };
  }
  return map;
}

function memos() {
  return { paths: new ToolCallMemo<string[]>(), files: new ToolCallMemo<string[]>(), subjects: new ToolCallMemo<string | null>() };
}
function expectSame(messages: Message[], m: ReturnType<typeof memos>, home: string | undefined = HOME) {
  expect(knownPathsKeyOf(messages, home, m.paths)).toBe(plainKnownPaths(messages, home));
  expect(sessionFilePathsOf(messages, m.files)).toEqual(extractFilePaths(messages));
  expect(taskSubjectMapOf(messages, m.subjects)).toEqual(plainTaskSubjects(messages));
  expect(toolResultMapOf(messages)).toEqual(plainToolResults(messages));
}

describe("memoized transcript passes equal the plain passes", () => {
  test("the fixture exercises every pass", () => {
    const msgs = transcript();
    expect(plainKnownPaths(msgs, HOME).split("\n").length).toBeGreaterThan(4);
    expect(extractFilePaths(msgs).length).toBeGreaterThan(3);
    expect(plainTaskSubjects(msgs)).toEqual({ "7": "Fix the race" });
    expect(plainToolResults(msgs).t7.typed_answer).toBe("Neither, use C");
  });

  test("through an append, an earlier edit, a removal, a fresh decode and a new home", () => {
    const m = memos();
    let msgs = transcript();
    expectSame(msgs, m);

    msgs = [...msgs, assistant("m8", [call("t8", "Write", { file_path: "/Users/ada/repo/src/new.ts", content: "x" })]), results("m9", [{ tool_use_id: "t8", content: "ok" }])];
    expectSame(msgs, m);

    msgs = msgs.map((msg) => msg._id !== "m3" ? msg : {
      ...msg,
      tool_calls: msg.tool_calls!.map((tc) =>
        tc.id === "t4" ? call("t4", "TaskCreate", { subject: "Fix the other race" })
        : tc.id === "t3" ? call("t3", "Bash", { command: "cat /Users/ada/elsewhere/file.txt" })
        : tc),
    });
    expectSame(msgs, m);

    msgs = msgs.filter((msg) => msg._id !== "m1");
    expectSame(msgs, m);

    msgs = JSON.parse(JSON.stringify(msgs));
    expectSame(msgs, m);

    expectSame(msgs, m, "/home/ada");
    expectSame(msgs, m, undefined);
  });
});

describe("ToolCallMemo", () => {
  test("parses only the calls that are new or changed, and keeps only the window's calls", () => {
    const memo = new ToolCallMemo<string>();
    let computed: string[] = [];
    const pass = (calls: ReturnType<typeof call>[], salt?: unknown) => {
      computed = [];
      memo.begin(salt);
      const out = calls.map((tc) => memo.get(tc, (c) => { computed.push(c.id); return c.input.toUpperCase(); }));
      memo.end();
      return out;
    };
    const a = call("a", "Write", { x: 1 });
    const b = call("b", "Write", { x: 2 });
    expect(pass([a, b])).toEqual([a.input.toUpperCase(), b.input.toUpperCase()]);
    expect(computed).toEqual(["a", "b"]);

    // A fresh decode of the same calls parses nothing.
    pass(JSON.parse(JSON.stringify([a, b])));
    expect(computed).toEqual([]);

    // An edited input and a renamed tool are recomputed; a new call too.
    const out = pass([call("a", "Write", { x: 9 }), call("b", "Edit", { x: 2 }), call("c", "Read", {})]);
    expect(computed).toEqual(["a", "b", "c"]);
    expect(out[0]).toBe(JSON.stringify({ x: 9 }).toUpperCase());

    // A call dropped from the window is forgotten.
    pass([call("c", "Read", {})]);
    expect(computed).toEqual([]);
    pass([call("a", "Write", { x: 9 })]);
    expect(computed).toEqual(["a"]);

    // A new salt recomputes everything.
    pass([call("a", "Write", { x: 9 })], "other");
    expect(computed).toEqual(["a"]);
  });

  test("two calls sharing an id never take each other's value", () => {
    const memo = new ToolCallMemo<string>();
    memo.begin();
    expect(memo.get(call("dup", "Read", "one"), (c) => c.input)).toBe("one");
    expect(memo.get(call("dup", "Read", "two"), (c) => c.input)).toBe("two");
    memo.end();
  });
});

describe("keepIfSameRecord", () => {
  test("keeps the previous record only when keys, order and values match", () => {
    const img = { media_type: "image/png" };
    const prev = { a: [img], b: [] as unknown[] };
    expect(keepIfSameRecord(prev, { a: [img], b: [] }, sameElements)).toBe(prev);
    expect(keepIfSameRecord(prev, { b: [], a: [img] }, sameElements)).not.toBe(prev);
    expect(keepIfSameRecord(prev, { a: [{ media_type: "image/png" }], b: [] }, sameElements)).not.toBe(prev);
    expect(keepIfSameRecord(prev, { a: [img] }, sameElements)).not.toBe(prev);
    const empty = {};
    expect(keepIfSameRecord(empty, {})).toBe(empty);
    expect(keepIfSameRecord(undefined, empty)).toBe(empty);
    const subjects = { "7": "Fix" };
    expect(keepIfSameRecord(subjects, { "7": "Fix" })).toBe(subjects);
    expect(keepIfSameRecord(subjects, { "7": "Fixed" })).toEqual({ "7": "Fixed" });
  });
});
