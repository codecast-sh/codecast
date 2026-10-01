import { describe, expect, test } from "bun:test";
import {
  addressesAgent,
  agentSpokenNames,
  formatTranscriptChunk,
  HUDDLE_PASS,
  huddleFeedBriefing,
  isHuddlePass,
  liveFeedChunkHeader,
  needsFullBrief,
  HUDDLE_REBRIEF_EVERY,
  ownRoomChunkHeader,
} from "./transcriptChunk";

describe("addressesAgent", () => {
  test("a whole word match on the character name, however it is cased", () => {
    expect(addressesAgent("ember, can you check the build", ["Ember"])).toBe(true);
    expect(addressesAgent("what does Ember think", ["Ember"])).toBe(true);
    expect(addressesAgent("EMBER", ["Ember"])).toBe(true);
  });

  test("a name inside another word is not the agent's name", () => {
    expect(addressesAgent("remember to ship it", ["Ember"])).toBe(false);
    expect(addressesAgent("the ashtray", ["Ash"])).toBe(false);
  });

  test("speech has no reliable punctuation, so none is required", () => {
    expect(addressesAgent("hey sage what do you think", ["Sage"])).toBe(true);
    expect(addressesAgent("okay Sage's turn", ["Sage"])).toBe(true);
  });

  test("any of several names counts; blanks are ignored", () => {
    expect(addressesAgent("Claude, summarize that", ["Ember", "Claude"])).toBe(true);
    expect(addressesAgent("nobody here", ["", "  "])).toBe(false);
    expect(addressesAgent("nobody here", [])).toBe(false);
  });
});

describe("agentSpokenNames", () => {
  test("the character name, then the brand said as a name", () => {
    expect(agentSpokenNames({ name: "Ember", agentType: "claude_code" })).toEqual(["Ember", "Claude"]);
    expect(agentSpokenNames({ name: "Pip", agentType: "codex" })).toEqual(["Pip", "Codex"]);
  });

  test("no brand when the agent type is unknown; no duplicate when the name is the brand", () => {
    expect(agentSpokenNames({ name: "Ember" })).toEqual(["Ember"]);
    expect(agentSpokenNames({ name: "claude", agentType: "claude_code" })).toEqual(["claude"]);
  });
});

describe("chunk headers", () => {
  test("the ask lane names the agent and expects an answer", () => {
    const h = ownRoomChunkHeader({ name: "Ember", lane: "ask", held: false, full: true });
    expect(h).toContain("where you are Ember");
    expect(h).toContain("They named you, so answer");
    expect(h).not.toContain("waited while you worked");
    expect(h).toContain("cast call hold");
  });

  test("the context lane owes no reply and says what waited", () => {
    const h = ownRoomChunkHeader({ name: "Ember", lane: "context", held: true, full: true });
    expect(h).toContain("no reply is owed");
    expect(h).toContain("waited while you worked");
  });

  test("a feed from elsewhere says so and carries the same lanes", () => {
    const h = liveFeedChunkHeader({ name: "Pip", lane: "context", held: false, full: true });
    expect(h.startsWith("Huddle transcript (live). You are in the room as Pip.")).toBe(true);
    expect(h).toContain("no reply is owed");
  });

  test("the briefing tells a new session its name and how to ask for time", () => {
    const b = huddleFeedBriefing({ name: "Ember", label: "this huddle" });
    expect(b).toContain("In the room you are Ember");
    expect(b).toContain("this huddle");
    expect(b).toContain("cast call hold");
  });

  test("every feed offers the pass, since a turn cannot end without words", () => {
    for (const h of [
      ownRoomChunkHeader({ name: "Ember", lane: "context", held: false, full: true }),
      ownRoomChunkHeader({ name: "Ember", lane: "ask", held: false, full: true }),
      liveFeedChunkHeader({ name: "Pip", lane: "context", held: false, full: true }),
      huddleFeedBriefing({ name: "Ember", label: "this huddle" }),
    ]) {
      expect(h).toContain(`end the turn with exactly ${HUDDLE_PASS}`);
    }
  });
});

describe("full brief cadence", () => {
  test("the first chunk and every Nth after it carry the full framing", () => {
    expect(needsFullBrief(undefined)).toBe(true);
    expect(needsFullBrief(1)).toBe(false);
    expect(needsFullBrief(HUDDLE_REBRIEF_EVERY - 1)).toBe(false);
    expect(needsFullBrief(HUDDLE_REBRIEF_EVERY)).toBe(true);
  });

  test("a short header is one line that still names the agent, the lane and the pass", () => {
    const ctx = liveFeedChunkHeader({ name: "Pip", lane: "context", held: true, full: false });
    expect(ctx).not.toContain("\n");
    expect(ctx).toContain("you are Pip");
    expect(ctx).toContain(HUDDLE_PASS);
    expect(ctx).toContain("waited while you worked");
    const ask = ownRoomChunkHeader({ name: "Ember", lane: "ask", held: false, full: false });
    expect(ask).toContain("you are Ember");
    expect(ask).toContain("They named you");
    expect(ask).not.toContain("cast call hold");
  });
});

describe("isHuddlePass", () => {
  test("the pass alone, however it is cased or padded, and nothing else", () => {
    expect(isHuddlePass("[pass]")).toBe(true);
    expect(isHuddlePass("  [PASS]\n")).toBe(true);
    expect(isHuddlePass("Listening.")).toBe(false);
    expect(isHuddlePass("[pass] but also, the build is red")).toBe(false);
    expect(isHuddlePass("")).toBe(false);
    expect(isHuddlePass(null)).toBe(false);
  });
});

describe("formatTranscriptChunk", () => {
  test("consecutive lines from one speaker fold into one", () => {
    expect(
      formatTranscriptChunk([
        { speaker_name: "Ada", text: "one." },
        { speaker_name: "Ada", text: "two." },
        { speaker_name: "Bob", text: "three." },
      ]),
    ).toBe("**Ada**: one. two.\n**Bob**: three.");
  });
});
