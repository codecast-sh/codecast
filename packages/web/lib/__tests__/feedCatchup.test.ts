import { describe, expect, it } from "bun:test";
import { newestTs, oldestTs, planFeedCatchup, walkStep } from "../feedCatchup";

const rows = (...ts: number[]) => ts.map((updated_at) => ({ updated_at }));

describe("newestTs/oldestTs", () => {
  it("finds the extremes regardless of order", () => {
    expect(newestTs(rows(5, 9, 2))).toBe(9);
    expect(oldestTs(rows(5, 9, 2))).toBe(2);
  });
  it("ignores rows without a timestamp; null when none carry one", () => {
    expect(newestTs([{ updated_at: 7 }, {}])).toBe(7);
    expect(newestTs([])).toBeNull();
    expect(oldestTs([{}])).toBeNull();
  });
});

describe("planFeedCatchup", () => {
  it("a short page with no continuation is the whole history", () => {
    expect(
      planFeedCatchup({ coveredTo: undefined, livePageFull: false, liveOldest: 100, cacheHasRowsBelowLive: true })
    ).toBe("contiguous");
  });

  it("contiguous when the live page reaches down into the covered band", () => {
    expect(
      planFeedCatchup({ coveredTo: 500, livePageFull: true, liveOldest: 400, cacheHasRowsBelowLive: true })
    ).toBe("contiguous");
  });

  it("walks when the live page floats above the covered band (time away)", () => {
    expect(
      planFeedCatchup({ coveredTo: 500, livePageFull: true, liveOldest: 900, cacheHasRowsBelowLive: true })
    ).toBe("walk");
  });

  // The screenshot bug: a cache built before the watermark existed shows
  // "Today, then July" — old rows below the live page, no watermark, and the
  // deep cursor resumes below July. The plan must walk, never trust it.
  it("walks a legacy cache: rows below the live page but no watermark", () => {
    expect(
      planFeedCatchup({ coveredTo: undefined, livePageFull: true, liveOldest: 900, cacheHasRowsBelowLive: true })
    ).toBe("walk");
  });

  it("a fresh cache with nothing below the live page starts coverage here", () => {
    expect(
      planFeedCatchup({ coveredTo: undefined, livePageFull: true, liveOldest: 900, cacheHasRowsBelowLive: false })
    ).toBe("contiguous");
  });
});

describe("walkStep", () => {
  it("continues while above the covered band", () => {
    expect(walkStep({ coveredTo: 500, pageOldest: 700, nextCursor: "c" })).toBe("continue");
  });

  it("reconnects once the page reaches the covered band", () => {
    expect(walkStep({ coveredTo: 500, pageOldest: 500, nextCursor: "c" })).toBe("reconnected");
    expect(walkStep({ coveredTo: 500, pageOldest: 400, nextCursor: "c" })).toBe("reconnected");
  });

  it("never reconnects without a watermark (legacy walks to end or budget)", () => {
    expect(walkStep({ coveredTo: undefined, pageOldest: 1, nextCursor: "c" })).toBe("continue");
  });

  it("rows with a null cursor is honest end-of-history", () => {
    expect(walkStep({ coveredTo: 500, pageOldest: 700, nextCursor: null })).toBe("end");
  });

  // An unauthenticated/blipped query returns {[], null} — the exact shape of
  // end-of-history. Stamping the watermark off it would persist fake coverage
  // over a real gap, so the walk must abort and retry instead.
  it("aborts on an empty page with a null cursor (auth-blip shape)", () => {
    expect(walkStep({ coveredTo: 500, pageOldest: null, nextCursor: null })).toBe("abort");
  });
});
