import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { pickReusableConversationTmux } from "./daemon.js";

// Regression coverage for the web new-session double-start (root-caused 2026-05-25).
//
// Root cause recap: one conversation spawned three Claude sessions (a killed
// conv-id-named session, an orphaned resume-fallback session, and the linked
// delivery-fresh session). startedSessionTmux is an in-memory cache that
// persists to disk and reloads on every daemon construction, so across the
// daemon's frequent restarts it can hold an entry pointing at a session killed
// in a prior lifetime. The delivery path acted on that stale entry, its cleanup
// deleted it (orphaning the live resume-fallback session whose discovery then
// aborted), and a redundant fresh session was spawned and became the winner.
//
// Fix: before spawning a fresh session, consult tmux — the durable source of
// truth — for a live session already tagged with this conversation, and reuse
// it. pickReusableConversationTmux is the pure selector at the heart of that.

describe("pickReusableConversationTmux", () => {
  const conv = "jx78tg3ttvyekf336x2kq402an87atbn";

  test("returns a live session tagged with the conversation", () => {
    expect(
      pickReusableConversationTmux(
        [{ tmuxSession: "cc-claude-oqssy1", conversationId: conv, alive: true }],
        conv,
      ),
    ).toBe("cc-claude-oqssy1");
  });

  test("ignores a dead session even if it matches the conversation (the killed q402 case)", () => {
    expect(
      pickReusableConversationTmux(
        [{ tmuxSession: "cc-claude-q402an87atbn", conversationId: conv, alive: false }],
        conv,
      ),
    ).toBeNull();
  });

  test("ignores live sessions for other conversations (no cwd-fallback hijack)", () => {
    expect(
      pickReusableConversationTmux(
        [{ tmuxSession: "cc-claude-other", conversationId: "someOtherConv", alive: true }],
        conv,
      ),
    ).toBeNull();
  });

  test("skips a dead match and reuses the live one for the same conversation", () => {
    expect(
      pickReusableConversationTmux(
        [
          { tmuxSession: "cc-claude-q402an87atbn", conversationId: conv, alive: false },
          { tmuxSession: "cc-claude-oqssy1", conversationId: conv, alive: true },
        ],
        conv,
      ),
    ).toBe("cc-claude-oqssy1");
  });

  test("ignores untagged sessions", () => {
    expect(
      pickReusableConversationTmux(
        [{ tmuxSession: "cc-claude-legacy", conversationId: null, alive: true }],
        conv,
      ),
    ).toBeNull();
  });

  test("returns null when there are no candidates", () => {
    expect(pickReusableConversationTmux([], conv)).toBeNull();
  });
});

// Source-invariant guards: the fix relies on two structural properties that are
// easy to silently regress. These assert against daemon.ts text (they do not
// execute the daemon).
const daemonSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.ts"),
  "utf8",
);

describe("double-start fix invariants", () => {
  test("startFreshSessionForDelivery consults tmux before spawning fresh", () => {
    const start = daemonSource.indexOf("async function startFreshSessionForDelivery");
    expect(start).toBeGreaterThan(-1);
    const body = daemonSource.slice(start, start + 3500);
    const reuseIdx = body.indexOf("findLiveTmuxForConversation");
    const spawnIdx = body.indexOf("new-session");
    expect(reuseIdx).toBeGreaterThan(-1);
    // The reuse lookup must precede the new-session spawn.
    expect(reuseIdx).toBeLessThan(spawnIdx);
  });

  test("the resume fallback tags its tmux with @codecast_conversation_id", () => {
    // The blank-session-after-resume-failure path must tag the conversation so
    // findLiveTmuxForConversation can later see it (the orphaned-oqssy1 fix).
    const anchor = daemonSource.indexOf("[REMOTE] Started fresh session ${tmuxSession} for conversation");
    expect(anchor).toBeGreaterThan(-1);
    const region = daemonSource.slice(anchor - 1200, anchor);
    expect(region).toContain('setTmuxSessionOption(tmuxSession, "@codecast_conversation_id", conversationId)');
  });
});
