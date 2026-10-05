import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { CARD_DECISION_OPTIONS, suiteGateCheck, SUITE_GATE_CHECK, type ChangeCard } from "@codecast/shared/contracts/changeCard";

// A decision about a change card (LE11) draws the card natively and answers
// Ship, Revise or Drop with the keys; Revise carries a note.
mock.module("../../tools/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/questions" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  KeyboardEvent: dom.window.KeyboardEvent,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ChangeCardView, ChangeCardHeadline, exampleInputAdds, cardOutcome } = await import("../ChangeCardView");
const { DecisionAnswerControls } = await import("../DecisionAnswerControls");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const card: ChangeCard = JSON.parse(readFileSync(join(import.meta.dir, "../../../../shared/contracts/__fixtures__/changeCard/card.json"), "utf-8"));
const decision: any = { _id: "d1", conversation_id: "c1", session_id: "s1", question: card.cause.title, options: CARD_DECISION_OPTIONS.map((o) => ({ ...o })), blocking: true, status: "pending", created_at: 0, card };

async function mount(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<MemoryRouter>{ui}</MemoryRouter>));
  return { container, unmount: () => act(() => root.unmount()) };
}
const press = (key: string, target: EventTarget = window) =>
  act(() => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })); });

test("the full card draws every section from the contract", async () => {
  const { container, unmount } = await mount(<ChangeCardView card={card} />);
  const text = container.textContent!;
  expect(text).toContain("ct-56301");
  // The cause's facts read "14 signals · first seen …": each carries its
  // separator inside a clipped row, so the one opening a line never shows.
  const metas = container.querySelectorAll(".cc-cause-facts .cc-seprow-item");
  expect(Array.from(metas).every((m) => m.firstElementChild?.classList.contains("cc-sep"))).toBe(true);
  // The head's one order: the change, then the cause led by its task id as
  // plain text (no box), then two facts: signals with their sources, and age
  // with the goal as one, so a narrow card spends one line.
  const head = container.querySelector(".cc-head")!;
  expect(head.firstElementChild!.textContent).toBe(card.change);
  expect(container.querySelector(".cc-cause-head > .cc-cause-ref")!.textContent).toBe(card.cause.task);
  expect(container.querySelector(".cc-wrong-label")!.textContent).toBe("What is wrong");
  expect(metas).toHaveLength(2);
  expect(metas[0].textContent).toContain(`${card.cause.signals} signals from ${card.cause.sources[0]}`);
  expect(metas[1].textContent).toMatch(/first seen .* · serves /);
  // No kicker: the card opens on what was wrong, muted, then the proof.
  expect(container.querySelector("[data-cc-head]")).toBeNull();
  expect(container.querySelector(".cc-leadin")).toBeNull();
  // The recommendation is the caption the answer row wears, at the card's foot.
  expect(container.querySelector("article > [data-cc-recommended]")!.textContent).toBe(`Ship recommended: ${card.recommend.why}`);
  expect(text).toContain(card.goal.name);
  expect(text).toContain(card.wrong);
  expect(text).toContain(card.change);
  // The proof heading says the one sentence every surface uses.
  expect(container.querySelector(".cc-proof-label")!.textContent).toBe("4 of 4 cases fixed");
  // The heading draws the same dots the queue does, one per case, red then green.
  const dots = container.querySelector("[data-cc-proof] .cc-label-row [data-cc-proof-dots]")!;
  expect(dots.querySelectorAll(".cc-proof-dot")).toHaveLength(8);
  expect(dots.querySelectorAll(".cc-proof-dot[data-ok]")).toHaveLength(4);
  // Each fixed case is a row of its own, a red to green pair and its name, no lead word.
  expect(container.querySelectorAll(".cc-proof-row")).toHaveLength(4);
  expect(container.querySelectorAll("[data-cc-proof-fixed] .cc-proof-fixed-name")).toHaveLength(4);
  expect(container.querySelector(".cc-proof-fixed-lead")).toBeNull();
  // Two pairs at every width; the rest are a click away, behind a toggle
  // that names what it opens with one count.
  expect(container.querySelectorAll(".cc-example")).toHaveLength(2);
  const more = container.querySelector("[data-cc-more]") as HTMLButtonElement;
  expect(more.textContent).toBe("1 more example");
  await act(() => { more.click(); });
  expect(container.querySelectorAll(".cc-example")).toHaveLength(3);
  expect(container.querySelector("[data-cc-more]")).toBeNull();
  // Names only, no suite prefix and no legend: the full name and the
  // before and after values wait on hover.
  expect(container.querySelector(".cc-proof-prefix")).toBeNull();
  expect(container.querySelector("[data-cc-proof-legend]")).toBeNull();
  expect(container.querySelector("[data-cc-proof-values]")).toBeNull();
  expect(container.querySelector("[data-cc-proof-fixed] [title]")!.getAttribute("title")).toContain("12 of 12 pass");
  // The goal is one muted line in the cause header; every section and fact is named one way.
  expect(container.querySelector(".cc-goal")!.textContent).toContain(`serves ${card.goal.name}`);
  expect(Array.from(container.querySelectorAll(".cc-label")).map((k) => k.textContent)).toEqual(["What is wrong", "Proof", "Examples", "Checks", "Diff", "Risk", "Cost"]);
  // Passing checks fold into a count in the facts and open on a click.
  // The proof counts as one of them, so every surface says one number.
  expect(container.querySelector("[data-cc-checks]")!.textContent).toBe("4 of 4 pass");
  // Diff counts are neutral ink, never the proof's red and green.
  expect(container.querySelector(".cc-diff")!.closest(".cc-text-green, .cc-text-red")).toBeNull();
  expect(container.querySelector(".cc-diff .cc-text-green, .cc-diff .cc-text-red")).toBeNull();
  expect(container.querySelector(".cc-checks")).toBeNull();
  await act(() => { (container.querySelector("[data-cc-checks]") as HTMLButtonElement).click(); });
  expect(container.querySelectorAll(".cc-check")).toHaveLength(4);
  expect(text).toContain("PR #912");
  // Every risk leads with its level in its tone, the reason under it.
  expect(container.querySelector(".cc-risk")!.textContent).toBe("Low risk");
  expect(container.querySelector(".cc-risk .cc-text-green")).toBeTruthy();
  expect(container.querySelector(".cc-risk-reason")!.textContent).toBe(card.risk.reason);
  expect(text).toContain("$1.96");
  await unmount();
}, 30_000); // the first mount pays for loading the store under a loaded machine

test("a still red row says so once, and a card under its page's title names what is wrong", async () => {
  const red: ChangeCard = { ...card, proof: { before: [{ name: "drafter · two venues", ok: false, detail: "fails before the change" }, { name: "drafter · no venue", ok: false, detail: "fails before the change" }], after: [{ name: "drafter · two venues", ok: false, detail: "picks the thread venue" }, { name: "drafter · no venue", ok: false, detail: "still fails after the change" }] } };
  const { container, unmount } = await mount(<ChangeCardView card={red} change={false} />);
  const details = Array.from(container.querySelectorAll(".is-red .cc-proof-detail")).map((d) => d.textContent);
  expect(details).toEqual(["still fails: picks the thread venue", "still fails"]);
  expect(container.querySelector(".is-red .cc-arrow")).toBeNull();
  // The heading's dots read red to green from left to right; no legend repeats them.
  expect(container.querySelector("[data-cc-proof-legend]")).toBeNull();
  expect(Array.from(container.querySelectorAll(".cc-label")).map((k) => k.textContent).slice(0, 2)).toEqual(["What is wrong", "Proof"]);
  await unmount();
});

test("a failed suite gate shows unfolded in the checks, naming its scenarios", async () => {
  const gated: ChangeCard = { ...card, checks: [...card.checks, suiteGateCheck(["handoff-keeps-owner", "dup-merge-keeps-newest"])], recommend: { verdict: "revise", why: "Two suite scenarios fail." } };
  const { container, unmount } = await mount(<ChangeCardView card={gated} />);
  expect(container.querySelector("[data-cc-checks]")!.textContent).toContain("1 of 5 fail");
  const row = Array.from(container.querySelectorAll(".cc-check")).find((r) => r.textContent!.includes(SUITE_GATE_CHECK))!;
  expect(row.querySelector(".cc-tone-red")).toBeTruthy();
  expect(row.textContent).toContain("handoff-keeps-owner, dup-merge-keeps-newest");
  await unmount();
});

test("an answerable surface says the recommendation once, on the control", async () => {
  const { container, unmount } = await mount(<><ChangeCardView card={card} recommend={false} /><DecisionAnswerControls decision={decision} onAnswer={() => {}} /></>);
  expect(container.querySelector("article [data-cc-recommended]")).toBeNull();
  // The button wears a ring and stays one word; the line above the row says which and why.
  expect(container.querySelector("[data-verdict=ship]")!.textContent).toBe("Ship");
  const ship = container.querySelector("[data-verdict=ship]")!;
  expect(ship.classList.contains("is-recommended")).toBe(true);
  expect(ship.textContent).toBe("Ship");
  const why = container.querySelector("[data-cc-recommended]")!;
  expect(why.textContent).toBe(`Ship recommended: ${card.recommend.why}`);
  // Verdict, then the action: the recommendation comes before the buttons.
  expect(why.compareDocumentPosition(container.querySelector(".cc-verdicts")!) & 4).toBeTruthy();
  await unmount();
});

test("an example input shows only when its Before does not already quote it", () => {
  // A Before that is a run of the input only repeats it, so the input is dropped.
  expect(exampleInputAdds(card.examples[0].input, card.examples[0].before)).toBe(false);
  expect(exampleInputAdds("fix the bug", "Fix the bug.")).toBe(false);
  expect(exampleInputAdds("the deploy fails after the bun upgrade", "Railway deploy is broken")).toBe(true);
});

test("a settled card says what happened in place of the recommendation", async () => {
  const answered = { ...decision, status: "answered", answer_index: 0, resolved_at: Date.now() - 47 * 60_000 };
  const outcome = cardOutcome(answered, "Ashot", Date.now())!;
  expect(outcome.pill).toBe("Shipped by Ashot · 47m ago");
  expect(outcome.verdict).toBe("Shipped");
  expect(outcome.tone).toBe("green");
  const { container, unmount } = await mount(<ChangeCardView card={card} outcome={outcome.line} />);
  expect(container.querySelector("article [data-cc-recommended]")).toBeNull();
  expect(container.querySelector("[data-cc-outcome]")!.textContent).toContain("Shipped");
  await unmount();
  const revised = cardOutcome({ ...answered, answer_index: 1, answer_text: "Revise: keep the greeting" }, "Ashot", Date.now())!;
  expect(revised.pill.startsWith("Sent back to revise by Ashot")).toBe(true);
  expect(cardOutcome({ ...decision }, "Ashot", Date.now())).toBeNull();
});

test("a withdrawn or dismissed card ends on that, muted, not on the recommendation", async () => {
  const withdrawn = cardOutcome({ ...decision, status: "withdrawn", resolved_at: Date.now() - 9 * 60_000 }, "Ashot", Date.now())!;
  expect(withdrawn.pill).toBe("Withdrawn by the agent · 9m ago");
  expect(withdrawn.tone).toBe("dim");
  const { container, unmount } = await mount(<ChangeCardView card={card} outcome={withdrawn.line} />);
  expect(container.querySelector("article [data-cc-recommended]")).toBeNull();
  expect(container.querySelector("[data-cc-outcome]")!.textContent).toContain("Withdrawn");
  await unmount();
  const dismissed = cardOutcome({ ...decision, status: "dismissed", resolved_at: Date.now() - 5 * 60_000, answered_by: { kind: "user", id: "u1" } }, "Ashot", Date.now())!;
  expect(dismissed.pill).toBe("Dismissed by Ashot · 5m ago");
});

test("the verdict bar leads with the answer on record", async () => {
  const answered = { ...decision, blocking: false, status: "answered", answer_index: 2, resolved_at: Date.now() - 5 * 3600_000 };
  const outcome = cardOutcome(answered, "Ashot", Date.now())!;
  const { container, unmount } = await mount(<DecisionAnswerControls decision={answered} onAnswer={() => {}} record={outcome.pill} />);
  expect(container.querySelector("[data-cc-course]")!.textContent).toBe("Dropped by Ashot · 5h ago. Pick another to change course.");
  await unmount();
});

test("every surface heads a card the same way: the change, the question under it, then the cause", async () => {
  const { container, unmount } = await mount(<ChangeCardHeadline card={card} question="[test] change card render" />);
  expect(container.querySelector("h1")!.textContent).toBe(card.change);
  expect(container.querySelector("[data-card-question]")!.textContent).toBe("[test] change card render");
  // The cause follows the change, never leads it.
  const head = container.querySelector(".cc-head")!;
  expect(head.firstElementChild!.tagName).toBe("H1");
  expect(head.querySelector(".cc-cause")).toBeTruthy();
  await unmount();
  const same = await mount(<ChangeCardHeadline card={card} question={card.change} />);
  expect(same.container.querySelector("[data-card-question]")).toBeNull();
  await same.unmount();
});

test("a page that leads with the change draws the card without its head", async () => {
  const { container, unmount } = await mount(<ChangeCardView card={card} change={false} />);
  expect(container.querySelector(".cc-change")).toBeNull();
  expect(container.querySelector(".cc-cause")).toBeNull();
  expect(container.textContent).toContain(card.wrong);
  await unmount();
});

test("the line is one dense proof summary", async () => {
  const { container, unmount } = await mount(<ChangeCardView card={card} density="line" />);
  // The line is proof, checks and risk; the diff lives on the full card.
  expect(container.textContent).not.toContain(`${card.diff.added}`);
  // The proof reads as evidence, green when every failing case now passes,
  // and named apart from the card's own checks.
  const proof = container.querySelector("[data-cc-line-proof]")!;
  expect(proof.textContent).toBe("4 of 4 cases fixed");
  expect(proof.classList.contains("cc-text-green")).toBe(true);
  expect(container.textContent).toContain("4 checks pass");
  expect(container.textContent).toContain("recommends Ship");
  expect(container.textContent).not.toContain("$1.96");
  await unmount();
});

test("the queue row says which answer is suggested, and draws Ship back while a case still fails", async () => {
  const red = { ...card, proof: { before: card.proof.before, after: card.proof.after.map((c, i) => (i === 0 ? { ...c, ok: false } : c)) }, recommend: { ...card.recommend, verdict: "revise" as const } };
  const { container, unmount } = await mount(<DecisionAnswerControls decision={{ ...decision, card: red }} onAnswer={() => {}} size="line" />);
  expect(container.querySelector("[data-verdict=revise] [data-cc-suggested]")!.textContent).toBe("suggested");
  expect(container.querySelector("[data-verdict=ship]")!.classList.contains("is-weak")).toBe(true);
  expect(container.querySelectorAll("[data-cc-suggested]")).toHaveLength(1);
  await unmount();
  // A clean proof that recommends Ship keeps Ship at full weight.
  const clean = await mount(<DecisionAnswerControls decision={decision} onAnswer={() => {}} size="line" />);
  expect(clean.container.querySelector("[data-verdict=ship]")!.classList.contains("is-weak")).toBe(false);
  expect(clean.container.querySelector("[data-verdict=ship] [data-cc-suggested]")).toBeTruthy();
  await clean.unmount();
});

test("an advisory card marks the course the agent took on its button, not in red", async () => {
  const advisory = { ...decision, blocking: false, default_option: 2 };
  const { container, unmount } = await mount(<DecisionAnswerControls decision={advisory} onAnswer={() => {}} />);
  const drop = container.querySelector("[data-verdict=drop]")!;
  expect(drop.classList.contains("is-taken")).toBe(true);
  // One word and a check, so every button keeps one line and one height.
  // Said once, in words above the row: the button itself stays plain.
  expect(drop.textContent).toBe("Drop");
  expect(drop.querySelector(".cc-verdict-check")).toBeNull();
  expect(container.querySelector("[data-cc-course] .cc-course-verdict")!.textContent).toBe("Drop");
  expect(container.querySelector("[data-cc-course] .cc-text-red")).toBeNull();
  await unmount();
});

test("the queue row draws Ship, Revise and Drop as bare chips", async () => {
  const advisory = { ...decision, blocking: false, default_option: 2 };
  const answers: any[] = [];
  const { container, unmount } = await mount(<DecisionAnswerControls decision={advisory} onAnswer={(a) => answers.push(a)} onDismiss={() => {}} size="line" keys />);
  expect(container.querySelector("[data-cc-course]")).toBeNull();
  expect(container.querySelector(".cc-why")).toBeNull();
  expect(container.querySelector(".cc-dismiss")).toBeNull();
  expect(Array.from(container.querySelectorAll("[data-verdict]")).map((b) => b.textContent)).toEqual(["1Ship", "2Revise", "3Drop"]);
  expect(container.querySelector("[data-verdict=drop]")!.classList.contains("is-taken")).toBe(true);
  // Under a list cursor a digit only selects; return commits, escape lets go.
  await press("1");
  expect(answers).toEqual([]);
  expect(container.querySelector("[data-verdict=ship]")!.classList.contains("is-armed")).toBe(true);
  expect(container.querySelector("[data-cc-armed]")!.textContent).toContain("Ship");
  await press("Escape");
  expect(container.querySelector("[data-cc-armed]")).toBeNull();
  await press("1");
  await press("Enter");
  expect(answers).toEqual([{ index: 0 }]);
  await unmount();
});

test("on the queue row x selects dismiss and return commits it", async () => {
  let dismissed = 0;
  const { container, unmount } = await mount(<DecisionAnswerControls decision={decision} onAnswer={() => {}} onDismiss={() => { dismissed++; }} size="line" keys />);
  await press("x");
  expect(dismissed).toBe(0);
  expect(container.querySelector("[data-cc-armed]")!.textContent).toContain("close without answering");
  await press("Enter");
  expect(dismissed).toBe(1);
  await unmount();
});

test("1 ships, 3 drops, 2 opens a note that return sends as Revise", async () => {
  const answers: any[] = [];
  const { container, unmount } = await mount(<DecisionAnswerControls decision={decision} onAnswer={(a) => answers.push(a)} keys />);
  expect(Array.from(container.querySelectorAll("[data-verdict]")).map((b) => b.getAttribute("data-verdict"))).toEqual(["ship", "revise", "drop"]);
  await press("1");
  await press("3");
  expect(answers).toEqual([{ index: 0 }, { index: 2 }]);
  await press("2");
  const note = container.querySelector("textarea")!;
  expect(note).toBeTruthy();
  await press("Enter", note);
  expect(answers).toHaveLength(2); // an empty note is not a Revise
  await act(() => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(note, "keep the greeting rule, drop the length cap");
    note.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await press("Enter", note);
  expect(answers[2]).toEqual({ index: 1, text: "Revise: keep the greeting rule, drop the length cap" });
  await unmount();
});

test("under a verdict bar the proof heading is a quiet label; the bar says the numbers", async () => {
  const { container, unmount } = await mount(<ChangeCardView card={card} change={false} recommend={false} summarized />);
  expect(container.querySelector("[data-cc-proof] .cc-proof-label")).toBeNull();
  expect(container.querySelector("[data-cc-proof] .cc-label")!.textContent).toBe("Proof");
  // The bar says the counts, so the card holds only their detail: the dots
  // and case rows, the check list with no count and no Proof row (the Proof
  // section is right above it), and the risk's reason with no level.
  expect(container.querySelector("[data-cc-proof] [data-cc-proof-dots]")).not.toBeNull();
  expect(container.textContent).not.toContain("all 4 fixed");
  expect(container.querySelector("[data-cc-checks]")).toBeNull();
  expect(Array.from(container.querySelectorAll(".cc-check")).map((r) => r.querySelector(".text-sol-text")!.textContent)).toEqual(card.checks.map((c) => c.name));
  expect(container.querySelector(".cc-fact-risk dd")!.textContent).toBe(card.risk.reason);
  await unmount();
  // An empty strip has no rows to stand for it, so it still says so, once.
  const bare: ChangeCard = { ...card, proof: { before: [], after: [] } };
  const empty = await mount(<ChangeCardView card={bare} summarized />);
  expect(empty.container.querySelector(".cc-proof-label")!.textContent).toBe("No proof recorded");
  expect(empty.container.textContent).not.toContain("Nothing was shown failing");
  await empty.unmount();
});

test("the line wraps through SepRow and says risk in plain words", async () => {
  const risky: ChangeCard = { ...card, risk: { class: "plan", reason: "Schema migration." } };
  const { container, unmount } = await mount(<ChangeCardView card={risky} density="line" />);
  const row = container.querySelector(".cc-line-row")!;
  expect(row.classList.contains("cc-seprow")).toBe(true);
  expect(row.querySelector(".cc-sep-before")).toBeNull();
  expect(row.textContent).toContain("High risk");
  expect(row.textContent).not.toContain("needs its own plan");
  await unmount();
  const full = await mount(<ChangeCardView card={risky} />);
  expect(full.container.querySelector(".cc-fact-risk")!.textContent).toContain("High risk: needs its own plan");
  expect(full.container.querySelector(".cc-risk-reason")!.textContent).toBe("Schema migration.");
  await full.unmount();
});

test("an advisory card's queue chips say which course the agent took", async () => {
  const advisory = { ...decision, blocking: false, default_option: 2 };
  const { container, unmount } = await mount(<DecisionAnswerControls decision={advisory} onAnswer={() => {}} size="line" />);
  expect(container.querySelector("[data-cc-course-short]")!.textContent).toBe("Agent goes with Drop unless you pick");
  await unmount();
  const blocking = await mount(<DecisionAnswerControls decision={decision} onAnswer={() => {}} size="line" />);
  expect(blocking.container.querySelector("[data-cc-course-short]")).toBeNull();
  await blocking.unmount();
});

test("one failure count: a check whose words report a failure is red, and Ship's badge says the Checks cell's number", async () => {
  const red: ChangeCard = {
    ...card,
    proof: { before: card.proof.before, after: card.proof.after.map((c, i) => (i === 3 ? { ...c, ok: false, detail: "drops the plan" } : c)) },
    checks: [{ name: "Verify", ok: true, detail: "bun test: 11 pass, 1 fail." }, ...card.checks.slice(1)],
    recommend: { verdict: "revise", why: "One case still fails." },
  };
  const { container, unmount } = await mount(<><ChangeCardView card={red} /><DecisionAnswerControls decision={{ ...decision, card: red }} onAnswer={() => {}} /></>);
  expect(container.querySelector("[data-cc-checks]")!.textContent).toBe("2 of 4 fail");
  const verify = Array.from(container.querySelectorAll(".cc-check")).find((r) => r.textContent!.includes("Verify"))!;
  expect(verify.querySelector(".cc-tone-red")).toBeTruthy();
  const ship = container.querySelector("[data-verdict=ship]")!;
  expect(ship.classList.contains("is-weak")).toBe(true);
  expect(ship.querySelector("[data-cc-fails]")!.textContent).toBe("2 checks fail");
  // Three fixed rows and the still red one, each on its own line.
  expect(container.querySelectorAll(".cc-proof-row")).toHaveLength(4);
  expect(container.querySelectorAll(".cc-proof-row.is-red")).toHaveLength(1);
  await unmount();
});

test("a lone fixed case keeps its own before and after values on its line", async () => {
  const one: ChangeCard = { ...card, proof: { before: [{ name: "merge · rows follow survivor", ok: false, detail: "3 orphans" }], after: [{ name: "merge · rows follow survivor", ok: true, detail: "0 orphans" }] } };
  const { container, unmount } = await mount(<ChangeCardView card={one} />);
  expect(container.querySelector("[data-cc-proof-values]")!.textContent).toBe("3 orphans → 0 orphans");
  expect(container.querySelector(".cc-proof-fixed-name")!.textContent).toContain("rows follow survivor");
  await unmount();
});

test("keycaps show only while focus is inside a scoped card, and the card wears the ring", async () => {
  const scope = { current: null as HTMLDivElement | null };
  const { container, unmount } = await mount(<div ref={(el) => { scope.current = el; }} tabIndex={-1} data-scope><DecisionAnswerControls decision={decision} onAnswer={() => {}} keys keyScope={scope} /></div>);
  expect(container.querySelector("[data-verdict=ship] kbd")).toBeNull();
  await act(() => { (container.querySelector("[data-scope]") as HTMLElement).focus(); });
  expect(container.querySelector("[data-verdict=ship] kbd")!.textContent).toBe("1");
  expect(container.querySelector("[data-scope]")!.hasAttribute("data-keys-live")).toBe(true);
  await unmount();
});

test("a goal named only by its key is said in words, and the generic signal kind is not a source", async () => {
  const keyed: ChangeCard = { ...card, goal: { ...card.goal, ref: "sd7dqnq9hny1dtzy83as2av4z18c9z2z", name: "sd7dqnq9hny1dtzy83as2av4z18c9z2z" }, cause: { ...card.cause, signals: 1, sources: ["signal"] } };
  const { container, unmount } = await mount(<ChangeCardView card={keyed} />);
  const facts = container.querySelector(".cc-cause-facts")!.textContent!;
  expect(facts).not.toContain("sd7dqnq9hny1dtzy83as2av4z18c9z2z");
  expect(facts).toContain("serves a project in another workspace");
  expect(facts).toContain("1 signal");
  expect(facts).not.toContain("from signal");
  await unmount();
});
