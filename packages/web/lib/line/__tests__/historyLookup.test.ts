import { describe, expect, test } from "bun:test";
import { readHistoryHits, readHistoryItem } from "../historyLookup";

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
[2026-10-12 06:21] [#outreach] slack_message_sent: #outreach | Aivery: New Email Reply cut by the app before the name... (id: 1a2b3c4d-0000-4000-8000-000000000000)
[2026-10-11 09:00] [#outreach] slack_message_sent: Quinn wrote back. (id: 7f7f7f7f-0000-4000-8000-000000000000)

Use read_history(item: <id>) to see full text of any activity.`,
});

describe("a person in the app's history", () => {
  test("each activity is its time, where it happened and the words around the name, without markup or ids", () => {
    const hits = readHistoryHits(ANSWER, "Quinn");
    // The app prints UTC with no zone: each hit is that instant, so a reader shows the hour the opened message says.
    expect(hits.map((h) => [h.at, h.where])).toEqual([["2026-10-12T22:39Z", "#outreach"], ["2026-10-12T14:28Z", "contact:995b6c3f"], ["2026-10-11T09:00Z", "#outreach"]]);
    expect(new Date(hits[0].at).getTime()).toBe(Date.UTC(2026, 9, 12, 22, 39));
    expect(hits[0].words).toContain("Hi Quinn, Wed Oct 14 works.");
    expect(hits[0].words).not.toContain("*");
    expect(hits[1].words).not.toContain("(id:");
    expect(hits[1].words.startsWith("Suggested brief")).toBe(true);
    expect(hits[0].words).not.toContain("slack_message_sent");
  });

  test("each activity keeps its own id, so it opens whole; the answer's closing hint is not part of the last one", () => {
    const hits = readHistoryHits(ANSWER, "Quinn");
    expect(hits.map((h) => h.id)).toEqual(["5da026f0-6b0f-4c97-9fad-297d5fbc06fd", "688e6ca9-3be5-4e8d-8119-b14976cb60e8", "7f7f7f7f-0000-4000-8000-000000000000"]);
    expect(hits[2].words).toBe("Quinn wrote back.");
  });

  test("an opened item is its full text, without the head, the repeated summary or the metadata", () => {
    const item = JSON.stringify({ text: "[2026-10-12 22:39] slack_message_sent (slack_channel/C0)\nSummary: #outreach | Aivery: New Email Reply\n*From:*\nPat Doe\n*Message:*\nHi Quinn,\n\nFull text:\nNew Email Reply\n*From:*\nPat Doe\n*Message:*\nHi Quinn,\n\nWed works.\n\n\nMetadata: {\"channel\":\"C0\"}" });
    expect(readHistoryItem(item)).toBe("New Email Reply\nFrom:\nPat Doe\nMessage:\nHi Quinn,\n\nWed works.");
    const flagged = JSON.stringify({ text: "[2026-10-12 14:28] difficulty_flagged (contact/995b6c3f)\nSummary: Suggested brief: \"Hi Sam, Quinn from Union.\"\n\nMetadata: {\"agentId\":\"broker\"}" });
    expect(readHistoryItem(flagged)).toBe('Suggested brief: "Hi Sam, Quinn from Union."');
  });

  test("nothing found is no hits", () => {
    expect(readHistoryHits(JSON.stringify({ text: 'No activities match "Zed".' }), "Zed")).toEqual([]);
  });
});
