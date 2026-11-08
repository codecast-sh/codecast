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
