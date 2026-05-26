import { describe, expect, test } from "bun:test";
import { claudeModelAlias, resumeModelFlag } from "./daemon.js";

// Regression test for the recurring "There's an issue with the selected model
// (claude-opus-4-6-20260205) ... it may not exist" crash on resume (2026-05-25).
//
// Root cause: codecast reconstructs a JSONL when resuming a managed session, and
// that JSONL records whatever model the session last ran on -- frequently a
// pinned snapshot that gets RETIRED when a newer model ships. `claude --resume`
// then adopts the dead model and dies before the first turn. The fix overrides
// the recorded model with its non-pinned short alias (opus/sonnet/haiku) on EVERY
// resume, not just forks (the original gate is what let normal resumes crash).

const asst = (model: string) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", model, content: [{ type: "text", text: "hi" }] } });

describe("claudeModelAlias", () => {
  test("maps a retired opus snapshot to the opus line", () => {
    expect(claudeModelAlias(asst("claude-opus-4-6-20260205"))).toBe("opus");
  });

  test("preserves the line for sonnet/haiku sessions", () => {
    expect(claudeModelAlias(asst("claude-sonnet-4-6-20260205"))).toBe("sonnet");
    expect(claudeModelAlias(asst("claude-haiku-4-5-20251001"))).toBe("haiku");
  });

  test("returns null when no claude model line is present", () => {
    expect(claudeModelAlias(asst("gpt-4o"))).toBeNull();
    expect(claudeModelAlias("")).toBeNull();
  });
});

describe("resumeModelFlag", () => {
  test("rescues a normal (non-fork) resume off a retired snapshot", () => {
    // This is the exact bug: the gate used to be fork-only, so a plain resume of
    // a pre-4.7 session got no override and crashed.
    expect(resumeModelFlag(asst("claude-opus-4-6-20260205"), "")).toBe(" --model opus");
  });

  test("preserves the session's model line", () => {
    expect(resumeModelFlag(asst("claude-sonnet-4-6-20260205"), "")).toBe(" --model sonnet");
  });

  test("an explicit --model flag always wins", () => {
    expect(resumeModelFlag(asst("claude-opus-4-6-20260205"), "--model haiku")).toBe("");
    expect(resumeModelFlag(asst("claude-opus-4-6-20260205"), "--dangerously-skip-permissions --model=sonnet")).toBe("");
  });

  test("no override when the recorded model is unrecognized", () => {
    expect(resumeModelFlag(asst("gpt-4o"), "")).toBe("");
  });
});
