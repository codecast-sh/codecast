import { describe, expect, it } from "bun:test";
import { classifyApiErrorBanner, claudeAutoContinueBanner, isClaudeAutoContinueLine } from "./apiErrorBanner";

// Claude Code 2.1.283+ records a spent window only as this system line (no
// API-error entry), captured from the JSONL and the pane on 2026-09-30.
describe("Claude Code auto-continue limit wait", () => {
  it("turns the system line into a limit park", () => {
    for (const line of [
      "Usage limit reached · continuing automatically at 6:10pm · esc to cancel",
      "Usage limit reached again · continuing automatically at 8:40pm · esc to cancel",
    ]) {
      const banner = claudeAutoContinueBanner(line);
      expect(banner).toStartWith("You've hit your usage limit · Usage limit reached");
      expect(banner).not.toContain("esc to cancel");
      expect(classifyApiErrorBanner(banner)).toBe("limit");
    }
  });

  it("recognizes the pane footer and bulleted line, but only the system line parks", () => {
    const footer = "    Continuing automatically at 6:10pm · esc to cancel · /usage-credits to continue now";
    expect(isClaudeAutoContinueLine(footer)).toBe(true);
    expect(isClaudeAutoContinueLine("⏺ Usage limit reached · continuing automatically at 6:10pm · esc to cancel")).toBe(true);
    expect(claudeAutoContinueBanner(footer)).toBeNull();
  });

  it("reads the 'esc or type to cancel' wording as the same wait", () => {
    // Synced from jx7csbd's panes: the same wait on builds where typing also
    // cancels it. Unmatched, its system line recorded no park at all.
    const line = "Usage limit reached · continuing automatically at 5pm · esc or type to cancel";
    expect(isClaudeAutoContinueLine(line)).toBe(true);
    const banner = claudeAutoContinueBanner(line);
    expect(banner).not.toContain("cancel");
    expect(classifyApiErrorBanner(banner)).toBe("limit");
    expect(isClaudeAutoContinueLine("Continuing automatically at Oct 5 at 3pm · esc or type to cancel · /usage-credits to continue now")).toBe(true);
  });

  it("leaves other lines alone", () => {
    expect(claudeAutoContinueBanner("Automatic continue cancelled · /rate-limit-options to re-arm")).toBeNull();
    expect(claudeAutoContinueBanner("Usage limit reached · limit resets 6:10pm · clau.de/wrap-up")).toBeNull();
    expect(isClaudeAutoContinueLine("Enter to continue · Esc to cancel")).toBe(false);
  });
});
