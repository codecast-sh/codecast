import { describe, expect, test } from "bun:test";
import {
  PASSAGE_MAX_MS,
  PASSAGE_PREVIEW_CHARS,
  PASSAGE_SILENCE_MS,
  buildPassages,
  countWords,
  flatTurns,
  isEventRow,
  mergeTimeline,
  type ThreadRow,
  type TranscriptSegment,
} from "../roomThreadModel";
import { groupTurns } from "../transcriptTurnModel";

// Wall clock runs from a fixed start; each segment's `at` is start + t0 so
// the two clocks line up unless a test says otherwise.
const START = 1_700_000_000_000;

function seg(
  seq: number,
  speaker: string,
  text: string,
  t0: number,
  t1: number = t0 + 2000,
  at: number = START + t0,
): TranscriptSegment {
  return { seq, speaker_id: speaker.toLowerCase(), speaker_name: speaker, text, t0, t1, at };
}

function row(at: number, extra: Partial<ThreadRow> = {}): ThreadRow {
  return {
    _id: `r${at}`,
    user_id: "u1",
    user_name: "Ashot",
    text: "hi",
    at,
    mine: false,
    agent: null,
    ...extra,
  };
}

describe("buildPassages", () => {
  test("empty input yields no passages", () => {
    expect(buildPassages([])).toEqual([]);
    expect(flatTurns([])).toEqual([]);
    expect(mergeTimeline([], [])).toEqual([]);
  });

  test("consecutive speech stays in one passage", () => {
    const segs = [seg(0, "Ada", "hello there", 0), seg(1, "Bob", "hi", 3000), seg(2, "Ada", "how are you", 6000)];
    const ps = buildPassages(segs);
    expect(ps).toHaveLength(1);
    expect(ps[0].index).toBe(0);
    expect(ps[0].t0).toBe(0);
    expect(ps[0].t1).toBe(8000);
    expect(ps[0].at).toBe(START);
    expect(ps[0].speakers).toEqual([
      { id: "ada", name: "Ada" },
      { id: "bob", name: "Bob" },
    ]);
    expect(ps[0].turns.map((t) => t.index)).toEqual([0, 1, 2]);
    expect(ps[0].wordCount).toBe(6);
    expect(ps[0].preview).toBe("Ada: hello there · Bob: hi · Ada: how are you");
  });

  test("a silence of PASSAGE_SILENCE_MS or more starts a new passage", () => {
    const segs = [
      seg(0, "Ada", "one", 0, 2000),
      seg(1, "Ada", "two", 2000 + PASSAGE_SILENCE_MS - 1, 2000 + PASSAGE_SILENCE_MS + 1000),
      seg(2, "Ada", "three", 2000 + PASSAGE_SILENCE_MS + 1000 + PASSAGE_SILENCE_MS),
    ];
    const ps = buildPassages(segs);
    expect(ps.map((p) => p.segments.map((s) => s.seq))).toEqual([[0, 1], [2]]);
  });

  test("silence is measured from the previous t1, and falls back to t0 when t1 is missing", () => {
    const open = { ...seg(0, "Ada", "one", 0), t1: undefined };
    const ps = buildPassages([open, seg(1, "Ada", "two", PASSAGE_SILENCE_MS)]);
    expect(ps).toHaveLength(2);
  });

  test("a passage never runs past PASSAGE_MAX_MS from its first t0", () => {
    const segs: TranscriptSegment[] = [];
    // A segment every 10 s, each 2 s long: the one at 120 s would end past the cap.
    for (let i = 0; i < 20; i++) segs.push(seg(i, "Ada", `w${i}`, i * 10_000));
    const ps = buildPassages(segs);
    expect(ps).toHaveLength(2);
    expect(ps[0].segments).toHaveLength(12);
    expect(ps[0].t1).toBe(112_000);
    expect(ps[0].t1 - ps[0].t0).toBeLessThanOrEqual(PASSAGE_MAX_MS);
    expect(ps[1].t0).toBe(120_000);
    expect(ps[1].index).toBe(1);
  });

  test("a wall clock breakpoint between two segments splits them", () => {
    const segs = [seg(0, "Ada", "one", 0), seg(1, "Ada", "two", 3000), seg(2, "Ada", "three", 6000)];
    const typedAt = START + 4000;
    const ps = buildPassages(segs, [typedAt]);
    expect(ps.map((p) => p.segments.map((s) => s.seq))).toEqual([[0, 1], [2]]);
    expect(ps[1].at).toBe(START + 6000);
  });

  test("breakpoints outside the run and several between two segments split once", () => {
    const segs = [seg(0, "Ada", "one", 0), seg(1, "Ada", "two", 3000)];
    const ps = buildPassages(segs, [START - 10, START + 1000, START + 2000, START + 9000]);
    expect(ps).toHaveLength(2);
    expect(buildPassages(segs, [START - 10, START + 9000])).toHaveLength(1);
  });

  test("a breakpoint at a segment's own instant splits before that segment; at the previous one's it does not", () => {
    const segs = [seg(0, "Ada", "one", 0), seg(1, "Ada", "two", 3000)];
    expect(buildPassages(segs, [START + 3000])).toHaveLength(2);
    expect(buildPassages(segs, [START])).toHaveLength(1);
  });

  test("unsorted breakpoints and segments are handled", () => {
    const segs = [seg(1, "Ada", "two", 3000), seg(0, "Ada", "one", 0), seg(2, "Ada", "three", 6000)];
    const ps = buildPassages(segs, [START + 4000, START + 1000]);
    expect(ps.map((p) => p.segments.map((s) => s.seq))).toEqual([[0], [1], [2]]);
  });

  test("turn indices are global and the flat list matches the page's selection model", () => {
    // Ada keeps talking across a typed line: one speaker run split in two
    // passages yields two turns where a flat groupTurns would yield one.
    const segs = [
      seg(0, "Ada", "a", 0),
      seg(1, "Ada", "b", 3000),
      seg(2, "Bob", "c", 6000),
      seg(3, "Ada", "d", 9000),
    ];
    const ps = buildPassages(segs, [START + 1000]);
    expect(ps).toHaveLength(2);
    expect(ps[0].turns.map((t) => t.index)).toEqual([0]);
    expect(ps[1].turns.map((t) => t.index)).toEqual([1, 2, 3]);
    const flat = flatTurns(ps);
    expect(flat.map((t) => t.index)).toEqual([0, 1, 2, 3]);
    expect(flat[1].speaker_id).toBe("ada");
    expect(flat.slice(1, 3).flatMap((t) => t.segments).map((s) => s.seq)).toEqual([1, 2]);
    // Without a split the model agrees with groupTurns exactly.
    expect(flatTurns(buildPassages(segs))).toEqual(groupTurns(segs));
  });

  test("speakers list is unique in order of first appearance", () => {
    const segs = [seg(0, "Bob", "x", 0), seg(1, "Ada", "y", 2000), seg(2, "Bob", "z", 4000), seg(3, "Cy", "w", 6000)];
    expect(buildPassages(segs)[0].speakers.map((s) => s.name)).toEqual(["Bob", "Ada", "Cy"]);
  });

  test("preview clamps to PASSAGE_PREVIEW_CHARS with an ellipsis and skips empty lines", () => {
    const long = "word ".repeat(60).trim();
    const ps = buildPassages([seg(0, "Ada Lovelace", "", 0), seg(1, "Bob", long, 2000), seg(2, "Ada", "tail", 4000)]);
    const p = ps[0].preview;
    expect(p.length).toBeLessThanOrEqual(PASSAGE_PREVIEW_CHARS);
    expect(p.endsWith("…")).toBe(true);
    expect(p.startsWith("Bob: word word")).toBe(true);
    expect(p).not.toContain("Ada Lovelace:");
    // Short content is untouched and uses first names.
    expect(buildPassages([seg(0, "Ada Lovelace", "hi all", 0)])[0].preview).toBe("Ada: hi all");
  });

  test("word count ignores blank and repeated whitespace", () => {
    expect(countWords("  one   two\nthree ")).toBe(3);
    expect(countWords("   ")).toBe(0);
    const ps = buildPassages([seg(0, "Ada", "  a  b ", 0), seg(1, "Ada", "", 2000)]);
    expect(ps[0].wordCount).toBe(2);
  });

  test("recording mode splits by time only and keeps one segment per turn", () => {
    const segs = [seg(0, "Mic", "one", 0), seg(1, "Mic", "two", 3000), seg(2, "Mic", "three", 3000 + 2000 + PASSAGE_SILENCE_MS)];
    const ps = buildPassages(segs, [START + 1000], { recording: true });
    expect(ps.map((p) => p.segments.map((s) => s.seq))).toEqual([[0, 1], [2]]);
    expect(ps[0].turns.map((t) => t.index)).toEqual([0, 1]);
    expect(ps[1].turns.map((t) => t.index)).toEqual([2]);
    expect(flatTurns(ps).every((t) => t.segments.length === 1)).toBe(true);
    // The huddle grouping folds the same run into a single turn.
    expect(buildPassages(segs)[0].turns).toHaveLength(1);
  });
});

describe("mergeTimeline", () => {
  test("interleaves passages, chat rows and event rows by wall clock", () => {
    const segs = [seg(0, "Ada", "one", 0), seg(1, "Ada", "two", 3000), seg(2, "Ada", "three", 30_000)];
    const typed = row(START + 10_000);
    const joined = row(START + 20_000, { event: "agent_joined", text: "" });
    const ps = buildPassages(segs, [typed.at, joined.at]);
    const items = mergeTimeline(ps, [joined, typed]);
    expect(items.map((i) => i.kind)).toEqual(["passage", "chat", "event", "passage"]);
    expect(items[1].kind === "chat" && items[1].row._id).toBe(typed._id);
    expect(items[2].kind === "event" && items[2].row.event).toBe("agent_joined");
    expect(items[3].kind === "passage" && items[3].index).toBe(1);
  });

  test("a row at a passage's instant reads before the passage; equal rows keep input order", () => {
    const ps = buildPassages([seg(0, "Ada", "one", 0)]);
    const a = row(START, { _id: "a" });
    const b = row(START, { _id: "b" });
    const items = mergeTimeline(ps, [a, b]);
    expect(items.map((i) => (i.kind === "passage" ? "passage" : i.row._id))).toEqual(["a", "b", "passage"]);
  });

  test("isEventRow tells event rows from chat rows", () => {
    expect(isEventRow(row(1))).toBe(false);
    expect(isEventRow(row(1, { event: null }))).toBe(false);
    expect(isEventRow(row(1, { event: "transcribe_off", text: "" }))).toBe(true);
  });
});
