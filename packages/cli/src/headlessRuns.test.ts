import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { headlessRunStaysOutOfInbox, inheritedConversationOfHeadless, repairLeakedHeadlessCodexRuns } from "./headlessRuns.js";

describe("inheritedConversationOfHeadless", () => {
  test("reads the conversation a codex exec run inherited", () => {
    expect(inheritedConversationOfHeadless("codex exec -m gpt -C /repo review this HOME=/Users/a CODECAST_CONVERSATION_ID=jx7abc123 PATH=/bin")).toBe("jx7abc123");
    expect(inheritedConversationOfHeadless("node /opt/bin/codex exec review CODECAST_CONVERSATION_ID=jx7abc123")).toBe("jx7abc123");
    expect(inheritedConversationOfHeadless("/usr/local/bin/claude -p hello CODECAST_CONVERSATION_ID=jx7abc123")).toBe("jx7abc123");
  });

  test("the environment wins over a prompt that quotes the variable", () => {
    expect(inheritedConversationOfHeadless("codex exec explain CODECAST_CONVERSATION_ID=jx7fake to me HOME=/Users/a CODECAST_CONVERSATION_ID=jx7real")).toBe("jx7real");
  });

  test("an interactive session carries its own conversation, so it is not read", () => {
    expect(inheritedConversationOfHeadless("codex --model gpt CODECAST_CONVERSATION_ID=jx7own")).toBeNull();
    expect(inheritedConversationOfHeadless("/usr/local/bin/claude --session-id abc CODECAST_CONVERSATION_ID=jx7own")).toBeNull();
  });

  test("a run started outside any session inherits nothing", () => {
    expect(inheritedConversationOfHeadless("codex exec review HOME=/Users/a PATH=/bin")).toBeNull();
    expect(inheritedConversationOfHeadless("codex exec review XCODECAST_CONVERSATION_ID=jx7abc")).toBeNull();
  });
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-headless-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("a headless run is no inbox card, with or without a spawner", () => {
  expect(headlessRunStaysOutOfInbox({ headless: true })).toBe(true);
  expect(headlessRunStaysOutOfInbox({ headless: false })).toBe(false);
});

test("a trigger's run, a fork or handoff, and a teammate keep their own placement", () => {
  expect(headlessRunStaysOutOfInbox({ headless: true, triggerRun: true })).toBe(false);
  expect(headlessRunStaysOutOfInbox({ headless: true, forkOrHandoff: true })).toBe(false);
  expect(headlessRunStaysOutOfInbox({ headless: true, teammate: true })).toBe(false);
});

function rollout(dir: string, id: string, payload: Record<string, unknown>, mtime?: Date): void {
  const day = path.join(dir, "2026", "11", "14");
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id, ...payload } }) + "\n" + JSON.stringify({ type: "event_msg" }) + "\n");
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

const readHead = (file: string) => fs.readFileSync(file, "utf8");

test("the repair marks leaked codex exec runs this machine knows, once", async () => {
  const sessionsDir = path.join(root, "a", "sessions");
  const markerFile = path.join(root, "a", "repairs", "marker.json");
  const now = Date.parse("2026-11-14T20:00:00Z");
  rollout(sessionsDir, "leaked", { originator: "codex_exec", source: "exec" });
  rollout(sessionsDir, "interactive", { originator: "codex-tui", source: "cli" });
  rollout(sessionsDir, "unknown-here", { originator: "codex_exec", source: "exec" });
  rollout(sessionsDir, "too-old", { originator: "codex_exec", source: "exec" }, new Date(now - 60 * 24 * 60 * 60 * 1000));
  const conversations = { leaked: "jx7a", interactive: "jx7b", "too-old": "jx7c" };
  const marked: string[] = [];
  const mark = async (id: string) => { marked.push(id); };

  expect(await repairLeakedHeadlessCodexRuns({ sessionsDir, markerFile, conversations, readHead, mark, now })).toBe(1);
  expect(marked).toEqual(["leaked"]);
  expect(await repairLeakedHeadlessCodexRuns({ sessionsDir, markerFile, conversations, readHead, mark, now })).toBe(0);
  expect(marked).toEqual(["leaked"]);
});

test("a mark that fails leaves the repair to run again", async () => {
  const sessionsDir = path.join(root, "b", "sessions");
  const markerFile = path.join(root, "b", "repairs", "marker.json");
  const now = Date.now();
  rollout(sessionsDir, "leaked", { originator: "codex_exec", source: "exec" });
  const conversations = { leaked: "jx7a" };
  let fail = true;
  const marked: string[] = [];
  const mark = async (id: string) => { if (fail) throw new Error("offline"); marked.push(id); };

  expect(await repairLeakedHeadlessCodexRuns({ sessionsDir, markerFile, conversations, readHead, mark, now })).toBe(0);
  fail = false;
  expect(await repairLeakedHeadlessCodexRuns({ sessionsDir, markerFile, conversations, readHead, mark, now })).toBe(1);
  expect(marked).toEqual(["leaked"]);
});

test("a mark the server refuses for good stops the repair after three starts", async () => {
  const sessionsDir = path.join(root, "c", "sessions");
  const markerFile = path.join(root, "c", "repairs", "marker.json");
  const now = Date.now();
  rollout(sessionsDir, "deleted", { originator: "codex_exec", source: "exec" });
  let asked = 0;
  const mark = async () => { asked++; throw new Error("Session moved"); };
  const run = () => repairLeakedHeadlessCodexRuns({ sessionsDir, markerFile, conversations: { deleted: "jx7a" }, readHead, mark, now });

  await run(); await run(); await run();
  expect(asked).toBe(3);
  await run();
  expect(asked).toBe(3);
});
