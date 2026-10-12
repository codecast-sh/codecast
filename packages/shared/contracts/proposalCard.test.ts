import { expect, test } from "bun:test";
import { validateProposalCard } from "./proposalCard";

const good = {
  kind: "proposal",
  question: "Should Union hold a waiting email while Morgan is writing its replacement?",
  today: "A contact gets two near-identical emails minutes apart.",
  after: "The contact gets one email.",
  cause: { line: "The sender does not check whether a replacement is being written.", where: ["backend/src/jobs/dispatchEmails.ts:4837"] },
  case: { signal: "sg-1954", asked: "Sefi, owed new Zoom slots", quote: "Sorry about that." },
  risk: { class: "review", reason: "Every outgoing email briefly waits" },
};

test("a proposal card with one question, today, after, cause, case and risk is ready", () => {
  expect(validateProposalCard(good).ok).toBe(true);
  expect(validateProposalCard({ ...good, case: null }).ok).toBe(true);
});

test("a double question is refused, as tc-11 and tc-4 asked them", () => {
  for (const question of [
    "Should the dispatcher hold the email, and should outreach replace it, build this fix?",
    "Should it instead ask who else they'd meet and should we build this fix?",
  ]) {
    const v = validateProposalCard({ ...good, question });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.some((e) => e.startsWith("question"))).toBe(true);
  }
});

test("each field names what is wrong with it", () => {
  const v = validateProposalCard({ ...good, today: "One. Two.", cause: { line: "x", where: [] }, risk: { class: "huge", reason: "" } });
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.errors.map((e) => e.split(":")[0]).sort()).toEqual(["cause.where", "risk.class", "risk.reason", "today"]);
});

test("a recommendation names one of the gate's answers and says why in one sentence", () => {
  expect(validateProposalCard({ ...good, recommend: { verdict: "wait", why: "One conversation shows it, and the change reaches every match." } }).ok).toBe(true);
  const v = validateProposalCard({ ...good, recommend: { verdict: "ship", why: "Yes. Do it." } });
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.errors.map((e) => e.split(":")[0]).sort()).toEqual(["recommend.verdict", "recommend.why"]);
});
