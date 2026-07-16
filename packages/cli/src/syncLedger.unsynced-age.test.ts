import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { oldestTimestampInChunk, readOldestUnsyncedTimestamp } from "./syncLedger.js";

// `cast status` must distinguish a wedged sync (unsynced bytes waiting for ages)
// from a session that sat quiet for an hour and just burst back to life after an
// auto-resume: both have a stale lastSyncedAt, but only the wedge is actionable.
// The discriminator is the age of the oldest unsynced line's own timestamp.

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTranscript(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unsynced-age-"));
  tempDirs.push(dir);
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

const at = (iso: string, rest: object = {}) =>
  JSON.stringify({ timestamp: iso, type: "assistant", ...rest });

describe("oldestTimestampInChunk", () => {
  test("returns the first line's timestamp", () => {
    const chunk = [at("2026-07-02T12:52:08.190Z"), at("2026-07-02T12:53:09.158Z")].join("\n");
    expect(oldestTimestampInChunk(chunk)).toBe(Date.parse("2026-07-02T12:52:08.190Z"));
  });

  test("skips timestampless rows (agent-name) and finds the next real message", () => {
    const chunk = [
      JSON.stringify({ type: "agent-name", name: "worker" }),
      at("2026-07-02T12:52:08.190Z"),
    ].join("\n");
    expect(oldestTimestampInChunk(chunk)).toBe(Date.parse("2026-07-02T12:52:08.190Z"));
  });

  test("does not read timestamps embedded in message content", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: 'log said "timestamp":"2020-01-01T00:00:00Z" somewhere' },
    });
    expect(oldestTimestampInChunk(line)).toBeNull();
  });

  test("skips a truncated (mid-line) JSON tail and empty input", () => {
    expect(oldestTimestampInChunk(at("2026-07-02T12:52:08.190Z").slice(0, 20))).toBeNull();
    expect(oldestTimestampInChunk("")).toBeNull();
  });
});

describe("readOldestUnsyncedTimestamp", () => {
  test("reads the first timestamp at/after the synced position", () => {
    const synced = at("2026-07-02T11:29:27.018Z");
    const unsynced = at("2026-07-02T12:52:08.190Z");
    const file = makeTranscript([synced, unsynced]);
    const position = synced.length + 1; // past the synced line + newline
    expect(readOldestUnsyncedTimestamp(file, position)).toBe(
      Date.parse("2026-07-02T12:52:08.190Z"),
    );
  });

  test("returns null past end of file and for a missing file", () => {
    const file = makeTranscript([at("2026-07-02T11:29:27.018Z")]);
    expect(readOldestUnsyncedTimestamp(file, 10_000_000)).toBeNull();
    expect(readOldestUnsyncedTimestamp(file + ".gone", 0)).toBeNull();
  });
});
