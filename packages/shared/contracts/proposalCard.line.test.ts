import { expect, test } from "bun:test";
import { alongsideMissing, validateProposalCard } from "./proposalCard";

// A line run's proposal card: the gather reruns of tc-40, tc-41 and tc-43 came back with no recommendation and no
// proof, and tc-41 reversed tc-30's fix without saying so.
const card = {
  kind: "proposal",
  question: "When an intro goes out, should Union send its older queued notes to both people first?",
  today: "A note written before the intro can arrive hours after it.",
  after: "Older queued notes go out no later than the intro.",
  cause: { line: "An introduction is sent right away while an earlier reply waits for working hours.", where: ["backend/src/lib/agent/tools/sendEmail.ts:1510"] },
  case: { signal: "sg-2652", asked: "Ernst, introduced to Ray at 07:13", quote: "I'll send it as the next step.", missing: "The intro had gone out four hours earlier" },
  risk: { class: "low", reason: "About 1 in 20 intro sends" },
};
const fields = (v: ReturnType<typeof validateProposalCard>) => (v.ok ? [] : v.errors.map((e) => e.split(":")[0]).sort());

test("a line run's card is refused without its recommendation and its proof; a stored older card still reads", () => {
  expect(fields(validateProposalCard(card, { line: true }))).toEqual(["proof", "recommend"]);
  expect(validateProposalCard(card).ok).toBe(true);
  const whole = { ...card, recommend: { verdict: "build", why: "10 of 214 introductions in 60 days arrived out of order." }, proof: { rung: "unit", outcome: "red" }, measured: { count: 10, of: 214, window: "introductions, last 60 days", method: "production-read" } };
  expect(validateProposalCard(whole, { line: true }).ok).toBe(true);
});

test("a proposal that reverses an earlier one names it, by its trial card or a decision (tc-41 over tc-30)", () => {
  const over = (o: unknown) => fields(validateProposalCard({ ...card, overturns: o }));
  expect(over({ ref: "tc-30", by: "Earlier proposal", what: "Cancel older queued notes", why: "8 of 10 late notes carried a real answer" })).toEqual([]);
  expect(over({ ref: "sd-577", by: "Ashot", what: "Keep the cap" })).toEqual([]);
  expect(over({ ref: "the old one", by: "", what: "x".repeat(141) })).toEqual(["overturns.by", "overturns.ref", "overturns.what"]);
});

const lined = { ...card, proof: { rung: "unit", outcome: "red" } };

test("a build that cites a count carries it in measured, and the why and the tile say the same pair (tc-42, tc-44)", () => {
  // tc-42: "found callers pressing past a no in 23 calls" with measured null; tc-44: "61 of 66" with measured null.
  expect(fields(validateProposalCard({ ...lined, recommend: { verdict: "build", why: "A three-week replay found callers pressing past a no in 23 calls." } }, { line: true }))).toEqual(["recommend.why"]);
  expect(fields(validateProposalCard({ ...lined, recommend: { verdict: "build", why: "Replay shows 61 of 66 cc'd parties switched since September." } }, { line: true }))).toEqual(["recommend.why"]);
  const measured = { count: 61, of: 66, window: "cc'd parties since September", method: "replay" };
  expect(fields(validateProposalCard({ ...lined, measured, recommend: { verdict: "build", why: "Replay shows 61 of 66 cc'd parties switched since September." } }, { line: true }))).toEqual([]);
  expect(fields(validateProposalCard({ ...lined, measured, recommend: { verdict: "build", why: "Replay shows 23 of 95 calls pressed on." } }, { line: true }))).toEqual(["recommend.why"]);
  // Dates, durations and percentages are not counts; a revise may name a number without a measurement.
  expect(fields(validateProposalCard({ ...lined, recommend: { verdict: "build", why: "Tips held 25 seconds after Oct 6 kept callers pitching." } }, { line: true }))).toEqual([]);
  expect(fields(validateProposalCard({ ...lined, recommend: { verdict: "revise", why: "Only 2 conversations show it so far." } }, { line: true }))).toEqual([]);
});

test("a call case may show its moment as timed beats: the contact's no, the tip on screen, the caller's next line", () => {
  const beats = [
    { at: "4:12", who: "contact", text: "Honestly we're set on advisors." },
    { at: "3:58", who: "tip", text: "Ask whether an M&A advisor like Bindi would help" },
    { at: "4:15", who: "caller", text: "Would it help to have an M&A advisor like Bindi?" },
  ];
  expect(fields(validateProposalCard({ ...card, case: { ...card.case, beats } }))).toEqual([]);
  expect(fields(validateProposalCard({ ...card, case: { ...card.case, beats: [beats[0]] } }))).toEqual(["case.beats"]);
  expect(fields(validateProposalCard({ ...card, case: { ...card.case, beats: [{ ...beats[0], at: "late" }, { ...beats[1], who: "coach" }] } }))).toEqual(["case.beats[0].at", "case.beats[1].who"]);
});

test("two waiting cards on the same code each say how they meet (tc-40 and tc-41 on sendEmail.ts)", () => {
  const where = ["backend/src/lib/agent/tools/sendEmail.ts:1516"];
  const others = [{ card: "tc-41", where: ["backend/src/lib/agent/tools/sendEmail.ts:1510"] }, { card: "tc-29", where: ["templates/layers/matching.njk:319"] }];
  expect(alongsideMissing({}, where, others)).toEqual(["tc-41"]);
  expect(alongsideMissing({ alongside: [{ card: "tc-41", line: "On an intro, tc-41 sends the older note first; this one only cancels a reply a follow-up repeats." }] }, where, others)).toEqual([]);
  expect(fields(validateProposalCard({ ...card, alongside: [{ card: "41", line: "" }] }))).toEqual(["alongside[0].card"]);
});
