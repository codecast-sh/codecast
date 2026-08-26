import { describe, expect, test } from "bun:test";
import { recLeaseExpired } from "./transcripts";
import { CALL_MEMBER_STALE_MS } from "@codecast/shared/contracts";

// A recording is the one live transcript with nobody seated in a room, and the
// orphan sweep has to tell that apart from a huddle everybody left. Getting it
// wrong is not subtle: the sweep runs every two minutes, so a recording would
// end itself in the middle of the meeting it was recording.
describe("recLeaseExpired", () => {
  const now = 1_800_000_000_000;

  test("a recording beating right now is not an orphan", () => {
    expect(recLeaseExpired({ started_at: now - 3_600_000, last_beat: now - 1_000 }, now)).toBe(false);
  });

  test("a recording that has not beaten yet is measured from its start", () => {
    // The first beat is fifteen seconds in; a tab that died before it still
    // has to be swept, and a recording that just began must not be.
    expect(recLeaseExpired({ started_at: now - 5_000 }, now)).toBe(false);
    expect(recLeaseExpired({ started_at: now - CALL_MEMBER_STALE_MS - 1 }, now)).toBe(true);
  });

  test("the window is a seat's, so a missed beat reads exactly like a missed lease", () => {
    expect(recLeaseExpired({ started_at: 0, last_beat: now - CALL_MEMBER_STALE_MS + 1 }, now)).toBe(false);
    expect(recLeaseExpired({ started_at: 0, last_beat: now - CALL_MEMBER_STALE_MS }, now)).toBe(true);
  });
});
