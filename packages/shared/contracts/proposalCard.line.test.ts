import { expect, test } from "bun:test";
import { validateProposalCard } from "./proposalCard";

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
  const whole = { ...card, recommend: { verdict: "build", why: "10 of 214 introductions in 60 days arrived out of order." }, proof: { rung: "unit", outcome: "red" } };
  expect(validateProposalCard(whole, { line: true }).ok).toBe(true);
});

test("a proposal that reverses an earlier one names it, by its trial card or a decision (tc-41 over tc-30)", () => {
  const over = (o: unknown) => fields(validateProposalCard({ ...card, overturns: o }));
  expect(over({ ref: "tc-30", by: "Earlier proposal", what: "Cancel older queued notes", why: "8 of 10 late notes carried a real answer" })).toEqual([]);
  expect(over({ ref: "sd-577", by: "Ashot", what: "Keep the cap" })).toEqual([]);
  expect(over({ ref: "the old one", by: "", what: "x".repeat(141) })).toEqual(["overturns.by", "overturns.ref", "overturns.what"]);
});
