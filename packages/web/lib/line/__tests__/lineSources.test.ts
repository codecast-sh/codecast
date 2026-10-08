import { describe, expect, test } from "bun:test";
import { groupingWords, sourceCounts, sourceHealth, sourceSentence, watchesFor } from "../lineSources";

const NOW = 1_790_000_000_000;
const H = 3_600_000;
const sig = (ago: number) => ({ _id: "s", source: "x", kind: "bug", title: "t", observed_at: NOW - ago, created_at: NOW - ago, task_id: "t" });

describe("a source in words", () => {
  test("what it watches for", () => {
    expect(watchesFor("any")).toBe("anything worth fixing");
    expect(watchesFor(["bug", "regression", "prompt_miss"])).toBe("bugs, regressions and agents not doing what they should");
  });
  test("its one sentence", () => {
    expect(sourceSentence("agentwatch", { kind: ["prompt_miss"], fingerprint: "aw:<cluster>" })).toBe("agentwatch reports agents not doing what they should, and groups reports that share an Aw cluster into one problem.");
    expect(sourceSentence("person", undefined, ["bug"])).toBe("People on the team report bugs.");
  });
  test("healthy, quiet, or nothing yet", () => {
    expect(sourceHealth({ newest: sig(2 * H), silent: false, day: 3 }, NOW)).toEqual({ tone: "ok", words: "healthy, 3 today" });
    expect(sourceHealth({ newest: sig(50 * H), silent: true, day: 0 }, NOW)).toEqual({ tone: "quiet", words: "quiet for 2d" });
    expect(sourceHealth({ newest: null, silent: false, day: 0 }, NOW).tone).toBe("new");
  });
  test("how much it reported", () => {
    expect(sourceCounts({ week: 209, newest: sig(2 * H) }, NOW)).toBe("Reported 209 in the last 7 days; the last 2h ago");
    expect(sourceCounts({ week: 0, newest: null }, NOW)).toBe("Nothing reported yet");
  });
  test("grouping", () => expect(groupingWords("union:<key>")).toBe("groups reports that share a Union key"));
});
