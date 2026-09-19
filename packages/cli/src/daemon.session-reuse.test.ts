import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { pickReusableConversationTmux, startedSessionGuard, STARTED_SESSION_BOOT_WINDOW_MS } from "./daemon.js";

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
    const body = daemonSource.slice(start, start + 6000);
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
    const region = daemonSource.slice(anchor - 2000, anchor);
    expect(region).toContain('setTmuxSessionOption(tmuxSession, "@codecast_conversation_id", conversationId)');
  });

  test("first-message startup rechecks app-server registration while waiting", () => {
    const start = daemonSource.indexOf("Waiting up to 12s for start_session");
    expect(start).toBeGreaterThan(-1);
    const waitLoop = daemonSource.slice(start, start + 2500);
    // The recheck runs inside `deliveryStep`, which times the step; the await
    // moved to the wrapper, so the call is its last argument.
    expect(waitLoop).toMatch(/if \(await deliveryStep\([^)]*?,\s*tryAppServerDelivery\)\) return true/);
    expect(waitLoop.indexOf("tryAppServerDelivery")).toBeLessThan(
      waitLoop.indexOf("startFreshSessionForDelivery"),
    );
  });

  test("the Claude-only delivery fallback refuses a different declared agent", () => {
    const start = daemonSource.indexOf("async function startFreshSessionForDelivery");
    expect(start).toBeGreaterThan(-1);
    const body = daemonSource.slice(start, start + 5000);
    expect(body).toContain('if (declaredAgentType !== "claude")');
    expect(body.indexOf('if (declaredAgentType !== "claude")')).toBeLessThan(
      body.indexOf('const tmuxSession = `cc-claude-${shortId}`'),
    );
  });
});

// A transfer ("run on this device") queues resume_session for the destination.
// On 2026-09-19 two transfers did nothing: each conversation still had a start
// record from 18 hours earlier (the pane was started here while another device
// owned the conversation, so its first message was never delivered and the pane
// never linked). The resume guard treated any unlinked record as "freshly
// started" and returned early, so no pane was started and no delivery was
// scheduled until the human pressed kill and restart.
describe("startedSessionGuard", () => {
  const now = 1_789_826_355_000;

  test("skips the resume while an unlinked pane is still inside its boot window", () => {
    expect(startedSessionGuard({ startedAt: now - 5_000 }, false, now)).toBe("skip_booting");
    expect(startedSessionGuard({ startedAt: now - STARTED_SESSION_BOOT_WINDOW_MS + 1 }, false, now)).toBe("skip_booting");
  });

  test("replaces an unlinked start record that outlived its boot window", () => {
    expect(startedSessionGuard({ startedAt: now - STARTED_SESSION_BOOT_WINDOW_MS }, false, now)).toBe("replace_stale");
    expect(startedSessionGuard({ startedAt: now - 18 * 60 * 60 * 1000 }, false, now)).toBe("replace_stale");
  });

  test("proceeds when there is no record or the conversation is linked", () => {
    expect(startedSessionGuard(undefined, false, now)).toBe("proceed");
    expect(startedSessionGuard({ startedAt: now - 5_000 }, true, now)).toBe("proceed");
  });

  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "daemon.ts"), "utf-8");

  test("resume_session tears a stale pane down instead of returning early", () => {
    const start = source.indexOf("// Fresh-session guard.");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 3000);
    expect(body).toContain("startedSessionGuard(");
    expect(body).toContain('"replace_stale"');
    expect(body.indexOf("teardownConversationBackendsLive(conversationId)")).toBeGreaterThan(body.indexOf('"replace_stale"'));
  });

  test("the blank restart shares the boot window and reschedules delivery", () => {
    const anchor = source.indexOf("[REMOTE] Started fresh session ${tmuxSession} for conversation");
    const region = source.slice(anchor - 4500, anchor + 600);
    expect(region).not.toContain("60_000");
    expect(region).toContain('startedSessionGuard(existingStarted, false) === "skip_booting"');
    expect(region).toContain('clearConversationDeliveryAndResumeState(conversationId, undefined, "resume_session_blank")');
  });
});

// 2026-09-19: pulling a four minute old session to this machine logged "not
// found locally", rebuilt its transcript from the server over the real file,
// then failed with "Reconstituted file not found" while the file sat at that
// exact path. findSessionFile answers null on the first ask for a transcript
// younger than the index; the resume path treats null as absent.
describe("autoResumeSession transcript lookup", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "daemon.ts"), "utf-8");
  const end = source.indexOf("Reconstituted file not found at expected path");
  const start = source.lastIndexOf("const forkFromSessionId = opts?.forkFromSessionId;", end);

  test("awaits ground truth before it decides the transcript is missing", () => {
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, end);
    expect(body).toContain("await awaitRecentSessionFile(forkFromSessionId ?? sessionId)");
    expect(body).toContain("await awaitRecentSessionFile(reconId)");
    expect(body).not.toMatch(/sessionFile = findSessionFile\(/);
  });
});

// An adopted pane keeps its real age. Both adoption sites stamped Date.now(),
// so each daemon restart made an old unlinked pane "freshly started" again and
// the resume guard skipped the very resume that would have replaced it.
describe("adopted panes keep their tmux creation time", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "daemon.ts"), "utf-8");

  test("findLiveTmuxForConversation and warm restart read session_created", () => {
    const find = source.slice(source.indexOf("async function findLiveTmuxForConversation"));
    expect(find.slice(0, 1500)).toContain("startedAt: await tmuxSessionCreatedAtMs(match)");
    const warm = source.slice(source.indexOf("const cachedSessionId = findCachedSessionIdForConversation(conversationCache, tmuxConvId);"));
    expect(warm.slice(0, 1200)).toContain("startedAt: await tmuxSessionCreatedAtMs(recoveredTmuxSession)");
  });
});
