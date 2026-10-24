import { describe, expect, test } from "bun:test";
import { formatAgentTry, formatTry, momentForTry, renderJudgingSetup } from "./judgingCommand";

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

describe("an agent judge tried on a stored moment", () => {
  const finding = (what: string, severity: number) => ({ what, evidence: [], hurt: "", severity, layer: "conversation" as const, cause: "", cause_checked: false });
  test("sets what it found beside what the published judge found there", () => {
    const text = formatAgentTry({
      moment: "mo-6476", ok: true, account: "claude7", took_ms: 14 * 60_000, notional_usd: 2.4, dir: "/tmp/t/try-1-mo-6476",
      findings: [finding("A booked call was not dialed on time.", 6)],
      before: [{ judge_version: "9aea8734fbfd7429", findings: [{ what: "A booked call was not dialed on time.", severity: 6 }, { what: "The stored email was never reconciled.", severity: 2 }] }],
    });
    expect(text).toContain("mo-6476: 1 finding, 14m on claude7, $2.40 at list price");
    expect(text).toContain("published 9aea8734fb found 2:");
    expect(text).toContain("    severity 2: The stored email was never reconciled.");
    expect(text).toContain("session: /tmp/t/try-1-mo-6476");
  });
  test("a failed session says why", () => {
    expect(formatAgentTry({ moment: "a.json", ok: false, error: "the findings turn ended without an answer", findings: [], account: "claude3", took_ms: 0, notional_usd: 0, dir: "/tmp/x" })).toContain("a.json: failed, the findings turn ended without an answer");
  });
});
