// A typed message that is a numbered list sits in Claude's composer as
// "❯ 1. …" over its "2. …" rows, which parses as a dialog with its cursor on
// option 1. The delivery guard must read that as the message itself, and a
// real dialog as a dialog.
import { describe, expect, test } from "bun:test";
import { parseInteractivePrompt, promptIsOwnText } from "./daemon.js";

const steps = Array.from({ length: 6 }, (_, i) => `${i + 1}. Check migration step ${i + 1} against the staging snapshot.`);
const payload = `notes from the release review, please work through them in order.\n${steps.join("\n")}`;
const rule = "─".repeat(120);
const framed = (rows: string[]) => [" ▐▛███▛█   Claude Code", "", rule, ...rows, rule, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");

describe("promptIsOwnText", () => {
  test("the composer scrolled onto a typed numbered list is the payload, not a dialog", () => {
    const rows = steps.map((line, i) => (i === 0 ? `❯ ${line}` : `  ${line}`));
    rows[rows.length - 1] = rows[rows.length - 1]!.slice(0, 30); // cut off at the frame
    const prompt = parseInteractivePrompt(framed(rows), true);
    expect(prompt).not.toBeNull();
    expect(promptIsOwnText(prompt!, payload)).toBe(true);
  });

  test("a real permission dialog is never the payload", () => {
    const pane = framed([" Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again", "   3. No"]);
    const prompt = parseInteractivePrompt(pane, true);
    expect(prompt).not.toBeNull();
    expect(promptIsOwnText(prompt!, payload)).toBe(false);
    expect(promptIsOwnText(prompt!, undefined)).toBe(false);
  });
});
