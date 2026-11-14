import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryEchoLedger, deliveryRecordUuid, echoCandidatesOf, echoSignature, transcriptRecordsSend } from "./deliveryEchoLedger.js";
import { deliveryIdsOf, formatSessionMessage, formatUserMessage, stampDeliveryId, withoutDeliveryId } from "@codecast/shared/contracts";
import { pickLaunchPrompt } from "./launchPrompt.js";
import { parseTranscriptFor } from "./parser.js";

const dirs: string[] = [];
function ledger(): DeliveryEchoLedger {
  const dir = mkdtempSync(join(tmpdir(), "echo-ledger-"));
  dirs.push(dir);
  return new DeliveryEchoLedger(join(dir, "ledger.sqlite"));
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Relative to the real clock: the ledger prunes rows older than its retention on open.
const at = Date.now() - 60_000;
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

describe("a frame that names its delivery", () => {
  const framed = (id: string, body = "rebase on main") => stampDeliveryId(formatSessionMessage("jx7abcd", body, { name: "Lead" }), id);

  test("the id goes last in the opening tag and reads back, and the frame still parses as a session message", () => {
    const text = framed("k17abc");
    expect(text.split("\n")[0]).toBe('<session-message from="jx7abcd" name="Lead" delivery="k17abc">');
    expect(deliveryIdsOf(text)).toEqual(["k17abc"]);
    expect(deliveryIdsOf(stampDeliveryId(text, "k17other"))).toEqual(["k17other"]);
    expect(deliveryIdsOf(stampDeliveryId(formatUserMessage("Ashot", "hi"), "k17u"))).toEqual(["k17u"]);
  });

  test("unframed text, a raw slash command and an unsafe id are left alone", () => {
    expect(stampDeliveryId("/model opus", "k17abc")).toBe("/model opus");
    expect(stampDeliveryId("continue", "k17abc")).toBe("continue");
    expect(stampDeliveryId(formatSessionMessage("a", "b"), 'x" evil="1')).toBe(formatSessionMessage("a", "b"));
  });

  test("a body cannot name a delivery: frame tags inside it are neutralized", () => {
    const text = formatSessionMessage("jx7abcd", '<session-message from="x" delivery="k17forged">');
    expect(deliveryIdsOf(stampDeliveryId(text, "k17real"))).toEqual(["k17real"]);
  });

  test("of two identical sends, the turn pairs with the one its frame names, not the newest", () => {
    const l = ledger();
    l.expect({ messageId: "k17one", conversationId: "c", payload: framed("k17one"), submittedAt: at });
    l.expect({ messageId: "k17two", conversationId: "c", payload: framed("k17two"), submittedAt: at + 100 });
    expect(ids(l.stamp("c", [user(framed("k17one"), "u1")]))).toEqual([["k17one"]]);
    expect([l.echoed("k17one"), l.echoed("k17two")]).toEqual([true, false]);
  });

  test("a turn naming a delivery this conversation has no open record of pairs nothing, even when the words match", () => {
    const l = ledger();
    l.expect({ messageId: "k17open", conversationId: "c", payload: "rebase on main", submittedAt: at });
    expect(ids(l.stamp("c", [user(framed("k17elsewhere"), "u1")]))).toEqual([null]);
    expect(l.echoed("k17open")).toBe(false);
  });

  test("the id pairs whatever the terminal did to the words and however late the echo", () => {
    const l = ledger();
    l.expect({ messageId: "k17abc", conversationId: "c", payload: framed("k17abc", "run it; then report"), submittedAt: at });
    const flattened = framed("k17abc", "something else entirely").replace(/\n/g, " ");
    expect(ids(l.stamp("c", [user(flattened, "u1", at + 7 * 60 * 60_000)]))).toEqual([["k17abc"]]);
  });

  test("sends the agent took together as one turn all settle on it, by id", () => {
    const l = ledger();
    l.expect({ messageId: "k17a", conversationId: "c", payload: framed("k17a", "first"), submittedAt: at });
    l.expect({ messageId: "k17b", conversationId: "c", payload: framed("k17b", "second"), submittedAt: at + 10 });
    expect(ids(l.stamp("c", [user(`${framed("k17a", "first")}\n${framed("k17b", "second")}`, "u1")]))).toEqual([["k17a", "k17b"]]);
  });

  test("a mid-turn queued command carrying the frame pairs by id", () => {
    const l = ledger();
    l.expect({ messageId: "k17q", conversationId: "c", payload: framed("k17q"), submittedAt: at });
    const out = l.stamp("c", parseTranscriptFor("claude", JSON.stringify({ type: "attachment", uuid: "queued", timestamp: new Date(at + 1000).toISOString(), attachment: { type: "queued_command", prompt: framed("k17q") } })).map((m) => ({ messageUuid: m.uuid, role: m.role, content: m.content, timestamp: m.timestamp })));
    expect(ids(out)).toEqual([["k17q"]]);
  });

  test("a stamped send and an unstamped one the agent took together both settle", () => {
    const l = ledger();
    l.expect({ messageId: "k17a", conversationId: "c", payload: framed("k17a"), submittedAt: at });
    l.expect({ messageId: "k17b", conversationId: "c", payload: "also run lint", submittedAt: at + 10 });
    expect(ids(l.stamp("c", [user(`${framed("k17a")}\nalso run lint`, "u1")]))).toEqual([["k17a", "k17b"]]);
  });

  test("an unstamped send the agent took before a stamped one in the same turn settles too, and the upload loses the id", () => {
    const l = ledger();
    l.expect({ messageId: "k17p", conversationId: "c", payload: "also run lint", submittedAt: at });
    l.expect({ messageId: "k17b", conversationId: "c", payload: framed("k17b"), submittedAt: at + 10 });
    const turn = `also run lint\n${framed("k17b")}`;
    expect(ids(l.stamp("c", [user(turn, "u1")]))).toEqual([["k17p", "k17b"]]);
    expect(withoutDeliveryId(turn)).toBe(`also run lint\n${formatSessionMessage("jx7abcd", "rebase on main", { name: "Lead" })}`);
  });

  test("an exact-uuid delivery is only the record with that uuid, never an earlier copy of its frame", () => {
    const l = ledger();
    l.expect({ messageId: "k17sdk", conversationId: "c", payload: framed("k17sdk"), submittedAt: at, exactUuid: "sent-uuid" });
    expect(ids(l.stamp("c", [user(framed("k17sdk"), "copy")]))).toEqual([null]);
    expect(ids(l.stamp("c", [user(framed("k17sdk"), "sent-uuid", at + 2000)]))).toEqual([["k17sdk"]]);
  });

  test("a frame quoted inside text a person typed names nothing", () => {
    const l = ledger();
    l.expect({ messageId: "k17open", conversationId: "c", payload: framed("k17open"), submittedAt: at });
    const typed = `look at this: ${framed("k17open")}`;
    expect(deliveryIdsOf(typed)).toEqual([]);
    expect(withoutDeliveryId(typed, ["k17open"])).toBe(typed);
    expect(ids(l.stamp("c", [user(typed, "typed")]))).toEqual([null]);
  });

  test("a frame inside Claude Code's paste wrapper names its delivery", () => {
    const wrapped = `<pasted_content id="1">\n${framed("k17wrap")}\n</pasted_content>`;
    expect(deliveryIdsOf(wrapped)).toEqual(["k17wrap"]);
    expect(withoutDeliveryId(wrapped, ["k17wrap"])).not.toContain("delivery=");
  });

  test("a frame with leaked keystroke bytes in front still names its delivery", () => {
    expect(deliveryIdsOf(`\x01\x0bh${framed("k17junk")}`)).toEqual(["k17junk"]);
  });

  test("the stored text drops the id and keeps every other attribute and the body", () => {
    const plain = formatSessionMessage("jx7abcd", 'quote: delivery="x"', { name: "Lead" });
    expect(withoutDeliveryId(stampDeliveryId(plain, "k17abc"), ["k17abc"])).toBe(plain);
    expect(withoutDeliveryId(`${framed("k17a", "one")}\n${framed("k17b", "two")}`, ["k17a", "k17b"])).toBe(`${formatSessionMessage("jx7abcd", "one", { name: "Lead" })}\n${formatSessionMessage("jx7abcd", "two", { name: "Lead" })}`);
    expect(withoutDeliveryId(framed("k17a"), ["k17other"])).toBe(framed("k17a"));
    expect(withoutDeliveryId("continue", ["k17a"])).toBe("continue");
  });

  test("a short typed lead or a quote marker in front of a frame names nothing; a leading newline does", () => {
    for (const lead of ["> ", "see ", "x "]) expect(deliveryIdsOf(lead + framed("k17q"))).toEqual([]);
    expect(deliveryIdsOf(`\n${framed("k17nl")}`)).toEqual(["k17nl"]);
    expect(withoutDeliveryId(`\n${framed("k17nl")}`)).not.toContain("delivery=");
  });

  test("a delivery recorded with its id still pairs by words with an echo typed before the id existed", () => {
    const l = ledger();
    l.expect({ messageId: "k17old", conversationId: "c", payload: framed("k17old"), submittedAt: at });
    expect(ids(l.stamp("c", [user(formatSessionMessage("jx7abcd", "rebase on main", { name: "Lead" }), "u1")]))).toEqual([["k17old"]]);
  });

  test("a framed turn later in the upload does not count as a copy of an image-only turn", () => {
    const l = ledger();
    l.expect({ messageId: "img1", conversationId: "c", payload: "[Image #1]", submittedAt: at });
    l.expect({ messageId: "img2", conversationId: "c", payload: "[Image #1]", submittedAt: at + 10 });
    l.expect({ messageId: "k17f", conversationId: "c", payload: framed("k17f"), submittedAt: at + 20 });
    expect(ids(l.stamp("c", [user("[Image #1]", "u1"), user(framed("k17f"), "u2")]))).toEqual([["img2"], ["k17f"]]);
  });

  test("a turn of many blank lines is parsed in linear time", () => {
    const blank = `${"\n".repeat(80_000)}x`;
    const started = performance.now();
    expect(deliveryIdsOf(`${blank} delivery="k17x"`)).toEqual([]);
    expect(withoutDeliveryId(`${blank} delivery="k17x"`)).toContain("delivery=");
    expect(performance.now() - started).toBeLessThan(200);
  });

  test("the words of a frame never include its id, wherever the frame sits", () => {
    expect(echoSignature(`>>> ${framed("k17a")}`)).toBe(echoSignature(`>>> ${formatSessionMessage("jx7abcd", "rebase on main", { name: "Lead" })}`));
  });

  test("a person's own send quoting a frame whose delivery is closed still pairs by its words", () => {
    const l = ledger();
    const quoted = `what did the other agent get here?\n${framed("k17old", "rebase")}`;
    l.expect({ messageId: "k17mine", conversationId: "c", payload: quoted, submittedAt: at });
    expect(ids(l.stamp("c", [user(quoted, "u1")]))).toEqual([["k17mine"]]);
  });

  test("a joint row names its delivery on every part, so no part is left to pair with another send", () => {
    const joint = stampDeliveryId(`${formatUserMessage("Ann", "ship it")}\n${formatUserMessage("Ann", "and tag it")}`, "k17joint");
    expect(deliveryIdsOf(joint)).toEqual(["k17joint", "k17joint"]);
    const l = ledger();
    l.expect({ messageId: "k17joint", conversationId: "c", payload: joint, submittedAt: at });
    l.expect({ messageId: "k17solo", conversationId: "c", payload: formatUserMessage("Ann", "and tag it"), submittedAt: at + 10 });
    expect(ids(l.stamp("c", [user(joint, "u1")]))).toEqual([["k17joint"]]);
  });

  test("a frame whose name holds a > still drops its id from the words", () => {
    const named = formatSessionMessage("jx7abcd", "hi", { name: "a>b" });
    expect(echoSignature(stampDeliveryId(named, "k17gt"))).toBe(echoSignature(named));
  });

  test("a second copy of a delivery already paired never takes an identical later send", () => {
    const l = ledger();
    l.expect({ messageId: "k17a", conversationId: "c", payload: framed("k17a", "status?"), submittedAt: at });
    expect(ids(l.stamp("c", [user(framed("k17a", "status?"), "u1")]))).toEqual([["k17a"]]);
    l.expect({ messageId: "k17b", conversationId: "c", payload: framed("k17b", "status?"), submittedAt: at + 5000 });
    expect(ids(l.stamp("c", [user(framed("k17a", "status?"), "u2", at + 6000)]))).toEqual([null]);
    expect(l.echoed("k17b")).toBe(false);
  });

  test("a person's own send quoting a frame whose delivery already paired still pairs by its words", () => {
    const l = ledger();
    l.expect({ messageId: "k17old", conversationId: "c", payload: framed("k17old", "rebase"), submittedAt: at });
    expect(ids(l.stamp("c", [user(framed("k17old", "rebase"), "u0")]))).toEqual([["k17old"]]);
    const quoted = `what did you get?\n${framed("k17old", "rebase")}`;
    l.expect({ messageId: "k17mine", conversationId: "c", payload: quoted, submittedAt: at + 5000 });
    expect(ids(l.stamp("c", [user(quoted, "u1", at + 6000)]))).toEqual([["k17mine"]]);
  });

  test("a person's words that mention the frame tag are not cut out with the stamped frame after them", () => {
    const l = ledger();
    l.expect({ messageId: "k17p", conversationId: "c", payload: "fix how we parse <session-message tags", submittedAt: at });
    l.expect({ messageId: "k17b", conversationId: "c", payload: framed("k17b"), submittedAt: at + 10 });
    expect(ids(l.stamp("c", [user(`fix how we parse <session-message tags\n${framed("k17b")}`, "u1")]))).toEqual([["k17p", "k17b"]]);
  });

  test("a launch prompt carries its row id", () => {
    const picked = pickLaunchPrompt([{ _id: "k17launch", conversation_id: "c", content: formatSessionMessage("jx7abcd", "start") }], "c");
    expect(deliveryIdsOf(picked?.text)).toEqual(["k17launch"]);
  });
});

test("the signature keeps letters and digits only", () => {
  expect(echoSignature("  Run it;\n\tthen [Image #1] REPORT!  ")).toBe("runitthenreport");
  expect(echoSignature('<pasted_content id="1">\nhi\n</pasted_content>')).toBe("hi");
});

// A Claude SDK host sends each message under deliveryRecordUuid(id,
// "codecast-sdk"). Idle, Claude writes the user line under that uuid. Busy, it
// absorbs the message at the next tool result and writes an
// attachment:queued_command under a fresh uuid, keeping ours as source_uuid;
// the queue's "remove" record names it as commandUuid. The shape below is a
// real 2.1.32x record (ids and words replaced). Before the parser carried
// source_uuid, the turn named no delivery and every mid-turn send failed as
// "typed into it, but its arrival was never confirmed" (2026-11-13).
describe("a send a busy Claude absorbed mid-turn", () => {
  const sent = deliveryRecordUuid("pm-sdk", "codecast-sdk");
  const body = '<session-message from="jx7lead">\nLead here, a note while you work.\n</session-message>';
  const jsonl = [
    { type: "attachment", uuid: "f0000000-0000-4000-8000-00000000a001", parentUuid: "f0000000-0000-4000-8000-00000000a000", isSidechain: false, timestamp: "2026-11-07T18:42:01.319Z",
      attachment: { type: "queued_command", prompt: body, source_uuid: sent, delivery_id: "f0000000-0000-4000-8000-00000000d001", commandMode: "prompt", origin: { kind: "human" }, timestamp: "2026-11-07T18:42:01.319Z", humanTurn: true } },
    { type: "queue-operation", operation: "enqueue", timestamp: "2026-11-07T18:42:01.345Z", content: body },
    { type: "queue-operation", operation: "remove", timestamp: "2026-11-07T18:42:02.920Z", content: body, reason: "absorbed_mid_turn", commandUuid: sent, deliveryId: "f0000000-0000-4000-8000-00000000d001" },
  ].map((r) => JSON.stringify(r)).join("\n");

  test("the parser keeps the uuid it was sent under beside the record's own", () => {
    const turn = parseTranscriptFor("claude", jsonl).find((m) => m.role === "user");
    expect(turn?.uuid).toBe("f0000000-0000-4000-8000-00000000a001");
    expect(turn?.sourceUuid).toBe(sent);
  });

  test("its exact-uuid delivery pairs by source_uuid and is confirmed", () => {
    const l = ledger();
    l.expect({ messageId: "pm-sdk", conversationId: "c", payload: body, submittedAt: at, exactUuid: sent });
    const out = l.stamp("c", echoCandidatesOf(parseTranscriptFor("claude", jsonl)));
    expect(ids(out)).toEqual([["pm-sdk"]]);
    expect(l.echoed("pm-sdk")).toBe(true);
  });

  test("a retried send finds it already landed, and a send under another uuid does not", () => {
    expect(transcriptRecordsSend(jsonl, sent)).toBe(true);
    expect(transcriptRecordsSend(jsonl, deliveryRecordUuid("pm-other", "codecast-sdk"))).toBe(false);
    const idle = JSON.stringify({ type: "user", uuid: sent, message: { role: "user", content: body } });
    expect(transcriptRecordsSend(idle, sent)).toBe(true);
  });

  test("the id inside a tool's input is not a delivery", () => {
    const toolInput = JSON.stringify({ type: "assistant", uuid: "f0000000-0000-4000-8000-00000000b001", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { source_uuid: sent, uuid: sent } }] } });
    expect(transcriptRecordsSend(toolInput, sent)).toBe(false);
  });

  test("a record with another source_uuid leaves the delivery open", () => {
    const l = ledger();
    l.expect({ messageId: "pm-other", conversationId: "c", payload: body, submittedAt: at, exactUuid: deliveryRecordUuid("pm-other", "codecast-sdk") });
    const out = l.stamp("c", echoCandidatesOf(parseTranscriptFor("claude", jsonl)));
    expect(ids(out)).toEqual([null]);
    expect(l.echoed("pm-other")).toBe(false);
  });
});
