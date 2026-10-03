import { describe, expect, test } from "bun:test";
import { clusterAnchor, hash64, inputsHash, storyKey, type StoryInputs } from "./keys";

describe("keys", () => {
  test("hash64 is 16 hex chars and separates its parts", () => {
    expect(hash64(["a", "b"])).toMatch(/^[0-9a-f]{16}$/);
    expect(hash64(["ab", "c"])).not.toBe(hash64(["a", "bc"]));
  });

  test("hash64 lanes are independent: no collisions in either half over many near-identical anchors", () => {
    const n = 50_000;
    const keys = Array.from({ length: n }, (_, i) => hash64(["story", "t1", "codecast-sh/codecast", "2026-10-02", `main|cli||${i.toString(16).padStart(9, "0")}`]));
    expect(new Set(keys).size).toBe(n);
    // Bit 0 of FNV-1a is a parity of the input; the second lane must not echo it.
    const agree = keys.filter((k) => (parseInt(k.slice(0, 8), 16) & 1) === (parseInt(k.slice(8), 16) & 1)).length;
    expect(Math.abs(agree / n - 0.5)).toBeLessThan(0.02);
  });

  test("story keys depend on team, repo, date and anchor only", () => {
    const k = storyKey("t1", "codecast-sh/codecast", "2026-10-02", "jx7abcd");
    expect(k).toBe(storyKey("t1", "codecast-sh/codecast", "2026-10-02", "jx7abcd"));
    expect(k).not.toBe(storyKey("t2", "codecast-sh/codecast", "2026-10-02", "jx7abcd"));
    expect(k).not.toBe(storyKey("t1", "codecast-sh/codecast", "2026-10-01", "jx7abcd"));
    expect(clusterAnchor("main", "cli", null, "926be8efb")).toBe("main|cli||926be8efb");
  });

  test("inputs hash ignores order and moves on any prompt input", () => {
    const base: StoryInputs = {
      prompt_version: "v1",
      shas: ["a", "b"],
      insights: [{ id: "i1", generated_at: 10 }],
      visibility: [{ conversation_id: "c1", mode: "full" }],
      membership: [{ conversation_id: "c1", level: "full" }],
      prs: [{ id: "p1", updated_at: 5 }],
      risks: ["schema"],
    };
    const h = inputsHash(base);
    expect(inputsHash({ ...base, shas: ["b", "a"] })).toBe(h);
    expect(inputsHash({ ...base, prompt_version: "v2" })).not.toBe(h);
    expect(inputsHash({ ...base, insights: [{ id: "i1", generated_at: 11 }] })).not.toBe(h);
    expect(inputsHash({ ...base, visibility: [{ conversation_id: "c1", mode: "summary" }] })).not.toBe(h);
    expect(inputsHash({ ...base, membership: [{ conversation_id: "c1", level: "hidden" }] })).not.toBe(h);
    expect(inputsHash({ ...base, risks: [] })).not.toBe(h);
  });
});
