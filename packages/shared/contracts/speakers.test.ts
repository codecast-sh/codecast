import { describe, expect, test } from "bun:test";
import parity from "./__fixtures__/wordsToLines.parity.json";
import {
  assignedSpeaker,
  callSpeakerRoster,
  confirmedSpeaker,
  nextSpeakerKey,
  resolveLineSpeaker,
  speakerIndex,
  speakerKey,
  speakerLabel,
  withSpeaker,
  wireSpeaker,
  wordsToLines,
  type WireCallSpeaker,
} from "./speakers";

describe("speaker keys", () => {
  test("key, index and label", () => {
    expect(speakerKey(0)).toBe("spk:0");
    expect(speakerIndex("spk:3")).toBe(3);
    expect(speakerIndex("mic")).toBeNull();
    expect(speakerLabel("spk:0")).toBe("Speaker 1");
    expect(speakerLabel("spk:11")).toBe("Speaker 12");
    expect(speakerLabel("mic")).toBe("mic");
  });

  test("next key is one past the highest cluster", () => {
    expect(nextSpeakerKey(undefined)).toBe("spk:0");
    expect(nextSpeakerKey([{ key: "spk:0" }, { key: "spk:4" }, { key: "spk:2" }])).toBe("spk:5");
  });
});

describe("resolveLineSpeaker", () => {
  const roster = { u1: "Ada", u2: "Grace" };
  const speakers: WireCallSpeaker[] = [
    { key: "spk:0", user_id: "u1", source: "person" },
    { key: "spk:1", user_id: "u2", source: "voice", score: 0.71 },
    { key: "spk:2", name: "Visitor Bob", source: "person" },
    { key: "spk:3", source: "voice" },
  ];
  const line = (speaker_id: string, speaker_name = "Speaker ?") => ({ speaker_id, speaker_name });

  test("an assigned teammate is named from the roster", () => {
    expect(resolveLineSpeaker(line("spk:0"), speakers, roster)).toEqual({
      key: "spk:0", name: "Ada", user_id: "u1", source: "person", suggested: false,
    });
  });

  test("a voice suggestion is marked suggested", () => {
    const r = resolveLineSpeaker(line("spk:1"), speakers, roster);
    expect(r.name).toBe("Grace");
    expect(r.suggested).toBe(true);
  });

  test("a typed name, an unknown voice and a missing entry", () => {
    expect(resolveLineSpeaker(line("spk:2"), speakers, roster).name).toBe("Visitor Bob");
    const unknown = resolveLineSpeaker(line("spk:3"), speakers, roster);
    expect(unknown).toEqual({ key: "spk:3", name: "Speaker 4", source: "voice", suggested: false });
    expect(resolveLineSpeaker(line("spk:9"), speakers, roster)).toEqual({ key: "spk:9", name: "Speaker 10", suggested: false });
  });

  test("a teammate missing from the roster falls back to the label", () => {
    expect(resolveLineSpeaker(line("spk:0"), speakers, {}).name).toBe("Speaker 1");
  });

  test("a suggestion whose person has no resolvable name offers no confirm", () => {
    const r = resolveLineSpeaker(line("spk:1"), speakers, {});
    expect(r).toEqual({ key: "spk:1", name: "Speaker 2", user_id: "u2", source: "voice", suggested: false });
  });

  test("huddle and legacy recording lines keep their written name", () => {
    expect(resolveLineSpeaker(line("mic", "Me"), speakers, roster)).toEqual({ key: "mic", name: "Me", suggested: false });
    expect(resolveLineSpeaker(line("u1", "Ada L"), speakers, roster).name).toBe("Ada L");
  });
});

describe("callSpeakerRoster", () => {
  test("server names win over team members; names only, no emails", () => {
    const roster = callSpeakerRoster(
      { speaker_names: { u1: "Ann Server" } },
      [{ _id: "u1", name: "Ann Local" }, { _id: "u2", name: "Bob" }, { user_id: "u3", name: null }, null],
    );
    expect(roster).toEqual({ u1: "Ann Server", u2: "Bob" });
    expect(callSpeakerRoster(undefined, undefined)).toEqual({});
    expect(callSpeakerRoster({ speaker_names: { u9: "Zed" } }, [])).toEqual({ u9: "Zed" });
  });
});

describe("speaker entry writes", () => {
  test("assign, clear and confirm build the canonical wire shape", () => {
    expect(JSON.stringify(assignedSpeaker("spk:1", { user_id: "u1" }))).toBe('{"key":"spk:1","user_id":"u1","source":"person"}');
    expect(assignedSpeaker("spk:1", { name: "Bob" })).toEqual({ key: "spk:1", name: "Bob", source: "person" });
    expect(assignedSpeaker("spk:1", { clear: true })).toEqual({ key: "spk:1", source: "person" });
    expect(confirmedSpeaker({ key: "spk:1", user_id: "u2", source: "voice", score: 0.8 })).toEqual({ key: "spk:1", user_id: "u2", source: "person" });
    expect(confirmedSpeaker({ key: "spk:1", source: "voice" })).toBeNull();
    expect(confirmedSpeaker({ key: "spk:1", user_id: "u2", source: "person" })).toBeNull();
    expect(confirmedSpeaker(undefined)).toBeNull();
  });

  test("wire shape drops server-only fields and orders keys", () => {
    const stored = { score: 0.5, source: "voice" as const, user_id: "u1", key: "spk:0", by: "u9", at: 5 };
    expect(JSON.stringify(wireSpeaker(stored))).toBe('{"key":"spk:0","user_id":"u1","source":"voice","score":0.5}');
  });

  test("withSpeaker replaces by key or appends", () => {
    const list: WireCallSpeaker[] = [{ key: "spk:0", source: "voice" }];
    expect(withSpeaker(list, { key: "spk:0", name: "A", source: "person" })).toEqual([{ key: "spk:0", name: "A", source: "person" }]);
    expect(withSpeaker(list, { key: "spk:1", source: "person" })).toHaveLength(2);
  });
});

describe("wordsToLines", () => {
  test("matches the speech lab's words_to_lines and words_to_lines_activity on the parity fixture", () => {
    expect(parity.cases.filter((c: any) => c.activity).length).toBeGreaterThan(0);
    for (const c of parity.cases as any[]) {
      const words = c.words.map(([text, start, end]: any[]) => ({ text: String(text), start: Number(start), end: Number(end) }));
      const turns = c.turns.map((t: any) => ({ key: t.speaker, start: t.start, end: t.end }));
      const got = wordsToLines(words, turns, { gap: c.gap, activity: c.activity, floor: c.floor });
      const want = c.lines.map((l: any) => ({
        key: l.speaker,
        start: l.start,
        end: l.end,
        text: l.text,
        words: l.words.map(([text, start, end]: any[]) => ({ text: String(text), start: Number(start), end: Number(end) })),
      }));
      expect(got).toEqual(want);
    }
  });

  test("activity: the most active voice wins, quiet keeps the previous voice", () => {
    const activity = { hop_s: 0.5, labels: { "spk:0": [0.9, 0.9, 0.1, 0.1, 0.1, 0.1], "spk:1": [0.1, 0.1, 0.1, 0.1, 0.8, 0.8] } };
    const lines = wordsToLines(
      [{ text: "a", start: 0, end: 0.4 }, { text: "b", start: 1.1, end: 1.4 }, { text: "c", start: 2.1, end: 2.4 }],
      [],
      { activity },
    );
    expect(lines.map((l) => [l.key, l.text])).toEqual([["spk:0", "a b"], ["spk:1", "c"]]);
  });

  test("a speaker change or a long gap splits a line", () => {
    const lines = wordsToLines(
      [
        { text: "a", start: 0, end: 0.2 },
        { text: "b", start: 0.3, end: 0.5 },
        { text: "c", start: 0.6, end: 0.8 },
        { text: "d", start: 3, end: 3.2 },
      ],
      [{ key: "spk:0", start: 0, end: 0.55 }, { key: "spk:1", start: 0.55, end: 4 }],
    );
    expect(lines.map((l) => [l.key, l.text])).toEqual([["spk:0", "a b"], ["spk:1", "c"], ["spk:1", "d"]]);
  });
});
