import { describe, expect, test } from "bun:test";
import { checksSummary, errorsWords, evalsOwed, parseReviewVerdict, reviewWords, reviewsOf, scriptChecks } from "../scriptReport";

const verify = `{"ok":true,"steps":[{"name":"typecheck","ok":true,"detail":"passed: the 3 files with errors are all untouched by this branch"},{"name":"tripwires","ok":true,"detail":"passed"}],"preexisting":["backend/src/lib/apollo.ts","constants/fonts.ts"]}
check: typecheck
✓ backend: 0 errors
../backend/src/lib/apollo.ts(54,13): error TS7006: Parameter 'k' implicitly has an 'any' type.`;

describe("scriptReport", () => {
  test("a check runner's report reads as rows, its preexisting files by name, and the one log line with an error", () => {
    const c = scriptChecks(JSON.parse(verify.split("\n")[0]), verify)!;
    expect(c.rows.map((r) => [r.name, r.ok])).toEqual([["typecheck", true], ["tripwires", true]]);
    expect(c.preexisting).toEqual(["apollo.ts", "fonts.ts"]);
    expect(c.log).toContain("apollo.ts(54,13): error TS7006");
    expect(checksSummary(c)).toEqual({ text: "2/2 pass", bad: false });
    expect(checksSummary({ rows: [{ name: "a", ok: false, detail: null }, { name: "b", ok: true, detail: null }] })).toEqual({ text: "1/2 pass, 1 red", bad: true });
  });

  test("errors name missing fields, else count as errors", () => {
    expect(errorsWords(["wrong: is empty", "recommend.verdict: expec…"])).toBe("2 missing fields");
    expect(errorsWords(["something broke"])).toBe("1 error");
  });

  test("evals a scope selected and no later step ran are owed", () => {
    const visits = [{ node: "eval_scope", result: { scoped: true, select: "gate", paths: ["a", "b"] } }, { node: "review", result: null }];
    expect(evalsOwed(visits)).toEqual({ at: 0, select: "gate", files: 2 });
    expect(evalsOwed([...visits.slice(0, 1), { node: "eval", result: null }])).toBeNull();
    expect(evalsOwed([{ node: "eval_scope", result: { scoped: false, select: "", paths: [] } }])).toBeNull();
  });

  test("a reviewer's recorded verdict reads as its numbered points", () => {
    const r = parseReviewVerdict("Verdict: changes\n\n1. PASS — Edits the causal prompts. More.\n2. FAIL — Broader than approved; also more.")!;
    expect(r.verdict).toBe("changes");
    expect(r.points).toEqual([{ n: 1, ok: true, why: "Edits the causal prompts." }, { n: 2, ok: false, why: "Broader than approved; also more." }]);
    expect(reviewWords(r)).toEqual({ text: "changes: 1 fail", bad: true });
    expect(reviewWords(parseReviewVerdict("1. PASS — a.\n2. PASS — b.", "approve")!)).toEqual({ text: "approved 2/2", bad: false });
  });

  test("a task's verdicts are keyed by the session that recorded each", () => {
    const m = reviewsOf({
      comments: [{ comment_type: "review", conversation_id: "s1", text: "Verdict: changes\n1. FAIL — x." }, { comment_type: "progress", conversation_id: "s2", text: "1. PASS — y." }],
      review_verdict: { verdict: "approve", by_conversation_id: "s3", at: 5, note: "1. PASS — z." },
    });
    expect([...m.keys()]).toEqual(["s1", "s3"]);
    expect(m.get("s3")!.verdict).toBe("approve");
  });
});

import { deliveryBadge, isoToWords, whenWords } from "../momentWords";

describe("momentWords", () => {
  const now = new Date(2026, 9, 11, 14, 0).getTime();
  test("a queued send says when it goes, from now", () => {
    const at = new Date(2026, 9, 12, 8, 0);
    expect(deliveryBadge(`not yet delivered: queued to go at ${at.toISOString()}`, now)).toEqual({ words: `Queued · sends ${whenWords(at.getTime(), now)}`, tone: "warn" });
    expect(whenWords(at.getTime(), now)).toStartWith("tomorrow ");
    expect(deliveryBadge("delivered", now)).toBeNull();
    expect(isoToWords(`sent ${at.toISOString()}`, now)).toStartWith("sent tomorrow ");
  });
  test("a send held after it was written says when it was written, quietly", () => {
    const written = new Date(2026, 9, 10, 9, 30);
    expect(deliveryBadge(`sent; written ${written.toISOString()} and held until then`, now)).toEqual({ words: `Held · written ${whenWords(written.getTime(), now)}`, tone: "none" });
  });
});
