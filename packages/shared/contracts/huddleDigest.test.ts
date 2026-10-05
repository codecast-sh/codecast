import { describe, expect, test } from "bun:test";
import {
  formatHuddleDigest,
  formatHuddleSummaryTag,
  huddleDigestLead,
  isHuddleSummaryTag,
  parseHuddleDigestContent,
  parseHuddleSummaryTag,
} from "./huddleDigest";

const digest = {
  title: "Auth rollout",
  startedAt: 1_000,
  endedAt: 1_000 + 12 * 60_000,
  speakers: ["Alice", "Bob"],
  summary: "Alice and Bob agreed to ship the fix behind a flag.",
  actionItems: ["Bob: ship the fix behind a flag"],
  summaryStatus: "done" as const,
};

describe("formatHuddleDigest", () => {
  test("title, lead, summary and action items in one markdown block", () => {
    const out = formatHuddleDigest(digest);
    expect(out).toBe(
      "**Auth rollout** · 12 min huddle with Alice and Bob\n\n" +
        "Alice and Bob agreed to ship the fix behind a flag.\n\n" +
        "Action items:\n- Bob: ship the fix behind a flag",
    );
  });

  test("a missing summary says why instead of showing nothing", () => {
    expect(formatHuddleDigest({ ...digest, summary: null, summaryStatus: "failed" })).toContain(
      "The summary could not be generated.",
    );
    expect(formatHuddleDigest({ ...digest, summary: null, summaryStatus: "skipped" })).toContain(
      "Too short to summarize.",
    );
  });

  test("round-trips: the chat row's markdown parses back into a header", () => {
    const parsed = parseHuddleDigestContent(formatHuddleDigest(digest))!;
    expect(parsed.title).toBe("Auth rollout");
    expect(parsed.lead).toBe("12 min huddle with Alice and Bob");
    expect(parsed.body).toBe(
      "Alice and Bob agreed to ship the fix behind a flag.\n\n" +
        "Action items:\n- Bob: ship the fix behind a flag",
    );
  });

  test("refuses markdown this formatter did not write", () => {
    expect(parseHuddleDigestContent("just a normal message")).toBeNull();
    expect(parseHuddleDigestContent("**bold** but no separator line")).toBeNull();
  });

  test("the lead line survives odd rosters", () => {
    expect(huddleDigestLead({ startedAt: 0, endedAt: 60_000, speakers: ["Alice"] })).toBe(
      "1 min huddle with Alice",
    );
    expect(huddleDigestLead({ startedAt: 0, endedAt: null, speakers: [] })).toBe("Huddle");
    expect(huddleDigestLead({ startedAt: 0, endedAt: 90_000, speakers: ["A", "B", "C"] })).toBe(
      "2 min huddle with A, B and C",
    );
  });
});

describe("the huddle-summary wire tag", () => {
  test("round-trips: what the agent receives parses back into the card", () => {
    const wire = formatHuddleSummaryTag("t123", digest);
    expect(isHuddleSummaryTag(wire)).toBe(true);
    expect(wire).toContain("cast call t123 --transcript");
    const parsed = parseHuddleSummaryTag(wire)!;
    expect(parsed.transcriptId).toBe("t123");
    expect(parsed.title).toBe("Auth rollout");
    expect(parsed.minutes).toBe(12);
    expect(parsed.speakers).toEqual(["Alice", "Bob"]);
    // The card body is the digest alone — the framing sentence and the command
    // are instructions to the agent, not something anyone said.
    expect(parsed.body).toBe(formatHuddleDigest(digest));
  });

  test("tolerates a preview sliced before the closing tag", () => {
    const wire = formatHuddleSummaryTag("t123", digest).slice(0, 180);
    const parsed = parseHuddleSummaryTag(wire)!;
    expect(parsed.transcriptId).toBe("t123");
    expect(parsed.title).toBe("Auth rollout");
  });

  test("ordinary text is not a huddle tag", () => {
    expect(isHuddleSummaryTag("hello <huddle-summary> in prose")).toBe(false);
    expect(parseHuddleSummaryTag("just words")).toBeNull();
  });
});

// A filmed huddle names its video wherever its digest lands, and a card reads
// the stretches back from the same words, so the chat row and the session
// turn need no field of their own for it.
describe("a huddle recorded on video", () => {
  const filmed = { ...digest, video: [{ fromMs: 280_000, toMs: 440_000 }, { fromMs: 600_000, toMs: 615_000 }] };

  test("the digest says so on its own line, and the card reads it back", () => {
    const out = formatHuddleDigest(filmed);
    expect(out).toContain("\n\nRecorded on video: 4:40-7:20, 10:00-10:15.\n\n");
    const head = parseHuddleDigestContent(out)!;
    expect(head.video).toEqual(filmed.video);
    expect(head.body).toBe(
      "Alice and Bob agreed to ship the fix behind a flag.\n\n" + "Action items:\n- Bob: ship the fix behind a flag",
    );
  });

  test("filmed in silence: the video is what it left, with no excuse for a summary", () => {
    const silent = { ...filmed, speakers: [], summary: null, actionItems: [], summaryStatus: "skipped" as const };
    expect(formatHuddleDigest(silent)).toBe(
      "**Auth rollout** · 12 min huddle\n\nRecorded on video: 4:40-7:20, 10:00-10:15.",
    );
    const head = parseHuddleDigestContent(formatHuddleDigest(silent))!;
    expect(head.body).toBe("");
    expect(head.video).toEqual(filmed.video);
  });

  test("the agent is told it can snap a frame, by the call's short id", () => {
    const wire = formatHuddleSummaryTag("t123", filmed, { callRef: "cl-42" });
    expect(wire).toContain("`cast call snap cl-42:<line>`");
    const parsed = parseHuddleSummaryTag(wire)!;
    expect(parsed.video).toEqual(filmed.video);
    expect(parsed.body).toBe(formatHuddleDigest(filmed));
    expect(formatHuddleSummaryTag("t123", digest)).not.toContain("cast call snap");
    expect(parseHuddleSummaryTag(formatHuddleSummaryTag("t123", digest))!.video).toBeNull();
  });

  test("heard live: the card body is still the digest alone", () => {
    const parsed = parseHuddleSummaryTag(formatHuddleSummaryTag("t123", filmed, { heardLive: true }))!;
    expect(parsed.body).toBe(formatHuddleDigest(filmed));
    expect(parsed.video).toEqual(filmed.video);
  });

  test("a line that only looks like the video line is left in the body", () => {
    const head = parseHuddleDigestContent("**Huddle** · 2 min huddle\n\nRecorded on video: soon.")!;
    expect(head.video).toBeNull();
    expect(head.body).toBe("Recorded on video: soon.");
  });
});
