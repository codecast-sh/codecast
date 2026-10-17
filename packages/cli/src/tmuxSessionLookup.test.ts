import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { findTmuxSessionsById, matchesTmuxConversation } from "./tmuxSessionLookup";

const run = promisify(execFile);
const sessionId = "4521d6f2-e2ad-42b1-bc6f-fcc646d15f62";

test("resume recovery verifies the full session stamp, not its name suffix", async () => {
  const query = async (args: string[]) => {
    expect(args.at(-1)).toBe("#{@codecast_session_id}");
    return { stdout: sessionId };
  };
  expect(await matchesTmuxConversation("cc-resume-title-4521d6f2", sessionId, query, "session")).toBe(true);
  expect(await matchesTmuxConversation("cc-resume-title-4521d6f2", sessionId + "-other", query, "session")).toBe(false);
});

test("direct recovery checks the full conversation stamp without listing the fleet", async () => {
  const query = async (args: string[]) => {
    expect(args).toEqual(["display-message", "-p", "-t", "cc-claude-suffix", "#{@codecast_conversation_id}"]);
    return { stdout: "conversation\n" };
  };
  expect(await matchesTmuxConversation("cc-claude-suffix", "conversation", query)).toBe(true);
  expect(await matchesTmuxConversation("cc-claude-suffix", "other-conversation", query)).toBe(false);
  expect(await matchesTmuxConversation("cc-claude-suffix", "", query)).toBe(false);
});

test("one query locates an exact session across a large fleet", async () => {
  let calls = 0;
  const rows = Array.from({ length: 700 }, (_, i) => `other-${i}|${sessionId}-${i}`);
  rows.push(`target|${sessionId}`, `prefix-only|${sessionId.slice(0, 8)}`, "unstamped|");
  const matches = await findTmuxSessionsById(sessionId, async args => {
    calls++;
    expect(args).toEqual(["list-sessions", "-F", "#{session_name}|#{@codecast_session_id}"]);
    return { stdout: rows.join("\n") + "\n" };
  });
  expect(matches).toEqual(["target"]);
  expect(calls).toBe(1);
});

test("missing identity never matches unstamped sessions", async () => {
  expect(await findTmuxSessionsById("", async () => { throw new Error("must not query"); })).toEqual([]);
});

test("conversation fallback also uses one exact metadata query", async () => {
  const calls: string[][] = [];
  const rows = Array.from({ length: 700 }, (_, i) => `other-${i}|conv-${i}`);
  rows.push("target|conv", "prefix|conv-longer");
  expect(await findTmuxSessionsById("conv", async args => {
    calls.push(args);
    return { stdout: rows.join("\n") };
  }, "conversation")).toEqual(["target"]);
  expect(calls).toEqual([["list-sessions", "-F", "#{session_name}|#{@codecast_conversation_id}"]]);
});

test("query errors propagate instead of claiming the fleet is empty", async () => {
  await expect(findTmuxSessionsById(sessionId, async () => { throw new Error("tmux timed out"); })).rejects.toThrow("tmux timed out");
});

describe("real tmux metadata lookup", () => {
  const root = mkdtempSync(join(tmpdir(), "cast-tmux-lookup-"));
  const socket = join(root, "tmux.sock");
  const query = (args: string[]) => run("tmux", ["-S", socket, ...args], { timeout: 5000 });

  beforeAll(async () => {
    await query([
      "-f", "/dev/null", "new-session", "-d", "-s", "target", "sleep 120", ";",
      "set-option", "-t", "target", "@codecast_session_id", sessionId, ";",
      "new-session", "-d", "-s", "same-prefix", "sleep 120", ";",
      "set-option", "-t", "same-prefix", "@codecast_session_id", sessionId.slice(0, 8) + "-other", ";",
      "new-session", "-d", "-s", "unstamped", "sleep 120",
    ]);
  }, 15_000);

  afterAll(async () => {
    await query(["kill-server"]);
    rmSync(root, { recursive: true, force: true });
  }, 15_000);

  test("finds exact stamps, handles duplicates and observes changes without stale cache", async () => {
    expect(await findTmuxSessionsById(sessionId, query)).toEqual(["target"]);
    await query(["set-option", "-t", "unstamped", "@codecast_session_id", sessionId]);
    expect(await findTmuxSessionsById(sessionId, query)).toEqual(["target", "unstamped"]);
    await query(["set-option", "-u", "-t", "target", "@codecast_session_id"]);
    expect(await findTmuxSessionsById(sessionId, query)).toEqual(["unstamped"]);
    expect(await findTmuxSessionsById("not-running", query)).toEqual([]);
    await query(["set-option", "-t", "target", "@codecast_conversation_id", "conversation-exact"]);
    expect(await matchesTmuxConversation("target", "conversation-exact", query)).toBe(true);
    expect(await matchesTmuxConversation("target", "conversation", query)).toBe(false);
    expect(await findTmuxSessionsById("conversation-exact", query, "conversation")).toEqual(["target"]);
    expect(await findTmuxSessionsById("conversation", query, "conversation")).toEqual([]);
  }, 30_000);
});
