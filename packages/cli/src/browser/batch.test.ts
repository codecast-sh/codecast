/**
 * Batched steps.
 *
 * The tokenizer matters more than it looks: a step is a line of text an agent
 * wrote, and getting the quoting wrong silently types the wrong thing into
 * somebody's form rather than failing.
 */

import { describe, expect, test } from "bun:test";
import { runBatch, tokenize, type BatchContext } from "./batch.js";
import type { PageSession } from "./instance.js";

describe("tokenize", () => {
  test("splits on whitespace", () => {
    expect(tokenize("click #e42")).toEqual(["click", "#e42"]);
  });

  test("keeps a quoted string together", () => {
    // Without this, `type #e7 "hello world"` types "hello" and drops the rest.
    expect(tokenize('type #e7 "hello world"')).toEqual(["type", "#e7", "hello world"]);
  });

  test("handles single quotes", () => {
    expect(tokenize("find 'Sign in'")).toEqual(["find", "Sign in"]);
  });

  test("keeps flags after a quoted value", () => {
    expect(tokenize('type #e7 "a b" --submit')).toEqual(["type", "#e7", "a b", "--submit"]);
  });

  test("preserves an intentionally empty string", () => {
    // Clearing a field is `type #e7 ""` — dropping it would leave the old value.
    expect(tokenize('type #e7 ""')).toEqual(["type", "#e7", ""]);
  });

  test("allows an escaped quote inside a quoted value", () => {
    expect(tokenize('type #e1 "say \\"hi\\""')).toEqual(["type", "#e1", 'say "hi"']);
  });

  test("collapses runs of whitespace", () => {
    expect(tokenize("  click    #e1  ")).toEqual(["click", "#e1"]);
  });

  test("returns nothing for a blank line", () => {
    expect(tokenize("   ")).toEqual([]);
  });
});

/** A batch context whose steps are all satisfied by an in-memory fake page. */
function ctx(overrides: Partial<BatchContext> = {}): BatchContext {
  const page = {
    sessionId: "s",
    targetId: "t",
    // settle() asks for [readyState, mutationCount]; a page that never reports
    // "complete" would make every settling step wait out its timeout.
    conn: { send: async () => ({ result: { value: JSON.stringify(["complete", 0]) } }) },
  } as unknown as PageSession;
  return { page, shots: [], capture: async () => "/tmp/shot.png", navigate: async (u) => `went to ${u}`, ...overrides };
}

describe("runBatch", () => {
  test("runs the steps in order", async () => {
    const seen: string[] = [];
    const c = ctx({ navigate: async (u) => { seen.push(u); return u; } });
    const r = await runBatch(c, ["open a.test", "open b.test"]);
    expect(seen).toEqual(["a.test", "b.test"]);
    expect(r.every((x) => x.ok)).toBe(true);
  });

  test("stops at the first failure", async () => {
    // Later steps depend on earlier ones; running them anyway buries the real
    // error under consequential ones.
    const c = ctx();
    const r = await runBatch(c, ["open a.test", "bogus-verb", "open c.test"]);
    expect(r).toHaveLength(2);
    expect(r[1].ok).toBe(false);
    expect(r[1].error).toContain("unknown step");
  });

  test("--keep-going carries on past a failure", async () => {
    const c = ctx();
    const r = await runBatch(c, ["bogus", "open c.test"], { keepGoing: true });
    expect(r).toHaveLength(2);
    expect(r[0].ok).toBe(false);
    expect(r[1].ok).toBe(true);
  });

  test("skips blank lines and comments", async () => {
    const c = ctx();
    const r = await runBatch(c, ["", "# just a note", "open a.test"]);
    expect(r).toHaveLength(1);
    expect(r[0].step).toBe("open a.test");
  });

  test("reports which step failed, verbatim", async () => {
    // The agent wrote the line; echoing it back is what makes the error usable.
    const c = ctx();
    const r = await runBatch(c, ['click "not a ref"']);
    expect(r[0].step).toBe('click "not a ref"');
    expect(r[0].ok).toBe(false);
  });

  test("collects screenshots for the caller to attach", async () => {
    const c = ctx({ capture: async () => "/tmp/a.png" });
    await runBatch(c, ["shot"]);
    expect(c.shots).toEqual(["/tmp/a.png"]);
  });

  test("a step needing a ref says so instead of guessing one", async () => {
    const c = ctx();
    const r = await runBatch(c, ["click"]);
    expect(r[0].error).toMatch(/needs a ref/);
  });
});
