import { describe, expect, test } from "bun:test";
import {
  hasVoiceSpeakers,
  moveLineTarget,
  recordingSpeakers,
  shareLabel,
  speakerColorIndex,
  speakerNameMatches,
  speakerTurns,
} from "./speakerTurns";

const line = (seq: number, speaker_id: string, t0: number, t1: number) => ({
  seq,
  speaker_id,
  speaker_name: speaker_id.startsWith("spk:") ? `Speaker ${Number(speaker_id.slice(4)) + 1}` : "Ada",
  t0,
  t1,
  text: `line ${seq}`,
});

const segments = [
  line(1, "spk:1", 0, 3000),
  line(2, "spk:1", 3000, 4000),
  line(3, "spk:0", 4000, 8000),
  line(4, "spk:2", 8000, 10000),
  line(5, "spk:1", 10000, 12000),
];
const speakers = [
  { key: "spk:0", user_id: "u_ada", source: "person" as const },
  { key: "spk:1", user_id: "u_bo", source: "voice" as const, score: 0.81 },
  { key: "spk:2", source: "voice" as const },
];
const roster = { u_ada: "Ada Lovelace", u_bo: "Bo Diddley" };

describe("recordingSpeakers", () => {
  test("voices in order of first line, named, with talk share", () => {
    const chips = recordingSpeakers(segments, speakers, roster);
    expect(chips.map((c) => [c.key, c.name, c.suggested, c.lines])).toEqual([
      ["spk:1", "Bo Diddley", true, 3],
      ["spk:0", "Ada Lovelace", false, 1],
      ["spk:2", "Speaker 3", false, 1],
    ]);
    expect(chips.map((c) => Math.round(c.share * 100))).toEqual([50, 33, 17]);
  });

  test("a voice with no lines left has no chip; huddle lines are not voices", () => {
    const chips = recordingSpeakers([line(1, "spk:0", 0, 1000), line(2, "u_x", 1000, 2000)], speakers, roster);
    expect(chips.map((c) => c.key)).toEqual(["spk:0"]);
    expect(chips[0]!.share).toBe(1);
  });

  test("zero-length lines split the share evenly", () => {
    const chips = recordingSpeakers([line(1, "spk:0", 0, 0), line(2, "spk:1", 0, 0)], [], {});
    expect(chips.map((c) => c.share)).toEqual([0.5, 0.5]);
  });
});

test("hasVoiceSpeakers: only diarized recordings get a speaker row", () => {
  expect(hasVoiceSpeakers(segments)).toBe(true);
  expect(hasVoiceSpeakers([{ speaker_id: "mic" }, { speaker_id: "u_1" }])).toBe(false);
  expect(hasVoiceSpeakers(undefined)).toBe(false);
});

test("shareLabel never says 0% for a voice that spoke", () => {
  expect(shareLabel(0.424)).toBe("42%");
  expect(shareLabel(0.001)).toBe("<1%");
  expect(shareLabel(0)).toBe("0%");
});

test("speakerTurns groups consecutive lines of one speaker", () => {
  expect(speakerTurns(segments).map((t) => [t.key, t.lines.map((l) => l.seq)])).toEqual([
    ["spk:1", [1, 2]],
    ["spk:0", [3]],
    ["spk:2", [4]],
    ["spk:1", [5]],
  ]);
});

test("speakerColorIndex: spk:n takes the nth color; other ids hash stably", () => {
  expect([0, 1, 2, 6, 7].map((n) => speakerColorIndex(`spk:${n}`, 6))).toEqual([0, 1, 2, 0, 1]);
  const a = speakerColorIndex("u_abc", 6);
  expect(a).toBe(speakerColorIndex("u_abc", 6));
  expect(a).toBeGreaterThanOrEqual(0);
  expect(a).toBeLessThan(6);
});

test("speakerNameMatches", () => {
  expect(speakerNameMatches("Ada Lovelace", "love")).toBe(true);
  expect(speakerNameMatches("Ada Lovelace", " ")).toBe(true);
  expect(speakerNameMatches(undefined, "x")).toBe(false);
});

describe("moveLineTarget", () => {
  test("a voice of the recording is that key", () => {
    expect(moveLineTarget(speakers, { key: "spk:2" })).toEqual({ key: "spk:2" });
  });
  test("a teammate some voice already is joins that voice", () => {
    expect(moveLineTarget(speakers, { user_id: "u_ada" })).toEqual({ key: "spk:0" });
  });
  test("a teammate no voice is becomes a new, named voice", () => {
    expect(moveLineTarget(speakers, { user_id: "u_cy" })).toEqual({ key: "spk:3", assign: { user_id: "u_cy" } });
  });
  test("a typed name matches an existing typed voice case-insensitively", () => {
    const withGuest = [...speakers, { key: "spk:3", name: "Guest Gail", source: "person" as const }];
    expect(moveLineTarget(withGuest, { name: " guest gail" })).toEqual({ key: "spk:3" });
    expect(moveLineTarget(withGuest, { name: "Hal" })).toEqual({ key: "spk:4", assign: { name: "Hal" } });
  });
  test("Unknown is a new unnamed voice", () => {
    expect(moveLineTarget(speakers, { clear: true })).toEqual({ key: "spk:3" });
  });
});
