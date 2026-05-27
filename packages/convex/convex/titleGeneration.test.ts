import { describe, expect, test } from "bun:test";
import { buildTitleMessageContext, shouldGenerateTitle } from "./titleGeneration";

describe("buildTitleMessageContext", () => {
  test("surfaces the most recent activity for a long, pivoted session", () => {
    const messages = [
      { role: "user", content: "Fix the session dismiss flash-back bug" },
      ...Array.from({ length: 40 }, (_, i) => ({
        role: "assistant" as const,
        content: `working step ${i}`,
      })),
      { role: "user", content: "now migrate tasks from object to array in the external API" },
      { role: "assistant", content: "migrating tasks to array shape" },
    ];

    const ctx = buildTitleMessageContext(messages);

    // Current focus must be present so the prompt can title after it.
    expect(ctx).toContain("Most recent activity");
    expect(ctx).toContain("migrate tasks from object to array");
    // Origin context is still included, but clearly labeled as the start.
    expect(ctx).toContain("How the session started");
    expect(ctx).toContain("Fix the session dismiss flash-back bug");
  });

  test("short sessions show every message without overlap", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
      { role: "assistant", content: "fourth" },
    ];

    const ctx = buildTitleMessageContext(messages);

    for (const word of ["first", "second", "third", "fourth"]) {
      expect(ctx).toContain(word);
    }
    // No message should be duplicated across the two windows.
    expect(ctx.match(/User: first/g)?.length ?? 0).toBe(1);
  });

  test("truncates long message bodies", () => {
    const long = "x".repeat(500);
    const ctx = buildTitleMessageContext([{ role: "user", content: long }]);
    expect(ctx).toContain("...");
    expect(ctx).not.toContain("x".repeat(401));
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
