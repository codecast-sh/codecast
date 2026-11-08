import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryEchoLedger, echoSignature } from "./deliveryEchoLedger.js";
import { parseTranscriptFor } from "./parser.js";

const dirs: string[] = [];
function ledger(): DeliveryEchoLedger {
  const dir = mkdtempSync(join(tmpdir(), "echo-ledger-"));
  dirs.push(dir);
  return new DeliveryEchoLedger(join(dir, "ledger.sqlite"));
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const at = Date.parse("2026-11-07T18:42:00Z");
const user = (content: string, uuid: string, timestamp = at + 1000) => ({ messageUuid: uuid, role: "human", content, timestamp });
const ids = (rows: ReadonlyArray<object>) => rows.map((r) => (r as { deliveryIds?: string[] }).deliveryIds ?? null);

describe("pairing a turn with the delivery it echoes", () => {
  test("the turn after the Enter that opens with the payload carries its id, and only that turn", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "continue with the tests", submittedAt: at });
    const out = l.stamp("c", [
      { messageUuid: "a1", role: "assistant", content: "continue with the tests", timestamp: at + 500 },
      user("continue with the tests", "u1"),
      user("continue with the tests", "u2"),
    ]);
    expect(ids(out)).toEqual([null, ["pm1"], null]);
    expect(l.echoed("pm1")).toBe(true);
  });

  test("a turn recorded before the delivery was handed over is history, never its echo", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "continue", submittedAt: at });
    expect(ids(l.stamp("c", [user("continue", "old", at - 60_000)]))).toEqual([null]);
    expect(l.echoed("pm1")).toBe(false);
  });

  test("what a terminal does to the words does not break the pairing", () => {
    const l = ledger();
    // tmux dropped a trailing `;` from a typed chunk, the paste came back wrapped,
    // and leaked Ctrl+A/Ctrl+K bytes sit inside the echo.
    l.expect({ messageId: "pm1", conversationId: "c", payload: "run it; then\n  report back;", submittedAt: at });
    const echo = '<pasted_content id="x">\n\x01\x0brun it then report back\n</pasted_content>';
    expect(ids(l.stamp("c", [user(echo, "u1")]))).toEqual([["pm1"]]);
  });

  test("a turn someone typed at the terminal is nobody's delivery", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "deploy the fix", submittedAt: at });
    expect(ids(l.stamp("c", [user("what are you doing?", "typed"), user("deploy the fix", "u1")]))).toEqual([null, ["pm1"]]);
  });

  test("a turn that only mentions the payload later is not its echo", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "continue", submittedAt: at });
    expect(ids(l.stamp("c", [user("please do not continue", "typed")]))).toEqual([null]);
  });

  test("two sends the agent took as one turn both settle on it", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "first thing", submittedAt: at });
    l.expect({ messageId: "pm2", conversationId: "c", payload: "second thing", submittedAt: at + 10 });
    expect(ids(l.stamp("c", [user("first thing\nsecond thing", "u1")]))).toEqual([["pm1", "pm2"]]);
  });

  test("identical sends uploaded together pair oldest with oldest", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "yes", submittedAt: at });
    l.expect({ messageId: "pm2", conversationId: "c", payload: "yes", submittedAt: at + 500 });
    expect(ids(l.stamp("c", [user("yes", "u1"), user("yes", "u2")]))).toEqual([["pm1"], ["pm2"]]);
  });

  test("a lost send cannot take the echo of a later send that starts with its words", () => {
    const l = ledger();
    l.expect({ messageId: "lost", conversationId: "c", payload: "fix the bug", submittedAt: at });
    l.expect({ messageId: "pm2", conversationId: "c", payload: "fix the bug in parser.ts", submittedAt: at + 60_000 });
    expect(ids(l.stamp("c", [user("fix the bug in parser.ts", "u1", at + 61_000)]))).toEqual([["pm2"]]);
    expect(l.echoed("lost")).toBe(false);
  });

  test("a lost wake leaves the next identical wake its own echo", () => {
    const l = ledger();
    l.expect({ messageId: "wake1", conversationId: "c", payload: "<scheduled-task>check CI</scheduled-task>", submittedAt: at });
    l.expect({ messageId: "wake2", conversationId: "c", payload: "<scheduled-task>check CI</scheduled-task>", submittedAt: at + 30 * 60_000 });
    expect(ids(l.stamp("c", [user("<scheduled-task>check CI</scheduled-task>", "u1", at + 31 * 60_000)]))).toEqual([["wake2"]]);
  });

  test("a line typed at the terminal that starts with a send's words is not its echo", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "run the tests", submittedAt: at });
    expect(ids(l.stamp("c", [user("run the tests but skip e2e", "typed"), user("run the tests", "u1")]))).toEqual([null, ["pm1"]]);
  });

  test("a re-upload of the same turn carries the same id, and a retried hand-over is one delivery", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "go", submittedAt: at });
    l.expect({ messageId: "pm1", conversationId: "c", payload: "go", submittedAt: at + 50_000 });
    expect(ids(l.stamp("c", [user("go", "u1")]))).toEqual([["pm1"]]);
    expect(ids(l.stamp("c", [user("go", "u1")]))).toEqual([["pm1"]]);
    // A second copy of the words (a double delivery) is shown as what it is.
    expect(ids(l.stamp("c", [user("go", "u2")]))).toEqual([null]);
  });

  test("an exact record id is the delivery whatever the words", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "hello", submittedAt: at, exactUuid: "cloud-uuid" });
    expect(ids(l.stamp("c", [user("hello", "other"), user("rewritten by the backend", "cloud-uuid")]))).toEqual([null, ["pm1"]]);
  });

  test("harness turns, tool results and other conversations never pair", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "[Image /tmp/codecast/images/abc.png]", submittedAt: at });
    const out = l.stamp("c", [
      user("<task-notification>\n<status>stopped</status></task-notification>", "n"),
      { ...user("", "tr"), toolResults: [{ toolUseId: "x", content: "" }] },
    ]);
    expect(ids(out)).toEqual([null, null]);
    expect(ids(l.stamp("other", [user("[Image /tmp/codecast/images/abc.png]", "o")]))).toEqual([null]);
    expect(ids(l.stamp("c", [user("[Image /tmp/codecast/images/abc.png]", "img")]))).toEqual([["pm1"]]);
  });

  test("a delivery lost long ago cannot take a later turn with the same words", () => {
    const l = ledger();
    l.expect({ messageId: "lost", conversationId: "c", payload: "continue", submittedAt: at - 7 * 60 * 60_000 });
    l.expect({ messageId: "pm1", conversationId: "c", payload: "continue", submittedAt: at });
    expect(ids(l.stamp("c", [user("continue", "u1")]))).toEqual([["pm1"]]);
  });

  test("turns with no record id pair one each, even with the same words", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "continue", submittedAt: at });
    l.expect({ messageId: "pm2", conversationId: "c", payload: "continue", submittedAt: at + 10 });
    const out = l.stamp("c", [{ role: "human", content: "continue", timestamp: at + 1000 }, { role: "human", content: "continue", timestamp: at + 2000 }]);
    expect(ids(out).flat().sort()).toEqual(["pm1", "pm2"]);
    expect([l.echoed("pm1"), l.echoed("pm2")]).toEqual([true, true]);
  });

  test("a retry five hours in still pairs an echo that comes after the first send's six hours", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "deploy", submittedAt: at - 5 * 60 * 60_000 });
    l.expect({ messageId: "pm1", conversationId: "c", payload: "deploy", submittedAt: at });
    expect(ids(l.stamp("c", [user("deploy", "u1", at + 2 * 60 * 60_000)]))).toEqual([["pm1"]]);
  });

  test("a person's retry long after the first send starts its clock again", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "deploy", submittedAt: at - 10 * 60 * 60_000 });
    l.expect({ messageId: "pm1", conversationId: "c", payload: "deploy", submittedAt: at });
    expect(ids(l.stamp("c", [user("deploy", "u1")]))).toEqual([["pm1"]]);
  });

  test("a !cmd send pairs with Claude Code's bash-input record", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "!git status", submittedAt: at });
    expect(ids(l.stamp("c", [user("<bash-input>git status</bash-input>", "u1")]))).toEqual([["pm1"]]);
  });

  test("an image-only send pairs only with a turn that carries an image", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "[Image /tmp/codecast/images/abc.png]", submittedAt: at });
    expect(ids(l.stamp("c", [user("...", "punct"), user("[Image #1]", "img")]))).toEqual([null, ["pm1"]]);
  });

  test("a transcript with no record ids answers whether it holds the words, and pairs nothing", () => {
    const turns = [{ role: "user", content: "continue", timestamp: at }];
    expect(DeliveryEchoLedger.unkeyedTranscriptHolds(turns, "continue")).toBe(true);
    expect(DeliveryEchoLedger.unkeyedTranscriptHolds(turns, "continue please")).toBe(false);
  });

  test("a send with no letters or digits pairs with its echo", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "👍", submittedAt: at });
    l.expect({ messageId: "pm2", conversationId: "c", payload: "?", submittedAt: at + 10 });
    expect(ids(l.stamp("c", [user("👍", "u1"), user("?", "u2")]))).toEqual([["pm1"], ["pm2"]]);
  });

  test("a retried upload of a turn with no record id carries the same id", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "go on", submittedAt: at });
    const turn = { role: "human", content: "go on", timestamp: at + 1000 };
    expect(ids(l.stamp("c", [turn]))).toEqual([["pm1"]]);
    expect(ids(l.stamp("c", [turn]))).toEqual([["pm1"]]);
  });

  test("a delivery that never reached the agent can be forgotten", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "go", submittedAt: at });
    l.forget("pm1");
    expect(ids(l.stamp("c", [user("go", "u1")]))).toEqual([null]);
  });

  test("the pairing survives a daemon restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-ledger-"));
    dirs.push(dir);
    const first = new DeliveryEchoLedger(join(dir, "l.sqlite"));
    first.expect({ messageId: "pm1", conversationId: "c", payload: "go", submittedAt: at });
    first.close();
    const second = new DeliveryEchoLedger(join(dir, "l.sqlite"));
    expect(ids(second.stamp("c", [user("go", "u1")]))).toEqual([["pm1"]]);
  });
});

describe("echoes as Claude Code records them", () => {
  const row = (content: unknown, uuid = "echo", timestamp = at + 1000) =>
    JSON.stringify({ type: "user", uuid, timestamp: new Date(timestamp).toISOString(), message: { role: "user", content } });
  const stampTranscript = (l: DeliveryEchoLedger, jsonl: string) =>
    l.stamp("c", parseTranscriptFor("claude", jsonl).map((m) => ({ messageUuid: m.uuid, role: m.role, content: m.content, timestamp: m.timestamp, toolResults: m.toolResults })));

  test("a message typed during a turn echoes as a queued command", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "continue", submittedAt: at });
    stampTranscript(l, JSON.stringify({ type: "attachment", uuid: "queued", timestamp: new Date(at + 1000).toISOString(), attachment: { type: "queued_command", prompt: "continue" } }));
    expect(l.echoed("pm1")).toBe(true);
  });

  test("a slash command echoes as its tagged invocation", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "/mcp", submittedAt: at });
    l.expect({ messageId: "pm2", conversationId: "c", payload: "/model opus", submittedAt: at });
    stampTranscript(l, row("<command-name>/mcp</command-name>\n            <command-message>mcp</command-message>\n            <command-args></command-args>"));
    expect([l.echoed("pm1"), l.echoed("pm2")]).toEqual([true, false]);
  });

  test("a tool result is not an echo", () => {
    const l = ledger();
    l.expect({ messageId: "pm1", conversationId: "c", payload: "continue", submittedAt: at });
    stampTranscript(l, row([{ type: "tool_result", tool_use_id: "x", content: "continue" }]));
    expect(l.echoed("pm1")).toBe(false);
  });
});

test("the signature keeps letters and digits only", () => {
  expect(echoSignature("  Run it;\n\tthen [Image #1] REPORT!  ")).toBe("runitthenreport");
  expect(echoSignature('<pasted_content id="1">\nhi\n</pasted_content>')).toBe("hi");
});
