import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { mtimeNeedsContentCheck, newestLineTimestampMs, transcriptActivityMs } from "./transcriptActivity.js";

const H = 3600_000;

describe("transcriptActivity", () => {
  test("a touched mtime does not make an old transcript fresh", () => {
    // The shape found on 2026-09-17: newest line 18h old, mtime 20 minutes old.
    const now = Date.parse("2026-09-18T01:30:00Z");
    const tail = [
      JSON.stringify({ type: "assistant", timestamp: "2026-09-17T03:06:33.323Z", message: { role: "assistant" } }),
      JSON.stringify({ type: "system", subtype: "stop_hook_summary", hookCount: 1 }),
      JSON.stringify({ type: "system", subtype: "turn_duration", timestamp: "2026-09-17T03:06:33.572Z" }),
    ].join("\n");
    const mtime = now - 20 * 60_000;
    expect(mtimeNeedsContentCheck(mtime, 5 * H, now)).toBe(true);
    const activity = transcriptActivityMs(mtime, tail);
    expect(activity).toBe(Date.parse("2026-09-17T03:06:33.572Z"));
    expect(now - activity).toBeGreaterThan(5 * H);
  });

  test("a transcript being written reads as fresh", () => {
    const now = Date.now();
    const tail = JSON.stringify({ type: "user", timestamp: new Date(now - 60_000).toISOString() });
    expect(now - transcriptActivityMs(now - 30_000, tail)).toBeLessThan(2 * 60_000);
  });

  test("grok epoch seconds, codex ISO, a cut first line, and trailing lines without timestamps", () => {
    const tail = [
      '"timestamp":"2026-09-17T00:00:00Z"}', // the tail's cut first line
      JSON.stringify({ timestamp: 1789694590, method: "_x.ai/session/update" }),
      JSON.stringify({ type: "atis-latch", sessionId: "x" }),
      "",
    ].join("\n");
    expect(newestLineTimestampMs(tail)).toBe(1789694590 * 1000);
    expect(newestLineTimestampMs(JSON.stringify({ timestamp: "2026-09-17T14:32:16.351Z", type: "event_msg" }))).toBe(Date.parse("2026-09-17T14:32:16.351Z"));
  });

  test("falls back to mtime when nothing in the tail carries a time, and never runs ahead of mtime", () => {
    expect(transcriptActivityMs(1000, "not json\n{}")).toBe(1000);
    expect(transcriptActivityMs(1000, null)).toBe(1000);
    expect(transcriptActivityMs(1000, JSON.stringify({ timestamp: new Date(5000).toISOString() }))).toBe(1000);
  });

  test("an old mtime settles the question without a read", () => {
    const now = Date.now();
    expect(mtimeNeedsContentCheck(now - 6 * H, 5 * H, now)).toBe(false);
  });

  // The reapers kill terminals and browsers on this answer. Both must ask
  // transcriptActivityMs, never raw mtime, or a touched transcript keeps a dead
  // owner "live" forever (active×174 in reaper.log, 2026-09-17).
  test("both reapers measure idleness through transcriptActivityMs", () => {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const daemon = fs.readFileSync(path.join(dir, "daemon.ts"), "utf8");
    const gate = daemon.slice(daemon.indexOf("async function reapBlockReason("), daemon.indexOf("async function reapOneTerminal("));
    expect(gate.length).toBeGreaterThan(500);
    expect(gate).toContain("transcriptActivityMs(mtimeMs, tail)");
    expect(gate).not.toMatch(/idleMs\s*=\s*now\s*-\s*fs\.statSync/);
    const engine = fs.readFileSync(path.join(dir, "browser", "engineReap.ts"), "utf8");
    expect(engine).toContain("transcriptActivityMs(newest, tail)");
    expect(engine).toContain("now - transcriptActivity(id, opts.projectsDir, now)");
  });
});
