import { describe, expect, test } from "bun:test";
import { turnUnanswered } from "./transcriptTurn.js";

const user = (content: unknown, extra: object = {}) => JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (content: unknown) => JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
const tail = (...lines: string[]) => lines.join("\n") + "\n";
const text = (t: string) => [{ type: "text", text: t }];

describe("turnUnanswered", () => {
  test("a prompt with no reply is unanswered", () => {
    expect(turnUnanswered(tail(assistant(text("hi")), user("do it")))).toBe(true);
  });

  test("a tool result with no reply after it is unanswered", () => {
    expect(turnUnanswered(tail(user("go"), assistant([{ type: "tool_use", id: "a" }]), user([{ type: "tool_result", tool_use_id: "a", content: "ok" }])))).toBe(true);
  });

  test("a tool call whose result has not come back is unanswered", () => {
    expect(turnUnanswered(tail(user("go"), assistant([{ type: "text", text: "on it" }, { type: "tool_use", id: "a" }])))).toBe(true);
  });

  test("a reply answers the turn", () => {
    expect(turnUnanswered(tail(user("go"), assistant(text("done"))))).toBe(false);
  });

  test("an interrupted turn is over", () => {
    expect(turnUnanswered(tail(user("go"), user([{ type: "text", text: "[Request interrupted by user]" }])))).toBe(false);
    expect(turnUnanswered(tail(user("go"), user("[Request interrupted by user for tool use]")))).toBe(false);
  });

  test("local slash commands and meta entries are not turns", () => {
    const command = user("<command-name>/model</command-name>");
    const stdout = user("<local-command-stdout>Set model</local-command-stdout>");
    expect(turnUnanswered(tail(user("go"), assistant(text("done")), command, stdout, user("caveat", { isMeta: true })))).toBe(false);
  });

  test("subagent entries in the file and non-message lines are skipped", () => {
    const sidechain = user("sub prompt", { isSidechain: true });
    const system = JSON.stringify({ type: "system", subtype: "x" });
    expect(turnUnanswered(tail(user("go"), assistant(text("done")), sidechain, system))).toBe(false);
  });

  test("the cut first line of a tail and a half-written last line are ignored", () => {
    expect(turnUnanswered(`ssage":{"role":"user"}}\n${assistant(text("done"))}\n{"type":"user","mess`)).toBe(false);
  });

  test("a tail with no turn in it says nothing", () => {
    expect(turnUnanswered("")).toBeNull();
    expect(turnUnanswered(tail(JSON.stringify({ type: "summary" })))).toBeNull();
  });
});
