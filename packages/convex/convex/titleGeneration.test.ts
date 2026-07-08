import { describe, expect, test } from "bun:test";
import {
  buildTitleMessageContext,
  buildTitlePrompt,
  extractTitleJson,
  isLowSignalPrompt,
  sampleEvenly,
  shouldGenerateTitle,
} from "./titleGeneration";

describe("extractTitleJson", () => {
  test("parses bare JSON", () => {
    expect(extractTitleJson('{"title": "Auth fix", "subtitle": "- done"}')).toEqual({
      title: "Auth fix",
      subtitle: "- done",
    });
  });

  test("parses JSON behind a preamble and fence", () => {
    const text = 'I\'ll generate the title now.\n\n```json\n{"title": "Auth fix", "subtitle": ""}\n```';
    expect(extractTitleJson(text)?.title).toBe("Auth fix");
  });

  test("handles braces inside string values", () => {
    const text = '{"title": "Fix {id} routing", "subtitle": "- patched {param} parse"}';
    expect(extractTitleJson(text)?.title).toBe("Fix {id} routing");
  });

  test("returns null for conversational responses — never a raw-text title", () => {
    expect(extractTitleJson("I need to wait for the session to resume.")).toBeNull();
    expect(extractTitleJson("Confirming: the fix works. Tests pass.")).toBeNull();
  });
});

describe("buildTitleMessageContext", () => {
  test("shows user prompts across the whole session plus recent activity", () => {
    const spine = Array.from({ length: 60 }, (_, i) => ({
      role: "user" as const,
      content: `request number ${i}`,
    }));
    const recent = [
      { role: "assistant" as const, content: "working on the latest step" },
      { role: "user" as const, content: "now polish the picker hints" },
    ];

    const ctx = buildTitleMessageContext(spine, recent);

    expect(ctx).toContain("User requests across the session");
    expect(ctx).toContain("Most recent activity");
    // First and last prompts survive sampling — the arc is visible.
    expect(ctx).toContain("request number 0");
    expect(ctx).toContain("request number 59");
    expect(ctx).toContain("now polish the picker hints");
  });

  test("short sessions show every message", () => {
    const spine = [
      { role: "user", content: "first" },
      { role: "user", content: "third" },
    ];
    const recent = [
      { role: "assistant", content: "second" },
      { role: "user", content: "fourth" },
    ];

    const ctx = buildTitleMessageContext(spine, recent);

    for (const word of ["first", "second", "third", "fourth"]) {
      expect(ctx).toContain(word);
    }
  });

  test("truncates long message bodies", () => {
    const long = "x".repeat(500);
    const ctx = buildTitleMessageContext([{ role: "user", content: long }], []);
    expect(ctx).toContain("...");
    expect(ctx).not.toContain("x".repeat(251));
  });

  test("worst-case context stays within the previous token budget", () => {
    // The old design fed 17 messages at 400 chars (~7.1KB of message text).
    // This runs on a cadence, so the new shape must not exceed that.
    const spine = Array.from({ length: 200 }, () => ({
      role: "user" as const,
      content: "y".repeat(1000),
    }));
    const recent = Array.from({ length: 20 }, () => ({
      role: "assistant" as const,
      content: "y".repeat(1000),
    }));

    const ctx = buildTitleMessageContext(spine, recent);

    expect(ctx.length).toBeLessThanOrEqual(7100);
  });
});

describe("buildTitlePrompt", () => {
  test("anchors on the current title when one exists", () => {
    const prompt = buildTitlePrompt({
      messageText: "User: hi",
      currentTitle: "Keyboard shortcut polish",
      messageCount: 312,
    });
    expect(prompt).toContain('The current title is "Keyboard shortcut polish"');
    expect(prompt).toContain("NOT a reason to retitle");
    expect(prompt).toContain("Session with 312 messages");
  });

  test("omits the anchor for fresh sessions", () => {
    const prompt = buildTitlePrompt({ messageText: "User: hi", messageCount: 2 });
    expect(prompt).not.toContain("current title");
    expect(prompt).toContain("AS A WHOLE");
  });
});

describe("isLowSignalPrompt", () => {
  test("flags markers and scaffolding, keeps real prompts", () => {
    expect(isLowSignalPrompt("[Request interrupted by user for tool use]")).toBe(true);
    expect(isLowSignalPrompt("<task-notification>\n<task-id>x</task-id>")).toBe(true);
    expect(isLowSignalPrompt("[image]")).toBe(true);
    expect(isLowSignalPrompt("[Codecast import] This session was truncated")).toBe(true);
    expect(isLowSignalPrompt("fix the [image] rendering in chat")).toBe(false);
    expect(isLowSignalPrompt("continue")).toBe(false);
  });
});

describe("sampleEvenly", () => {
  test("returns everything when under the cap", () => {
    expect(sampleEvenly([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  test("keeps first and last and spreads the middle", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const picked = sampleEvenly(items, 9);
    expect(picked.length).toBe(9);
    expect(picked[0]).toBe(0);
    expect(picked[8]).toBe(99);
    // Spread roughly evenly: consecutive gaps differ by at most 1 from 99/8.
    for (let i = 1; i < picked.length; i++) {
      const gap = picked[i] - picked[i - 1];
      expect(Math.abs(gap - 99 / 8)).toBeLessThanOrEqual(1);
    }
  });
});

describe("shouldGenerateTitle", () => {
  test("re-fires periodically as a long session keeps growing", () => {
    expect(shouldGenerateTitle(2)).toBe(true);
    expect(shouldGenerateTitle(80)).toBe(true);
    expect(shouldGenerateTitle(100)).toBe(true);
    expect(shouldGenerateTitle(81)).toBe(false);
  });
});
