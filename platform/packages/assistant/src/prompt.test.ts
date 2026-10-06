import { describe, expect, test } from "bun:test";
import { systemPrompt } from "./prompt";

describe("systemPrompt", () => {
  test("carries the person, the app, the date in their zone, and the connection note", () => {
    const prompt = systemPrompt({ name: "Dana", timezone: "America/Los_Angeles", now: Date.UTC(2026, 9, 5, 18), note: "Mail is not connected.", workspace: "Averil" });
    expect(prompt).toContain("working for Dana");
    expect(prompt).toContain("notes in Averil");
    expect(prompt).toContain("Monday, October 5, 2026");
    expect(prompt).toContain("America/Los_Angeles, UTC-07:00");
    expect(prompt).toContain("11 AM");
    expect(prompt.endsWith("Mail is not connected.")).toBe(true);
    expect(systemPrompt({ timezone: "Not/AZone", now: 0, note: "", workspace: "x" })).toContain("(UTC");
  });
});
