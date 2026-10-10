import { describe, expect, test } from "bun:test";
import { formatTry, momentForTry, renderJudgingSetup } from "./judgingCommand";

describe("the setup pass (learning-loop.md LL4)", () => {
  test("is written out for the project, with no placeholder left", () => {
    const text = renderJudgingSetup({ title: "Agent Quality", ref: '"Agent Quality"' });
    expect(text).toContain("# Set up judging for Agent Quality");
    expect(text).toContain('cast expectations show\n--project "Agent Quality"');
    expect(text).not.toContain("{{");
    expect(text).toContain("Give Agent Quality the judges it needs");
  });

  test("starting from one judge asks the one question first and keeps the rest of the pass", () => {
    const text = renderJudgingSetup({ title: "Union", ref: "pr-7" }, { judge: "comms" });
    expect(text).toContain("Start from one judge, comms");
    expect(text).toContain("missing from what it was shown, or there and misread");
    expect(text).toContain("Turn on");
    expect(text).not.toContain("{{");
  });
});

describe("a tried moment", () => {
  const spec = { moment: "conversation" };

  test("an extractor's output reads as a moment of the judge's kind, read now", () => {
    const m = momentForTry({ blocks: [{ type: "text", text: "hello" }], refs: [{ label: "thread", id: "t_1" }], at: "2026-10-09T12:00:00Z" }, spec, "t1.json", 1_760_000_000_000);
    expect("error" in m).toBe(false);
    if ("error" in m) return;
    expect(m.kind).toBe("conversation");
    expect(m.subject).toBe("t1.json");
    expect(m.event_at).toBe(Date.parse("2026-10-09T12:00:00Z"));
    expect(m.gap_ms).toBe(0);
  });

  test("a kept moment keeps its own kind, subject and staleness", () => {
    const m = momentForTry({ kind: "call", subject: "c_9", event_at: 5, gap_ms: 1000, blocks: [{ type: "text", text: "x" }], refs: [] }, spec, "f", 10);
    if ("error" in m) throw new Error(m.error);
    expect([m.kind, m.subject, m.event_at, m.gap_ms]).toEqual(["call", "c_9", 5, 1000]);
  });

  test("output that is not a moment says why", () => {
    expect(momentForTry({ refs: [] }, spec, "f", 1)).toEqual({ error: "the moment needs blocks: a list of message, facts and text blocks" });
  });

  test("a budget refusal names where the budget is set and the most one call costs", () => {
    const line = formatTry({ moment: "t1.json", result: { ok: false, reason: "budget", error: "no room", cost_usd: 0, model: "claude-haiku-5-5", worst_case_usd: 0.0123 } });
    expect(line).toContain("not sent");
    expect(line).toContain("team's settings");
    expect(line).toContain("at most $0.0123");
    expect(line).not.toMatch(/cast /);
  });

  test("findings print with their expectation, severity and cost", () => {
    const line = formatTry({
      moment: "t1.json",
      result: { ok: true, text: "{}", usage: { input_tokens: 900, output_tokens: 80 }, cost_usd: 0.0011, model: "m" },
      findings: [{ expectation: "ex-aq-3", severity: 7, what_happened: "The reply promised a call and none came.", quote: "I'll call you at 3", markers: [] }],
      uncited: 1,
    });
    expect(line).toContain("1 finding, 1 citing no listed expectation");
    expect(line).toContain("ex-aq-3 severity 7");
  });
});
