import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { grokSessionCwdFromTranscriptPath, isGrokInternalSessionDir } from "./daemon.js";

// processGrokSession's two path-level decisions, exercised against real dirs laid
// out exactly like ~/.grok/sessions/<url-encoded-cwd>/<uuid>/: where a session's
// cwd comes from (sibling summary.json first, encoded dir name as fallback), and
// whether a session dir is grok-internal (subagent/hidden) and must be skipped.
const FIXTURES = path.join(import.meta.dir, "__fixtures__", "grok");
const trash: string[] = [];
afterAll(() => {
  for (const dir of trash) fs.rmSync(dir, { recursive: true, force: true });
});

// Build <root>/<slugDir>/<uuid>/updates.jsonl (+ optional summary.json fixture).
function makeSessionDir(slugDir: string, summaryFixture?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-sessions-"));
  trash.push(root);
  const sessionDir = path.join(root, slugDir, "01a04000-4d49-70f3-88b4-316e8f48a5fb");
  fs.mkdirSync(sessionDir, { recursive: true });
  const updatesPath = path.join(sessionDir, "updates.jsonl");
  fs.writeFileSync(updatesPath, "");
  if (summaryFixture) {
    fs.copyFileSync(path.join(FIXTURES, summaryFixture), path.join(sessionDir, "summary.json"));
  }
  return updatesPath;
}

describe("grokSessionCwdFromTranscriptPath", () => {
  test("prefers the sibling summary.json info.cwd (authoritative, survives relocation)", () => {
    // Encoded dir says /elsewhere; summary says /tmp/grok-demo — summary wins.
    const updates = makeSessionDir("%2Felsewhere", "summary-normal.json");
    expect(grokSessionCwdFromTranscriptPath(updates)).toBe("/tmp/grok-demo");
  });

  test("falls back to decoding the url-encoded grandparent dir when summary.json is absent", () => {
    const updates = makeSessionDir("%2FUsers%2Fashot%2Fsrc%2Fcodecast");
    expect(grokSessionCwdFromTranscriptPath(updates)).toBe("/Users/ashot/src/codecast");
  });

  test("a long-path hash dir (not %-decodable to an absolute path) yields undefined, never garbage", () => {
    const updates = makeSessionDir("codecast-a1b2c3d4e5f60718");
    expect(grokSessionCwdFromTranscriptPath(updates)).toBeUndefined();
  });
});

describe("isGrokInternalSessionDir (subagent/hidden skip)", () => {
  test("a normal session is not internal", () => {
    expect(isGrokInternalSessionDir(makeSessionDir("%2Ftmp%2Fgrok-demo", "summary-normal.json"))).toBe(false);
  });

  test("subagent and hidden sessions are internal — never top-level conversations", () => {
    expect(isGrokInternalSessionDir(makeSessionDir("%2Ftmp%2Fgrok-demo", "summary-subagent.json"))).toBe(true);
    expect(isGrokInternalSessionDir(makeSessionDir("%2Ftmp%2Fgrok-demo", "summary-hidden.json"))).toBe(true);
  });

  test("a missing summary.json means NOT internal (summary can land after the first updates)", () => {
    expect(isGrokInternalSessionDir(makeSessionDir("%2Ftmp%2Fgrok-demo"))).toBe(false);
  });
});
