import { describe, expect, test } from "bun:test";
import { readHistoryHits } from "../historyLookup";

// The shape Union's history.search answers, with made-up people.
const ANSWER = JSON.stringify({
  text: `Found 2 activities matching "Quinn":

[2026-10-12 22:39] [#outreach] slack_message_sent: #outreach | Aivery: New Email Reply
*From:*
Pat Doe
*Message:*
Hi Quinn,

Wed Oct 14 works. Send the Zoom when you can.
 (id: 5da026f0-6b0f-4c97-9fad-297d5fbc06fd)
[2026-10-12 14:28] [contact:995b6c3f] difficulty_flagged: Suggested brief: "Hi Sam, Quinn from Union, just tried you by phone." (id: 688e6ca9-3be5-4e8d-8119-b14976cb60e8)
[2026-10-12 06:21] [#outreach] slack_message_sent: #outreach | Aivery: New Email Reply cut by the app before the name... (id: 1a2b3c4d-0000-4000-8000-000000000000)`,
});

describe("a person in the app's history", () => {
  test("each activity is its time, where it happened and the words around the name, without markup or ids", () => {
    const hits = readHistoryHits(ANSWER, "Quinn");
    expect(hits.map((h) => [h.at, h.where])).toEqual([["2026-10-12 22:39", "#outreach"], ["2026-10-12 14:28", "contact:995b6c3f"]]);
    expect(hits[0].words).toContain("Hi Quinn, Wed Oct 14 works.");
    expect(hits[0].words).not.toContain("*");
    expect(hits[1].words).not.toContain("(id:");
    expect(hits[1].words.startsWith("Suggested brief")).toBe(true);
    expect(hits[0].words).not.toContain("slack_message_sent");
  });

  test("nothing found is no hits", () => {
    expect(readHistoryHits(JSON.stringify({ text: 'No activities match "Zed".' }), "Zed")).toEqual([]);
  });
});
