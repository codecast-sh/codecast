import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  claudeEffortLevel,
  resumeEffortFlag,
  resumeEffortFlagFromFile,
} from "./jsonlGenerator.js";

// Effort twin of daemon.resume-model-alias.test.ts. Unlike model, effort has NO
// per-message field in the transcript — the only durable signals are the two
// switch echoes (captured live from CC 2.1.173 on 2026-06-11):
//   /effort one-shot:    "Set effort level to high (saved as your default …)"
//   picker `s` commit:   "Set model to Sonnet 4.6 for this session only with max effort"
// Without the re-pin, every kill/restart silently drops a session's effort back
// to the user's global default — the exact failure mode the model alias
// override fixed for /model switches.

const user = (content: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content } });

const asst = (model: string) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", model, content: [{ type: "text", text: "hi" }] } });

// Real ESC chars: JSON.stringify renders them as `\u001b` text, byte-for-byte
// what Claude Code writes to the transcript.
const effortCmd = (level: string) =>
  user(`<local-command-stdout>Set effort level to ${level} (saved as your default for new sessions): Some description</local-command-stdout>`);

const pickerCommit = (name: string, level: string) =>
  user(`<local-command-stdout>Set model to \u001b[1m${name}\u001b[22m for this session only with \u001b[1m${level}\u001b[22m effort</local-command-stdout>`);

describe("claudeEffortLevel", () => {
  test("reads the /effort command echo", () => {
    expect(claudeEffortLevel(effortCmd("high"))).toBe("high");
    expect(claudeEffortLevel(effortCmd("max"))).toBe("max");
    expect(claudeEffortLevel(effortCmd("xhigh"))).toBe("xhigh");
  });

  test("reads the picker session-only commit (with ANSI bold)", () => {
    expect(claudeEffortLevel(pickerCommit("Sonnet 4.6", "max"))).toBe("max");
    expect(claudeEffortLevel(pickerCommit("Fable 5", "low"))).toBe("low");
  });

  test("a model-only switch carries no effort signal", () => {
    const modelOnly = user("<local-command-stdout>Set model to \u001b[1mOpus 4.8\u001b[22m and saved as your default for new sessions</local-command-stdout>");
    expect(claudeEffortLevel(modelOnly)).toBeNull();
    const sessionOnly = user("<local-command-stdout>Set model to \u001b[1mSonnet 4.6\u001b[22m for this session only</local-command-stdout>");
    expect(claudeEffortLevel(sessionOnly)).toBeNull();
  });

  test("the LAST effort signal wins", () => {
    const transcript = [effortCmd("low"), asst("claude-opus-4-8"), pickerCommit("Opus 4.8", "max")].join("\n");
    expect(claudeEffortLevel(transcript)).toBe("max");
  });

  test("switching to auto clears the override", () => {
    const transcript = [effortCmd("max"), effortCmd("auto")].join("\n");
    expect(claudeEffortLevel(transcript)).toBeNull();
  });

  test("ignores prose merely mentioning effort", () => {
    expect(claudeEffortLevel(user("please work with max effort on this"))).toBeNull();
    expect(claudeEffortLevel(user("the log said: Set effort level to high"))).toBeNull();
  });

  test("returns null on empty/effortless transcripts", () => {
    expect(claudeEffortLevel("")).toBeNull();
    expect(claudeEffortLevel(asst("claude-fable-5"))).toBeNull();
  });
});

describe("resumeEffortFlag", () => {
  test("re-pins the recorded effort", () => {
    expect(resumeEffortFlag(effortCmd("max"), "")).toBe(" --effort max");
  });

  test("an explicit --effort flag always wins", () => {
    expect(resumeEffortFlag(effortCmd("max"), "--effort low")).toBe("");
    expect(resumeEffortFlag(effortCmd("max"), "--dangerously-skip-permissions --effort=high")).toBe("");
  });

  test("no flag when the transcript has no effort signal", () => {
    expect(resumeEffortFlag(asst("claude-opus-4-8"), "")).toBe("");
  });
});

describe("resumeEffortFlagFromFile", () => {
  const writeTmpJsonl = (lines: string[]): string => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "effort-")), "session.jsonl");
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return file;
  };

  test("a mid-session effort switch survives resume", () => {
    const file = writeTmpJsonl([asst("claude-opus-4-8"), pickerCommit("Opus 4.8", "max"), asst("claude-opus-4-8")]);
    expect(resumeEffortFlagFromFile(file, "")).toBe(" --effort max");
  });

  test("an explicit --effort flag always wins", () => {
    const file = writeTmpJsonl([effortCmd("max")]);
    expect(resumeEffortFlagFromFile(file, "--effort low")).toBe("");
  });

  test("missing file yields no flag", () => {
    expect(resumeEffortFlagFromFile("/nonexistent/path/session.jsonl", "")).toBe("");
  });
});
