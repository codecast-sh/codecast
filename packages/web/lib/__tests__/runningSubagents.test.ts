import { describe, expect, test } from "bun:test";
import { runningSubagents } from "../runningSubagents";
import type { Message } from "../../components/conversation/types";

let n = 0;
const msg = (m: Partial<Message>): Message => ({ _id: `m${++n}`, role: "assistant", timestamp: n, ...m } as Message);
const agent = (id: string, input: Record<string, unknown>) => ({ id, name: "Agent", input: JSON.stringify(input) });

describe("runningSubagents", () => {
  test("names the turn's subagent calls that have no result yet", () => {
    const messages = [
      msg({ role: "user", content: "audit the repo" }),
      msg({ tool_calls: [agent("a", { description: "Search auth" }), agent("b", { description: "Read docs" }), { id: "r", name: "Read", input: "{}" }] }),
      msg({ role: "user", tool_results: [{ tool_use_id: "b", content: "done" }] }),
    ];
    expect(runningSubagents(messages)).toEqual([{ id: "a", label: "Search auth" }]);
  });

  test("a background launch and an earlier turn's unanswered call are not running", () => {
    const messages = [
      msg({ tool_calls: [agent("old", { description: "Cut off last turn" })] }),
      msg({ role: "user", content: "new prompt" }),
      msg({ tool_calls: [agent("bg", { description: "Watch CI", run_in_background: true })] }),
    ];
    expect(runningSubagents(messages)).toEqual([]);
  });

  test("falls back to the subagent type when there is no description", () => {
    expect(runningSubagents([msg({ tool_calls: [agent("a", { subagent_type: "Explore" })] })])).toEqual([{ id: "a", label: "Explore" }]);
  });
});
