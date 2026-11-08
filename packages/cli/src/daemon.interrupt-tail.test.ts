import { expect, test } from "bun:test";
import { transcriptTailEndsInterrupted } from "./daemon.js";

const line = (role: "user" | "assistant", content: string) => JSON.stringify({ type: role, message: { role, content } });

// The turn-claim pass reads this to tell a person's Escape from a crash. A
// slash command run after the Escape (/model, then /exit) writes user entries
// of its own, and must not hide the interrupt, or the stopped turn is resumed.
test("an interrupt followed by slash commands still reads as interrupted", () => {
  const tail = [
    line("assistant", "Working on it"),
    line("user", "[Request interrupted by user]"),
    line("user", "<command-name>/model</command-name>"),
    line("user", "<local-command-stdout>Set model to opus</local-command-stdout>"),
    line("user", "<command-name>/exit</command-name>"),
  ].join("\n");
  expect(transcriptTailEndsInterrupted(tail)).toBe(true);
});

test("a real prompt after the interrupt starts a turn that was not interrupted", () => {
  const tail = [line("user", "[Request interrupted by user]"), line("user", "now do the other thing")].join("\n");
  expect(transcriptTailEndsInterrupted(tail)).toBe(false);
});

// A turn that ends on an API error fires Claude Code's StopFailure, never Stop,
// so its claim is released from the transcript: a continue would fail the same way.
test("the tail names the API error a turn ended on, and nothing after real turns", async () => {
  const { jsonlTailApiError, jsonlTailEndsWithLimitBanner } = await import("./daemon.js");
  const error = (text: string) => JSON.stringify({ type: "assistant", isApiErrorMessage: true, message: { role: "assistant", content: [{ type: "text", text }] } });
  const tooLong = [line("user", "do it"), error("Prompt is too long")].join("\n");
  expect(jsonlTailApiError(tooLong)).not.toBeNull();
  expect(jsonlTailEndsWithLimitBanner(tooLong)).toBe(false);
  expect(jsonlTailApiError([tooLong, line("user", "try again"), line("assistant", "Done")].join("\n"))).toBeNull();
  // A slash command after the error starts no turn, so the turn still ended on it.
  expect(jsonlTailApiError([tooLong, line("user", "<command-name>/model</command-name>"), line("user", "<local-command-stdout>Set model to opus</local-command-stdout>")].join("\n"))).not.toBeNull();
});

// The claim pass asks whether the last TURN ended; slash commands at the prompt start none.
test("a finished turn followed by slash commands still reads as finished for the claims", async () => {
  const { classifyTranscriptTail } = await import("./daemon.js");
  const ended = JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] } });
  const tail = [line("user", "do it"), ended, line("user", "<command-name>/model</command-name>")].join("\n");
  expect(classifyTranscriptTail(tail, { skipLocalCommands: true })).toBe("idle");
  expect(classifyTranscriptTail(tail)).toBe("active"); // every other caller unchanged
  const midTurn = [line("user", "do it"), JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [] } })].join("\n");
  expect(classifyTranscriptTail(midTurn, { skipLocalCommands: true })).toBe("active");
});
