import { describe, expect, test } from "bun:test";
import { recordingSpeakers, type WireCallSpeaker } from "@codecast/shared/contracts";
import { speakerPickerItems } from "../speakerPickerModel";

const people = [
  { _id: "u-ann", name: "Ann Lee" },
  { _id: "u-bob", name: "Bob Ray" },
];
const speakers: WireCallSpeaker[] = [
  { key: "spk:0", user_id: "u-ann", source: "person" },
  { key: "spk:1", name: "Dana", source: "person" },
  { key: "spk:2", source: "voice" },
];
const segments = [
  { seq: 1, speaker_id: "spk:0", speaker_name: "Speaker 1", t0: 0, t1: 1000 },
  { seq: 2, speaker_id: "spk:1", speaker_name: "Speaker 2", t0: 1000, t1: 2000 },
  { seq: 3, speaker_id: "spk:2", speaker_name: "Speaker 3", t0: 2000, t1: 3000 },
];
const chips = recordingSpeakers(segments, speakers, { "u-ann": "Ann Lee" });
const suggestedSpeakers: WireCallSpeaker[] = [...speakers.slice(0, 2), { key: "spk:2", user_id: "u-bob", source: "voice", score: 0.8 }];
const suggestedChips = recordingSpeakers(segments, suggestedSpeakers, { "u-ann": "Ann Lee", "u-bob": "Bob Ray" });

describe("speakerPickerItems", () => {
  test("teammates, then this recording's typed names, then Someone else and Unknown", () => {
    const items = speakerPickerItems({ target: { kind: "speaker", key: "spk:2" }, query: "", people, chips, speakers });
    expect(items.map((i) => i.id)).toEqual(["u:u-ann", "u:u-bob", "k:spk:1", "else", "unknown"]);
    expect(items.find((i) => i.id === "unknown")!.current).toBe(true);
    expect(items.find((i) => i.id === "else")!.choice).toBeNull();
  });

  test("the voice's own teammate is checked", () => {
    const items = speakerPickerItems({ target: { kind: "speaker", key: "spk:0" }, query: "", people, chips, speakers });
    expect(items.filter((i) => i.current).map((i) => i.id)).toEqual(["u:u-ann"]);
  });

  test("a suggested voice puts its confirm first, and its teammate is checked", () => {
    const items = speakerPickerItems({ target: { kind: "speaker", key: "spk:2" }, query: "", people, chips: suggestedChips, speakers: suggestedSpeakers });
    expect(items[0]).toMatchObject({ id: "yes", label: "Yes, it's Bob Ray", confirm: true });
    expect(items.filter((i) => i.current).map((i) => i.id)).toEqual(["u:u-bob"]);
    const typed = speakerPickerItems({ target: { kind: "speaker", key: "spk:2" }, query: "a", people, chips: suggestedChips, speakers: suggestedSpeakers });
    expect(typed.some((i) => i.id === "yes")).toBe(false);
    const line = speakerPickerItems({ target: { kind: "line", seq: 3, key: "spk:2" }, query: "", people, chips: suggestedChips, speakers: suggestedSpeakers });
    expect(line.some((i) => i.id === "yes")).toBe(false);
  });

  test("typing filters and turns Someone else into that name", () => {
    const items = speakerPickerItems({ target: { kind: "speaker", key: "spk:2" }, query: "bo", people, chips, speakers });
    expect(items.map((i) => i.id)).toEqual(["u:u-bob", "else", "unknown"]);
    expect(items.find((i) => i.id === "else")!.choice).toEqual({ name: "bo" });
  });

  test("a line's picker offers this recording's other voices by key; a teammate's voice is their team row", () => {
    const items = speakerPickerItems({ target: { kind: "line", seq: 3, key: "spk:2" }, query: "", people, chips, speakers });
    expect(items.filter((i) => i.section === "recording").map((i) => [i.choice, i.current])).toEqual([
      [{ key: "spk:1" }, false],
      [{ key: "spk:2" }, true],
    ]);
    const ann = speakerPickerItems({ target: { kind: "line", seq: 1, key: "spk:0" }, query: "", people, chips, speakers });
    expect(ann.filter((i) => i.current).map((i) => i.id)).toEqual(["u:u-ann"]);
  });
});
