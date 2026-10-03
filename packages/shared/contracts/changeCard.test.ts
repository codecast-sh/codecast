import { describe, expect, it, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  CARD_DECISION_OPTIONS,
  cardVerdictIndexes,
  assembleChangeCard,
  countSentences,
  proofCountsIn,
  proofSummary,
  cardChecks,
  cardFailing,
  checksLabel,
  reportsFailure,
  PROOF_CHECK,
  riskLabel,
  SUITE_GATE_CHECK,
  validateChangeCard,
  type CardAssemblyInput,
  type ChangeCard,
} from "./changeCard";
import { renderChangeCardHtml } from "../render/changeCardHtml";

// Goldens: the sample cause (a prompt miss on the title surface) assembled
// from its recorded inputs, and that card rendered. Regenerate deliberately
// with UPDATE_GOLDEN=1 and read the diff in the same commit.

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "changeCard");
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf-8"));

function sampleAssemblyInput(): CardAssemblyInput {
  return {
    task: read("task.json"),
    evidence: read("evidence.json"),
    evalResult: read("eval-result.json"),
    proof: read("proof.json"),
    ...read("inputs.json"),
  };
}

function golden(file: string, actual: string) {
  const p = path.join(DIR, file);
  if (process.env.UPDATE_GOLDEN || !fs.existsSync(p)) fs.writeFileSync(p, actual);
  expect(actual).toBe(fs.readFileSync(p, "utf-8"));
}

const sample = () => assembleChangeCard(sampleAssemblyInput());
/** The sample with two suite gate scenarios failing, recommended for revision as a failing check requires. */
function gateSample(): ChangeCard {
  const input = sampleAssemblyInput();
  input.evalResult = { ...input.evalResult!, ok: false, gatesFailed: ["handoff-keeps-owner", "dup-merge-keeps-newest"] };
  input.recommend = { verdict: "revise", why: "Two suite scenarios fail on the branch, so the change needs another pass." };
  return assembleChangeCard(input);
}
const clone = (c: ChangeCard): any => JSON.parse(JSON.stringify(c));
const errorsOf = (c: unknown) => {
  const v = validateChangeCard(c);
  return v.ok ? [] : v.errors;
};

describe("change card golden", () => {
  it("assembles the sample card from task, evidence, proof and eval result", () => {
    golden("card.json", JSON.stringify(sample(), null, 2) + "\n");
  });

  it("renders the sample card", () => {
    golden("card.html", renderChangeCardHtml(sample()));
  });

  it("renders a card whose suite gates failed, the failing scenarios in its checks", () => {
    golden("card-gates.html", renderChangeCardHtml(gateSample()));
  });

  it("the sample card is valid", () => {
    expect(validateChangeCard(sample())).toEqual({ ok: true, card: sample() });
  });
});

describe("assembleChangeCard", () => {
  it("merges the recorded proof ahead of the eval proof and adds eval cost to the run's", () => {
    const card = sample();
    expect(card.proof.before.map((x) => x.name)).toEqual([
      "titlePrompt.test.ts · greeting is never the title",
      "title · opener is a greeting",
      "title · pasted stack trace",
      "title · long opener with a plan",
    ]);
    expect(card.cost.usd).toBe(1.96);
    expect(card.checks.map((c) => [c.name, c.ok])).toEqual([["Verify", true], ["Eval", true], ["Review", true]]);
    expect(card.diff.pr).toBe("https://github.com/codecast-sh/codecast/pull/912");
  });

  it("a failed suite gate is its own red check naming the scenarios, and the Eval check answers for the replays alone", () => {
    const card = gateSample();
    expect(card.checks.map((c) => [c.name, c.ok])).toEqual([["Verify", true], ["Eval", true], [SUITE_GATE_CHECK, false], ["Review", true]]);
    expect(card.checks[2]!.detail).toBe("2 scenarios failed: handoff-keeps-owner, dup-merge-keeps-newest");
    expect(errorsOf(card)).toEqual([]);
    const ship = clone(card);
    ship.recommend.verdict = "ship";
    expect(errorsOf(ship)).toEqual([`recommend.verdict: ship over failing checks (${SUITE_GATE_CHECK}); recommend revise or drop`]);
  });

  it("no suite gate check when no gate failed", () => {
    expect(sample().checks.some((c) => c.name === SUITE_GATE_CHECK)).toBe(false);
  });

  it("lists broken flips after fixed ones and caps examples at three", () => {
    const input = sampleAssemblyInput();
    const s = input.evalResult!.surfaces[0]!;
    s.flips.unshift({ ...s.flips[0]!, freeze: "fz-x", name: "short opener", direction: "broke", note: "Too generic." });
    const card = assembleChangeCard(input);
    expect(card.examples).toHaveLength(3);
    expect(card.examples.every((e) => !e.note.startsWith("Regressed"))).toBe(true);
    s.flips = [s.flips[0]!];
    expect(assembleChangeCard(input).examples[0]!.note).toBe("Regressed. Too generic.");
  });

  it("a proven freeze that already passed on the base shows green before, and the card refuses it", () => {
    const input = sampleAssemblyInput();
    input.proof = null;
    input.evalResult!.surfaces[0]!.proven = input.evalResult!.surfaces[0]!.proven.map((p) => ({ ...p, basePasses: true }));
    const card = assembleChangeCard(input);
    expect(card.proof.before.every((x) => x.ok && x.detail === "already passes before the change")).toBe(true);
    expect(errorsOf(card)).toContain("proof.before: no failing check; proof starts red (LE8)");
  });

  it("an ungrounded task gets goal none, review risk, and empty model fields that the validator names", () => {
    const card = assembleChangeCard({ task: { short_id: "ct-9", title: "Something broke" } });
    expect(card.goal).toEqual({ ref: "none", name: "", why: "" });
    expect(card.risk.class).toBe("review");
    expect(card.diff).toEqual({ files: 0, added: 0, removed: 0 });
    expect(errorsOf(card)).toEqual([
      "wrong: is empty",
      "change: is empty",
      "recommend.verdict: expected one of ship | revise | drop, got \"\"",
      "recommend.why: is empty",
    ]);
  });
});

describe("validateChangeCard", () => {
  it("rejects a non-object", () => {
    expect(errorsOf(null)).toEqual(["card: expected an object, got null"]);
  });

  it("names every structural problem by path", () => {
    const c = clone(sample());
    c.cause.task = "56301";
    c.cause.first_seen = "yesterday";
    c.proof.after[1].ok = "yes";
    c.examples[0].after = 4;
    c.diff.added = -3;
    c.diff.pr = "github pr";
    c.risk.class = "medium";
    c.cost = undefined;
    expect(errorsOf(c)).toEqual([
      "cause.task: expected a task short id (ct-N), got \"56301\"",
      "cause.first_seen: expected epoch milliseconds or null, got \"yesterday\"",
      "proof.after[1].ok: expected a boolean, got \"yes\"",
      "proof.after: no check named \"title · opener is a greeting\"; every red check needs its after",
      "examples[0].after: expected a string, got 4",
      "diff.added: expected a non-negative number, got -3",
      "diff.pr: expected a url, got \"github pr\"",
      "risk.class: expected one of low | review | plan, got \"medium\"",
      "cost: expected an object, got nothing",
    ]);
  });

  it("holds the line's rules: proof starts red, three examples, two sentences, no ship over a failing check", () => {
    const c = clone(sample());
    c.proof.before = c.proof.before.map((x: any) => ({ ...x, ok: true }));
    c.examples.push(c.examples[0]);
    c.wrong = "One. Two. Three.";
    c.checks[1].ok = false;
    expect(errorsOf(c)).toEqual([
      "wrong: 3 sentences; the card takes one or two",
      "proof.before: no failing check; proof starts red (LE8)",
      "examples: 4 examples; at most 3",
      "recommend.verdict: ship over failing checks (Eval); recommend revise or drop",
    ]);
  });

  it("refuses ship while a proof check is still red or the change broke one", () => {
    const c = clone(sample());
    c.proof.after[0].ok = false;
    c.proof.after.push({ name: "new guard", ok: false, detail: "" });
    expect(errorsOf(c)).toEqual([
      `recommend.verdict: ship over a red proof (${c.proof.before[0].name} still red, new guard broke); recommend revise or drop`,
    ]);
    c.recommend.verdict = "revise";
    expect(errorsOf(c)).toEqual([]);
  });

  it("requires a goal name only when a goal is named", () => {
    const c = clone(sample());
    c.goal = { ref: "none", name: "", why: "" };
    expect(errorsOf(c)).toEqual([]);
    c.goal.ref = "in-3";
    expect(errorsOf(c)).toEqual(["goal.name: is empty"]);
  });

  it("an escalation with no proof at all is allowed", () => {
    const c = clone(sample());
    c.proof = { before: [], after: [] };
    c.examples = [];
    expect(errorsOf(c)).toEqual([]);
  });
});

describe("helpers", () => {
  it("counts sentences without splitting on abbreviations", () => {
    expect(countSentences("Titles copy the opener, e.g. greetings. They now name the work.")).toBe(2);
    expect(countSentences("No stop at the end")).toBe(1);
    expect(countSentences("")).toBe(0);
  });

  it("summarizes the proof honestly", () => {
    expect(proofSummary(sample().proof).evidence).toBe("4 of 4 cases fixed");
    const p = {
      before: [{ name: "a", ok: false, detail: "" }, { name: "b", ok: false, detail: "" }],
      after: [{ name: "a", ok: true, detail: "" }, { name: "b", ok: false, detail: "" }, { name: "c", ok: false, detail: "" }],
    };
    expect(proofSummary(p)).toEqual({ red: 2, fixed: 1, stillRed: ["b"], broke: ["c"], evidence: "1 of 2 cases fixed, 1 new failure" });
    expect(proofSummary(sample().proof).evidence).toBe("4 of 4 cases fixed");
  });

  it("counts every failure from one list: the proof as a check, and a check whose words report a failure", () => {
    const c = sample();
    expect(cardChecks(c).map((x) => x.name)).toEqual([PROOF_CHECK, ...c.checks.map((x) => x.name)]);
    expect(cardFailing(c)).toBe(0);
    expect(checksLabel(cardChecks(c))).toBe(`${c.checks.length + 1} checks pass`);
    const red = { ...c, proof: { before: c.proof.before, after: c.proof.after.map((x, i) => (i === 0 ? { ...x, ok: false } : x)) }, checks: [{ name: "Verify", ok: true, detail: "bun test: 11 pass, 1 fail." }, { name: "Review", ok: true, detail: "0 errors" }] };
    expect(cardChecks(red).filter((x) => !x.ok).map((x) => x.name)).toEqual([PROOF_CHECK, "Verify"]);
    expect(cardFailing(red)).toBe(2);
    expect(checksLabel(cardChecks(red))).toBe("2 of 3 checks fail");
    expect(checksLabel(cardChecks(red), true)).toBe("2 of 3 fail");
    expect(reportsFailure("cast check: 0 errors. 12 pass.")).toBe(false);
    expect(reportsFailure("2 errors")).toBe(true);
    expect(proofSummary({ before: [], after: [] }).evidence).toBe("No proof recorded");
  });

  it("refuses a reason whose proof count is not the proof's", () => {
    expect(proofCountsIn("All three proven misses now pass, and 2 red checks.")).toEqual([3, 2]);
    expect(proofCountsIn("Both misses pass now.")).toEqual([2]);
    expect(proofCountsIn("Three checks pass.")).toEqual([]);
    // The card's own checks are not the proof: counting them is not a contradiction.
    expect(proofCountsIn("Revise: 2 failing checks, typecheck and review.")).toEqual([]);
    expect(proofCountsIn("Both checks ran clean and one review note is open.")).toEqual([]);
    expect(proofCountsIn("It touches two files and three prompts.")).toEqual([]);
    const ok = clone(sample());
    ok.recommend = { verdict: "revise", why: "All four proven misses pass, but 2 failing checks remain: typecheck and review." };
    const v2 = validateChangeCard(ok);
    expect(v2.ok ? [] : v2.errors).toEqual([]);
    const c = clone(sample());
    c.recommend.why = "All three proven misses now pass, nothing regressed.";
    const v = validateChangeCard(c);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors).toContain("recommend.why: says 3 proven misses, but the proof shows 4");
  });

  it("renders a neutral label for a card with no recommendation yet", () => {
    const c = clone(sample());
    c.recommend = { verdict: "", why: "" };
    const html = renderChangeCardHtml(c);
    expect(html).toContain('<span class="verdict">No recommendation</span>');
    expect(html).toContain("--tone:var(--neutral)");
    expect(html).not.toContain("Recommends");
  });

  it("labels risk", () => {
    expect(riskLabel({ class: "low", reason: "" })).toBe("Low risk");
    expect(riskLabel({ class: "review", reason: "" })).toBe("Medium risk");
    expect(riskLabel({ class: "plan", reason: "" })).toBe("High risk: needs its own plan");
    expect(riskLabel({ class: "plan", reason: "" }, true)).toBe("High risk");
  });
});

describe("cardVerdictIndexes", () => {
  test("maps Ship, Revise and Drop by label, keys and case ignored", () => {
    expect(cardVerdictIndexes(CARD_DECISION_OPTIONS)).toEqual({ ship: 0, revise: 1, drop: 2 });
    expect(cardVerdictIndexes([{ label: "[D] drop it" }, { label: "[S] Ship" }, { label: "Revise with a note" }])).toEqual({ ship: 1, revise: 2, drop: 0 });
  });
  test("null when any verdict has no option", () => {
    expect(cardVerdictIndexes([{ label: "Ship" }, { label: "Wait" }])).toBeNull();
  });
});

