import { expect, test } from "bun:test";
import { proposalOptions, validateProposalCard } from "./proposalCard";

const good = {
  kind: "proposal",
  question: "Should Union hold a waiting email while Morgan is writing its replacement?",
  today: "A contact gets two near-identical emails minutes apart.",
  after: "The contact gets one email.",
  cause: { line: "The sender does not check whether a replacement is being written.", where: ["backend/src/jobs/dispatchEmails.ts:4837"] },
  case: { signal: "sg-1954", asked: "Sefi, owed new Zoom slots", quote: "Sorry about that, here are new times.", missing: "Times she already declined" },
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

test("a case shows a line someone received and what it gets wrong: an empty quote or missing is refused (tc-20, tc-43)", () => {
  const caseOf = (c: Record<string, unknown>) => ({ ...good, case: { signal: "sg-2118", asked: "Forrest, called back for a yes or no", ...c } });
  const fields = (v: ReturnType<typeof validateProposalCard>) => (v.ok ? [] : v.errors.map((e) => e.split(":")[0]));
  expect(fields(validateProposalCard(caseOf({ quote: "", missing: "Never named Eric" })))).toEqual(["case.quote"]);
  expect(fields(validateProposalCard(caseOf({ quote: "Hey Forrest, this is Robert with Union." })))).toEqual(["case.missing"]);
  expect(fields(validateProposalCard(caseOf({ quote: "[About the match with Eric Ko]", missing: "Never named Eric" })))).toEqual(["case.quote"]);
  expect(validateProposalCard(caseOf({ quote: "So we're paid a success [fee], only when an introduction turns into something real.", missing: "Pitches a fee on a regulated raise" })).ok).toBe(true);
});

test("a proposal gate reads the shared answers by key, whatever labels its run's graph gave it (tc-43)", () => {
  const old = [{ key: "A", label: "Approve" }, { key: "R", label: "Revise" }, { key: "D", label: "Drop", description: "Nothing is built; the proposal stays on the problem" }];
  expect(proposalOptions(old).map((o) => o.label)).toEqual(["Build it", "Revise", "Not now"]);
  expect(proposalOptions(old)[2].description).toBe("Nothing is built; the problem stays open with this proposal on it");
});

test("a measured count says how many of how many, over what, and how; only a replay says what the change left", () => {
  expect(validateProposalCard({ ...good, measured: { count: 28, of: 32, window: "32 regulated calls replayed", method: "replay", after: 1 } }).ok).toBe(true);
  expect(validateProposalCard({ ...good, measured: { count: 38, of: 214, window: "60 days of intro sends", method: "production-read" } }).ok).toBe(true);
  expect(validateProposalCard({ ...good, measured: null }).ok).toBe(true);
  const v = validateProposalCard({ ...good, measured: { count: 40, of: 32, window: "", method: "guess", after: 2 } });
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.errors.map((e) => e.split(":")[0]).sort()).toEqual(["measured.after", "measured.count", "measured.method", "measured.window"]);
});

test("a line run's card carries its recommendation and its proof; an older stored card still reads (tc-40, tc-41, tc-43)", () => {
  const fields = (v: ReturnType<typeof validateProposalCard>) => (v.ok ? [] : v.errors.map((e) => e.split(":")[0]).sort());
  expect(validateProposalCard(good).ok).toBe(true);
  expect(fields(validateProposalCard(good, { line: true }))).toEqual(["proof", "recommend"]);
  const full = { ...good, recommend: { verdict: "build", why: "10 of 214 introductions in 60 days show it." }, proof: { rung: "unit", outcome: "red" }, measured: { count: 10, of: 214, window: "introductions, last 60 days", method: "production-read" } };
  expect(validateProposalCard(full, { line: true }).ok).toBe(true);
});

test("a proposal that reverses an earlier card names it (tc-41 reversed tc-30)", () => {
  const overturns = { ref: "tc-30", by: "Earlier proposal", what: "Cancel older queued notes", why: "8 of 10 late replies carried a real answer" };
  expect(validateProposalCard({ ...good, overturns }).ok).toBe(true);
  const v = validateProposalCard({ ...good, overturns: { ...overturns, ref: "the earlier one", what: "" } });
  expect(v.ok ? [] : v.errors.map((e) => e.split(":")[0]).sort()).toEqual(["overturns.ref", "overturns.what"]);
});
