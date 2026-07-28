import { describe, expect, test } from "bun:test";
import {
  buildTitleMessageContext,
  buildTitlePrompt,
  extractTitleJson,
  isLowSignalPrompt,
  maybeScheduleTitleGeneration,
  sampleEvenly,
  shouldGenerateTitle,
} from "./titleGeneration";
import { isRefusalProse } from "./idleSummary";

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

  // Regression (inbox card "Not a coding session", a travel chat): the prompt
  // hardcoded "this coding session", so Haiku titled the frame instead of the
  // topic on non-coding sessions. The framing must stay domain-neutral.
  test("frames the session neutrally so non-coding sessions title by topic", () => {
    const prompt = buildTitlePrompt({ messageText: "User: villas near Lake Maggiore", messageCount: 2 });
    expect(prompt).not.toContain("for this coding session");
    expect(prompt).toContain("Never comment on the session's type");
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

// Regression (2026-07-13, seen on inbox card "Scheduled rows layout fix"):
// Haiku can comply with the JSON envelope while writing refusal prose INSIDE
// the subtitle value. extractTitleJson rightly parses that envelope — the
// subtitle-value guard (isRefusalProse in generateTitle / generateTaskSummary)
// is what must reject it, keeping the last good subtitle instead.
describe("subtitle-value refusal guard", () => {
  const REFUSAL_ENVELOPE =
    '{"title": "Scheduled rows layout fix", "subtitle": "I don\'t see a recent conversation to analyze. Please provide the conversation history between the agent and user so I can write the appropriate summary."}';

  test("the envelope parses — the parser is not the guard", () => {
    const parsed = extractTitleJson(REFUSAL_ENVELOPE);
    expect(parsed?.title).toBe("Scheduled rows layout fix");
    expect(parsed?.subtitle).toMatch(/^I don/);
  });

  test("isRefusalProse rejects the refusal value but passes legit subtitles", () => {
    const parsed = extractTitleJson(REFUSAL_ENVELOPE);
    expect(isRefusalProse(parsed!.subtitle!)).toBe(true);
    expect(isRefusalProse("- Compacted ScheduleRowItem to two-line display")).toBe(false);
    expect(isRefusalProse("Fixed search timeout and batch overflow hazard")).toBe(false);
  });
});

// The no-subtitle fallback fires on every sync batch of an untitled
// conversation. Unthrottled, a lagging scheduler turns that into a feedback
// loop: subtitles stop being written, so every active conversation enqueues a
// generateTitle job per batch and the queue grows faster than it drains (the
// 2026-07 scheduler wedge). maybeScheduleTitleGeneration is the single gate —
// it must schedule immediately for a fresh conversation but never twice within
// the interval for the same one.
describe("maybeScheduleTitleGeneration", () => {
  const makeCtx = () => {
    const calls: { patches: any[]; scheduled: any[] } = { patches: [], scheduled: [] };
    const ctx = {
      db: { patch: async (id: any, p: any) => { calls.patches.push({ id, ...p }); } },
      scheduler: { runAfter: async (_d: any, _f: any, a: any) => { calls.scheduled.push(a); } },
    } as any;
    return { ctx, calls };
  };
  const conv = (over: Record<string, unknown> = {}) =>
    ({ _id: "c1", message_count: 0, ...over }) as any;

  test("first milestone on a fresh conversation schedules immediately", async () => {
    const { ctx, calls } = makeCtx();
    await maybeScheduleTitleGeneration(ctx, conv(), 1, 2);
    expect(calls.scheduled.length).toBe(1);
    expect(calls.patches[0].title_gen_scheduled_at).toBeGreaterThan(0);
  });

  test("no-subtitle fallback fires without a milestone but respects the throttle", async () => {
    const { ctx, calls } = makeCtx();
    // 3 -> 4 crosses no milestone; subtitle missing => self-heal fires
    await maybeScheduleTitleGeneration(ctx, conv(), 3, 4);
    expect(calls.scheduled.length).toBe(1);
    // same conversation, stamped moments ago => suppressed
    const { ctx: ctx2, calls: calls2 } = makeCtx();
    await maybeScheduleTitleGeneration(ctx2, conv({ title_gen_scheduled_at: Date.now() - 1000 }), 3, 4);
    expect(calls2.scheduled.length).toBe(0);
    // stamp older than the interval => fires again
    const { ctx: ctx3, calls: calls3 } = makeCtx();
    await maybeScheduleTitleGeneration(ctx3, conv({ title_gen_scheduled_at: Date.now() - 6 * 60 * 1000 }), 3, 4);
    expect(calls3.scheduled.length).toBe(1);
  });

  test("batch spanning a milestone schedules; skip flag and subtitle-present quiet batches do not", async () => {
    const { ctx, calls } = makeCtx();
    // 21 -> 33 crosses the 30 milestone
    await maybeScheduleTitleGeneration(ctx, conv({ subtitle: "- has one" }), 21, 33);
    expect(calls.scheduled.length).toBe(1);
    const { ctx: ctx2, calls: calls2 } = makeCtx();
    await maybeScheduleTitleGeneration(ctx2, conv({ skip_title_generation: true }), 1, 2);
    expect(calls2.scheduled.length).toBe(0);
    // no milestone in (31, 33], subtitle exists => nothing to do
    const { ctx: ctx3, calls: calls3 } = makeCtx();
    await maybeScheduleTitleGeneration(ctx3, conv({ subtitle: "- has one" }), 31, 33);
    expect(calls3.scheduled.length).toBe(0);
  });
});
