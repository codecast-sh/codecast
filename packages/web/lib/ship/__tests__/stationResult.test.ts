import { describe, expect, test } from "bun:test";
import { leftWords, stationResult } from "../stationResult";

describe("stationResult", () => {
  test("reads a result that is the whole output", () => {
    expect(stationResult('{"outcome":"skipped","note":"No checks documented","results":[]}')).toEqual({ outcome: "skipped", note: "No checks documented", leftForYou: null });
  });

  test("reads the JSON a script's output leads with, when notes follow it", () => {
    expect(stationResult('{"outcome":"landed","sha":"4a6e413","note":"checkout caught up {at main}"}\nmain moved since the round: rebased')).toEqual({ outcome: "landed", note: "checkout caught up {at main}", leftForYou: null });
    expect(stationResult('{"outcome":"pass","note":"say \\"}\\" twice","results":[{"exit":0}]}\nnote')?.note).toBe('say "}" twice');
  });

  test("reads the first json fence inside prose", () => {
    const said = 'Read the README.\n```json\n{"outcome":"live","note":"4a6e413 serving","left_for_you":"Upload the build in App Store Connect"}\n```\n```json\n{"outcome":"failed"}\n```';
    expect(stationResult(said)).toEqual({ outcome: "live", note: "4a6e413 serving", leftForYou: "Upload the build in App Store Connect" });
  });

  test("an empty or null step left is no step left", () => {
    expect(stationResult('{"outcome":"live","left_for_you":null}')?.leftForYou).toBeNull();
    expect(stationResult('{"outcome":"live","left_for_you":"  "}')?.leftForYou).toBeNull();
  });

  test("any other output is no result: prose, JSON with neither an outcome nor a step left, broken JSON, an array", () => {
    for (const said of [null, "", "Ship it.", '{"sha":"4a6e413b2c","pr":12}', '{"next":"merge","ci":"green"}', '{"outcome":"skipped"', '[{"outcome":"skipped"}]', "```json\nnot json\n```"]) {
      expect(stationResult(said)).toBeNull();
    }
  });

  test("a step left reads in the person's words", () => {
    expect(leftWords("Upload the build")).toBe("One step left for you: Upload the build");
  });
});
