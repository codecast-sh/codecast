import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  claudeModelAlias,
  claudeTranscriptModel,
  resumeModelFlag,
  resumeModelFlagFromFile,
} from "./jsonlGenerator.js";

// Regression test for the recurring "There's an issue with the selected model
// (claude-opus-4-6-20260205) ... it may not exist" crash on resume (2026-05-25).
//
// Root cause: codecast reconstructs a JSONL when resuming a managed session, and
// that JSONL records whatever model the session last ran on -- frequently a
// pinned snapshot that gets RETIRED when a newer model ships. `claude --resume`
// then adopts the dead model and dies before the first turn. The fix overrides
// the recorded model with its non-pinned short alias (opus/sonnet/haiku) on EVERY
// resume, not just forks (the original gate is what let normal resumes crash).
//
// Second incident (2026-06-09): the daemon fed the override only the first 5KB
// of the JSONL. The model field first appears on the first ASSISTANT line, which
// sat at byte ~17K behind several long user messages — the override silently
// no-oped and the resume crashed on the dead snapshot anyway. The daemon now
// scans the file itself (resumeModelFlagFromFile), and the generator stamps a
// never-stale alias instead of a pinned snapshot when the conversation has no
// usable Claude model (claudeTranscriptModel).

const asst = (model: string) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", model, content: [{ type: "text", text: "hi" }] } });

const user = (content: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content } });

describe("claudeModelAlias", () => {
  test("maps a retired opus snapshot to the opus line", () => {
    expect(claudeModelAlias(asst("claude-opus-4-6-20260205"))).toBe("opus");
  });

  test("preserves the line for sonnet/haiku sessions", () => {
    expect(claudeModelAlias(asst("claude-sonnet-4-6-20260205"))).toBe("sonnet");
    expect(claudeModelAlias(asst("claude-haiku-4-5-20251001"))).toBe("haiku");
  });

  test("recognizes a bare recorded alias", () => {
    expect(claudeModelAlias(asst("opus"))).toBe("opus");
    expect(claudeModelAlias(asst("sonnet"))).toBe("sonnet");
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

describe("resumeModelFlagFromFile", () => {
  const writeTmpJsonl = (lines: string[]): string => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "model-alias-")), "session.jsonl");
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return file;
  };

  test("finds the model when the first assistant line sits past a 5KB head", () => {
    // The 2026-06-09 incident: a codex→claude switch materialized a transcript
    // opening with three copies of a long user message; the first assistant line
    // (first model field) started at byte ~17K, beyond the 5KB head window the
    // daemon used to scan, so the dead snapshot was never aliased.
    const longUser = user("look deeply at this codebase ".repeat(250)); // ~7KB each
    const file = writeTmpJsonl([longUser, longUser, longUser, asst("claude-opus-4-6-20260205")]);
    expect(resumeModelFlagFromFile(file, "")).toBe(" --model opus");
  });

  test("an explicit --model flag always wins", () => {
    const file = writeTmpJsonl([asst("claude-opus-4-6-20260205")]);
    expect(resumeModelFlagFromFile(file, "--model haiku")).toBe("");
  });

  test("missing file yields no flag", () => {
    expect(resumeModelFlagFromFile("/nonexistent/path/session.jsonl", "")).toBe("");
  });
});

describe("claudeTranscriptModel", () => {
  test("preserves a recorded claude model", () => {
    expect(claudeTranscriptModel("claude-sonnet-4-6-20260205")).toBe("claude-sonnet-4-6-20260205");
  });

  test("stamps the never-stale alias when the conversation has no model", () => {
    // A codex conversation switched to claude has model null (cleared on agent
    // switch). The old fallback baked in a pinned snapshot that died when the
    // snapshot was retired; the alias resolves to a live model forever.
    expect(claudeTranscriptModel(null)).toBe("opus");
    expect(claudeTranscriptModel(undefined)).toBe("opus");
    expect(claudeTranscriptModel("")).toBe("opus");
  });

  test("never stamps a non-claude model into a claude transcript", () => {
    expect(claudeTranscriptModel("gpt-5.2-codex")).toBe("opus");
  });
});
