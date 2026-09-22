import { describe, expect, test } from "bun:test";
import {
  addressesAgent,
  agentSpokenNames,
  formatTranscriptChunk,
  huddleFeedBriefing,
  liveFeedChunkHeader,
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
    const h = ownRoomChunkHeader({ name: "Ember", lane: "ask", held: false });
    expect(h).toContain("where you are Ember");
    expect(h).toContain("They named you, so answer");
    expect(h).not.toContain("waited while you worked");
    expect(h).toContain("cast call hold");
  });

  test("the context lane owes no reply and says what waited", () => {
    const h = ownRoomChunkHeader({ name: "Ember", lane: "context", held: true });
    expect(h).toContain("no reply is owed");
    expect(h).toContain("waited while you worked");
  });

  test("a feed from elsewhere says so and carries the same lanes", () => {
    const h = liveFeedChunkHeader({ name: "Pip", lane: "context", held: false });
    expect(h.startsWith("Huddle transcript (live). You are in the room as Pip.")).toBe(true);
    expect(h).toContain("no reply is owed");
  });

  test("the briefing tells a new session its name and how to ask for time", () => {
    const b = huddleFeedBriefing({ name: "Ember", label: "this huddle" });
    expect(b).toContain("In the room you are Ember");
    expect(b).toContain("this huddle");
    expect(b).toContain("cast call hold");
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
