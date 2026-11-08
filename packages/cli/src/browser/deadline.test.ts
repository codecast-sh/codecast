/**
 * One budget per `cast browser` verb: when it runs out the verb names the
 * stage it was stuck in and exits 124, instead of agents wrapping every call
 * in `timeout` and reading a bare exit status.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { armVerbDeadline, deadlineHint, deadlineSeconds, DEFAULT_DEADLINE_S, disarmVerbDeadline, remainingMs, setStage } from "./deadline.js";

afterEach(() => disarmVerbDeadline());

describe("deadlineSeconds", () => {
  test("the flag wins over the environment, which wins over the default", () => {
    expect(deadlineSeconds(undefined, {})).toBe(DEFAULT_DEADLINE_S);
    expect(deadlineSeconds(undefined, { CAST_BROWSER_DEADLINE: "30" })).toBe(30);
    expect(deadlineSeconds("200", { CAST_BROWSER_DEADLINE: "30" })).toBe(200);
    expect(deadlineSeconds("0", {})).toBe(0);
    expect(deadlineSeconds("abc", {})).toBeNull();
  });
});

describe("armVerbDeadline", () => {
  test("bounds a direct verb; waits that are the point of a verb get no budget", () => {
    armVerbDeadline("open", 60);
    expect(remainingMs()).toBeGreaterThan(59_000);
    armVerbDeadline("wait", 60);
    expect(remainingMs()).toBeUndefined();
    armVerbDeadline("open", 0);
    expect(remainingMs()).toBeUndefined();
  });

  test("when the budget runs out it names the stage and exits 124", async () => {
    const lines: string[] = [];
    const exit = process.exit;
    let code: number | undefined;
    process.exit = ((c?: number) => { code = c; }) as typeof process.exit;
    try {
      armVerbDeadline("open", 0.05, (l) => lines.push(l));
      setStage("connecting to the human's Chrome through the extension");
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      process.exit = exit;
    }
    expect(code).toBe(124);
    expect(lines[0]).toContain("cast browser open gave up after 0.05s while connecting to the human's Chrome through the extension");
    expect(lines[1]).toContain("cast browser extension status");
  });
});

describe("deadlineHint", () => {
  test("points at the stage's own recovery", () => {
    expect(deadlineHint("opening https://x.test in Chrome (attach, navigate, load)", 90)).toContain("never finished loading");
    expect(deadlineHint("waiting for the browser engine (`snapshot`)", 90)).toContain("--deadline 180");
  });
});
