// After a reboot, a message to a session the person runs in their own
// terminal (herdr, Ghostty) reached the daemon before that terminal came back,
// found no process, and resumed the session in codecast's tmux. The host then
// reattached its own copy: two claudes on one transcript (2026-11-03,
// "Auto-resumed claude <id> in tmux=cc-resume-…" minutes before herdr
// resumed the same session).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HAND_HOST_BOOT_GRACE_MS, waitForHandHost } from "./handHostGrace.js";
import { functionBlock } from "./test-helpers/sourceRegion.js";

const BOOT_AT_MS = 1_793_700_000_000;
const before = (ms: number) => Math.floor((BOOT_AT_MS - ms) / 1000);
const herdrClaim = { pid: 51234, tty: "ttys004", ts: before(60 * 60_000), term: "herdr", launch_token: "" };

describe("waitForHandHost", () => {
  test("a session last started by hand in another terminal waits for it after a boot", () => {
    const verdict = waitForHandHost({ claim: herdrClaim, bootAtMs: BOOT_AT_MS, nowMs: BOOT_AT_MS + 90_000 });
    expect(verdict).toEqual({ wait: true, term: "herdr", remainingMs: HAND_HOST_BOOT_GRACE_MS - 90_000 });
  });

  test("once the grace has passed, the resume goes ahead", () => {
    expect(waitForHandHost({ claim: herdrClaim, bootAtMs: BOOT_AT_MS, nowMs: BOOT_AT_MS + HAND_HOST_BOOT_GRACE_MS + 1 }).wait).toBe(false);
  });

  test("a session codecast launched is resumed at once, as before", () => {
    const codecast = { ...herdrClaim, term: "tmux", launch_token: "ab".repeat(16) };
    expect(waitForHandHost({ claim: codecast, bootAtMs: BOOT_AT_MS, nowMs: BOOT_AT_MS + 1000 }).wait).toBe(false);
    // tmux with no token is still a tmux the daemon cannot be racing a host for.
    expect(waitForHandHost({ claim: { ...herdrClaim, term: "tmux" }, bootAtMs: BOOT_AT_MS, nowMs: BOOT_AT_MS + 1000 }).wait).toBe(false);
  });

  test("a claim written since the boot names a process that died after it, not one the boot took", () => {
    const sinceBoot = { ...herdrClaim, ts: Math.floor((BOOT_AT_MS + 30_000) / 1000) };
    expect(waitForHandHost({ claim: sinceBoot, bootAtMs: BOOT_AT_MS, nowMs: BOOT_AT_MS + 60_000 }).wait).toBe(false);
  });

  test("no claim, an unknown terminal or an old-format claim proves nothing", () => {
    expect(waitForHandHost({ claim: null, bootAtMs: BOOT_AT_MS, nowMs: BOOT_AT_MS + 1000 }).wait).toBe(false);
    expect(waitForHandHost({ claim: { ...herdrClaim, term: "unknown" }, bootAtMs: BOOT_AT_MS, nowMs: BOOT_AT_MS + 1000 }).wait).toBe(false);
    const { launch_token: _, ...oldFormat } = herdrClaim;
    expect(waitForHandHost({ claim: oldFormat, bootAtMs: BOOT_AT_MS, nowMs: BOOT_AT_MS + 1000 }).wait).toBe(false);
  });
});

describe("the delivery path asks before its last-resort resume", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.ts"), "utf8");

  test("the dead-process registry cleanup remembers the claim it deletes", () => {
    const body = functionBlock(src, "findSessionProcessImpl").text;
    const cleanupAt = body.indexOf("Process is dead, clean up stale registry");
    expect(cleanupAt).toBeGreaterThan(-1);
    expect(body.indexOf("rememberDeadClaim(sessionId, reg)")).toBeGreaterThan(-1);
    expect(body.indexOf("rememberDeadClaim(sessionId, reg)")).toBeLessThan(body.indexOf("fs.unlinkSync(registryFile)", cleanupAt));
  });

  test("the hand-host wait is checked before the tmux auto-resume", () => {
    const body = functionBlock(src, "deliverMessageIntoSession").text;
    const waitAt = body.indexOf("waitForHandHost(");
    const resumeAt = body.indexOf("Last resort: auto-resume in a new tmux session");
    expect(waitAt).toBeGreaterThan(-1);
    expect(resumeAt).toBeGreaterThan(-1);
    expect(waitAt).toBeLessThan(resumeAt);
  });
});
