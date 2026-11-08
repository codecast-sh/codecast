import { describe, expect, test } from "bun:test";
import { stuckTranscriptLines } from "./daemon.js";

// 2026-11-05: one 6,900-message transcript sat unsynced for three hours while
// the hourly report said only "Health: 1 pending files", and the reason its
// pass kept failing stayed in an info line on the machine.
const SID = "ffde0040-0112-415b-8ae0-af03d9e938ff";
const FILE = `/Users/a/.claude/projects/-Users-a-slack-bot/${SID}.jsonl`;
const NOW = Date.parse("2026-11-05T21:41:57Z");

describe("stuckTranscriptLines", () => {
  test("names a file pending past ten minutes, since when, and its last pass failure", () => {
    const lines = stuckTranscriptLines(
      [FILE],
      NOW,
      () => ({ lastSyncedAt: Date.parse("2026-11-05T20:35:01Z"), lastSyncedPosition: 123 }),
      new Map([[SID, { at: Date.parse("2026-11-05T21:41:30Z"), reason: "ingest transaction deadline" }]]),
    );
    expect(lines).toEqual([{
      sessionId: SID,
      message: `Sync stuck: session ${SID} unsynced since 2026-11-05T20:35:01.000Z at byte 123; last failure 2026-11-05T21:41:30.000Z: ingest transaction deadline`,
    }]);
  });

  test("a file that synced minutes ago, or never, is not reported as stuck", () => {
    expect(stuckTranscriptLines([FILE], NOW, () => ({ lastSyncedAt: NOW - 60_000, lastSyncedPosition: 1 }), new Map())).toEqual([]);
    expect(stuckTranscriptLines([FILE], NOW, () => null, new Map())).toEqual([]);
  });

  test("says so when no pass failure was recorded", () => {
    const [line] = stuckTranscriptLines([FILE], NOW, () => ({ lastSyncedAt: NOW - 3_600_000, lastSyncedPosition: 9 }), new Map());
    expect(line.message.endsWith("no pass failure recorded")).toBe(true);
  });
});
