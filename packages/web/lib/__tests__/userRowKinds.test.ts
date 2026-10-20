import { describe, expect, test } from "bun:test";
import { classifyUserRows, pairCommandExpansions } from "../userRowKinds";

let ts = 1;
const row = (role: string, content: string, extra: Record<string, unknown> = {}) => ({ _id: `m${ts}`, role, content, timestamp: ts++, ...extra });
const kindsOf = (msgs: any[]) => {
  const timeline = msgs.map((m) => ({ type: "message" as const, data: m, timestamp: m.timestamp }));
  const kinds = classifyUserRows(timeline, msgs, { agentType: "claude_code" });
  return { kinds, expansions: pairCommandExpansions(timeline, kinds) };
};

describe("user row kinds", () => {
  test("a slash command takes the prompt it expanded to", () => {
    const msgs = [
      row("assistant", "Ready."),
      row("user", "<command-message>deploy</command-message>\n<command-name>/deploy</command-name>\n<command-args>web</command-args>"),
      row("user", "Base directory for this skill: /skills/deploy\n\n# Deploy"),
    ];
    const { kinds, expansions } = kindsOf(msgs);
    expect(kinds.get(msgs[1]._id)?.kind).toBe("command");
    expect(expansions.byCommand.get(msgs[1]._id)).toContain("# Deploy");
    expect(expansions.consumed.has(msgs[2]._id)).toBe(true);
  });

  test("`!` bash input pairs with its output", () => {
    const msgs = [row("assistant", "Ready."), row("user", "<bash-input>ls</bash-input>"), row("user", "<bash-stdout>a\nb</bash-stdout><bash-stderr></bash-stderr>")];
    const { kinds, expansions } = kindsOf(msgs);
    expect(kinds.get(msgs[1]._id)).toEqual({ kind: "bash_input", command: "ls" });
    expect(expansions.bashByInput.get(msgs[1]._id)).toEqual({ stdout: "a\nb", stderr: "" });
    expect(expansions.consumed.has(msgs[2]._id)).toBe(true);
  });

  test("a row after an ask is the poll's answer, whatever it says", () => {
    const msgs = [
      row("assistant", "", { tool_calls: [{ id: "t1", name: "AskUserQuestion", input: "{}" }] }),
      row("user", "<command-name>/deploy</command-name>"),
    ];
    expect(kindsOf(msgs).kinds.get(msgs[1]._id)?.kind).toBe("poll_response");
  });
});
