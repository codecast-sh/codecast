import { describe, expect, test } from "bun:test";
import { buildPassages } from "../roomThreadModel";
import { passageHits } from "../ThreadFind";
import { termsOf } from "../CallSearch";

const seg = (seq: number, t0: number, text: string, speaker = "a") => ({
  seq,
  t0,
  t1: t0 + 1000,
  at: 1_000_000 + t0,
  speaker_id: speaker,
  speaker_name: speaker.toUpperCase(),
  text,
});

describe("call find", () => {
  // Two passages split by a long silence; only the second says "OAuth".
  const passages = buildPassages([
    seg(1, 0, "Let's look at the desk"),
    seg(2, 2000, "Sure"),
    seg(3, 60_000, "The OAuth access token is invalid", "b"),
  ]);

  test("opens only the passages whose words hold the query, case-insensitively", () => {
    expect(passages.length).toBe(2);
    expect([...passageHits(passages, "oauth")]).toEqual([1]);
    expect([...passageHits(passages, "  DESK ")]).toEqual([0]);
  });

  test("an empty query opens nothing", () => {
    expect(passageHits(passages, "   ").size).toBe(0);
  });

  test("a list query splits into lowercased terms", () => {
    expect(termsOf("  OAuth   Token ")).toEqual(["oauth", "token"]);
    expect(termsOf("")).toEqual([]);
  });
});
