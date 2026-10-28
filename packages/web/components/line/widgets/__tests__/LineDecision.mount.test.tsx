import { afterAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mock } from "bun:test";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";
import { CARD_DECISION_OPTIONS, type ChangeCard } from "@codecast/shared/contracts/changeCard";
import { openFixDecisionFor, openFixDecisions } from "../../../../lib/line/fixDecision";

// The line's fix decision (LineDecision): a header naming the problem, the
// project and the session that asked; the session's own words as the sweet
// spot; its answers pinned to the foot of the pane, the run's recommended one
// marked; a chat with that session under what it last said; and the full
// proposal folded below. A structured card leads with the card's top.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/line?view=inbox&decision=sd-9" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  // The chat's composer (the shared comment composer) measures and watches itself.
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: dom.window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});

// No server: every query is still loading, every mutation exists. Keep the other exports real.
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => undefined, useAction: () => async () => null, useConvex: () => ({ query: async () => null, mutation: async () => null }) }));
const noThrow = await import("../../../../hooks/useQueryNoThrow");
mock.module("../../../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined }) }));
mock.module("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a> }));

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { useInboxStore } = await import("../../../../store/inboxStore");
const { LineDecisionBody } = await import("../LineDecision");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const card: ChangeCard = JSON.parse(readFileSync(join(import.meta.dir, "../../../../../shared/contracts/__fixtures__/changeCard/card.json"), "utf-8"));

beforeEach(() => {
  useInboxStore.setState({
    currentUser: { _id: "u1", name: "Ashot" },
    sessions: { c1: { _id: "c1", title: "Fix run for ct-100", project_path: "/Users/x/src/codecast", status: "running" } },
    projects: { p1: { _id: "p1", title: "AgentWatch" } },
    trialProjects: {},
  } as any);
});

async function mount(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<MemoryRouter>{ui}</MemoryRouter>));
  return { container, unmount: () => act(() => root.unmount()) };
}

const CONTEXT = [
  "The rep stops promising a reply the third party never sent.",
  "",
  "> Before: \"They'll get back to you today.\"",
  "",
  "| | Before | After |",
  "|---|---|---|",
  "| Replies | 4 | 0 |",
].join("\n");

const decisionRow = (over: Record<string, unknown> = {}): any => ({
  _id: "d9", short_id: "sd-9", conversation_id: "c1", question: "Ship the honest-reply change?",
  options: [{ label: "Ship it" }, { label: "Try a softer wording" }], blocking: true, status: "pending", created_at: Date.now() - 60_000,
  task_id: "t100", workflow_run_id: "run1", context_md: CONTEXT, ...over,
});
const detailOf = (decision: any, doc: string | null = "## Full plan\n\nEvery file the change touches."): any => ({
  _id: decision._id, decision, doc: doc ? { _id: "doc1", content: doc } : null,
  task: { _id: "t100", short_id: "ct-100", title: "Rep promises replies that never come", project_id: "p1" },
  stack: null, ladder: [], asked_users: [], holder_role: null, grant_offer: null, grant: null,
});

test("leads with the session's words, answers pinned at the foot, the session beside, full proposal folded", async () => {
  const decision = decisionRow();
  const { container, unmount } = await mount(<LineDecisionBody decision={decision} detail={detailOf(decision)} answerable source="AgentWatch" />);
  const head = container.querySelector(".ld-head")!;
  expect(head.querySelector("[data-line-decision-problem]")!.textContent).toBe("ct-100");
  expect(head.textContent).toContain("Rep promises replies that never come");
  expect(head.textContent).toContain("AgentWatch");
  // A fix run's session is named by what it is: its own title is a pipeline step's name.
  expect(head.querySelector("[data-line-decision-asker]")!.textContent).toContain("The session presenting this fix");
  expect(container.querySelector("[data-line-decision]")!.hasAttribute("data-trial")).toBe(false);

  const sweet = container.querySelector("[data-line-decision-sweet]")!;
  expect(sweet.querySelector("[data-line-decision-question]")!.textContent).toBe("Ship the honest-reply change?");
  // The session's own words lead, before and after included (read as text: other files in a run stub the markdown renderer).
  const context = sweet.querySelector("[data-line-decision-context]")!.textContent!;
  expect(context).toContain("The rep stops promising a reply");
  expect(context).toContain("They'll get back to you today.");
  expect(context).toContain("Replies");
  // The session's own options, then a typed answer that goes to the session: pinned to the pane's foot, never inside the scroll.
  expect(sweet.querySelector("[data-line-decision-answers]")).toBeNull();
  const answers = container.querySelector("[data-line-decision-dock] [data-line-decision-answers]")!;
  expect(answers.textContent).toContain("Ship it");
  expect(answers.textContent).toContain("Try a softer wording");
  expect(answers.textContent!.toLowerCase()).toContain("own words");

  // With nothing said yet the chat is one line naming the session; opening it shows the session for what it is, with its
  // state and a way to open it. What it said before asking waits behind one button: never the session's working notes.
  expect(container.querySelector("[data-line-decision-talk]")).toBeNull();
  const openTalk = container.querySelector("[data-line-decision-talk-open]") as HTMLButtonElement;
  expect(openTalk.textContent).toContain("the session presenting this fix");
  // Asking sits with the answers in the dock, in view at every scroll, never only at the end of the words.
  expect(openTalk.closest("[data-line-decision-dock]")).not.toBeNull();
  expect(sweet.querySelector("[data-line-decision-talk-open]")).toBeNull();
  await act(async () => { openTalk.click(); });
  const talk = container.querySelector("[data-line-decision-talk]")!;
  expect(talk.querySelector("[data-line-decision-talk-head]")!.textContent).toContain("The session presenting this fix");
  expect(talk.querySelector("[data-line-decision-open-session]")).not.toBeNull();
  expect(talk.querySelector("[data-line-decision-said]")).toBeNull();
  expect(talk.querySelector("[data-line-decision-earlier]")).not.toBeNull();
  // Open, the chat holds the answers under it: asking and answering in one place, no second copy at the foot.
  expect(talk.querySelector("[data-line-decision-answers]")!.textContent).toContain("Ship it");
  expect(container.querySelector("[data-line-decision-dock]")).toBeNull();
  // A fix's answers already hold leaving things as they are: no Dismiss beside them.
  expect(container.textContent).not.toContain("Dismiss");
  // The code is folded under the words, never left out, and read only once opened.
  const code = container.querySelector("details[data-line-decision-code]") as HTMLDetailsElement;
  expect(code.open).toBe(false);
  expect(code.querySelector("summary")!.textContent).toBe("The code");
  const full =container.querySelector("details[data-line-decision-full]") as HTMLDetailsElement;
  expect(full.open).toBe(false);
  expect(full.textContent).toContain("Every file the change touches.");
  // The sweet spot never repeats the full proposal.
  expect(sweet.textContent).not.toContain("Every file the change touches.");
  unmount();
});

test("a trial run's decision asks what you would do, carries its card's proof, and its answer takes it off every list at once", async () => {
  const { trialCardWaits } = await import("../../../../lib/line/lineInbox");
  const decision = decisionRow({ trial: true, question: "Ship this change? Missed-call notes lead with the open intro", options: [{ label: "Ship" }, { label: "Revise" }, { label: "Drop" }] });
  const trialCard = {
    _id: "tc1", workspace: "user:u1", short_id: "tc-58", project_id: "p1", project_title: "AgentWatch", task_id: "t100", task_short_id: "ct-100", task_title: "Rep promises replies", task_status: "open",
    run_id: "run1", run_status: "paused", node_id: "card", kind: "card", question: decision.question, options: [{ key: "S", label: "Ship" }, { key: "R", label: "Revise" }, { key: "D", label: "Drop" }],
    card: {
      ...card, recommend: { verdict: "revise", why: "It reaches too few." }, risk: { class: "review", reason: "About 125 follow-up emails a week change" },
      seen: [{ signal: "sg-1", asked: "Dana, weighing an intro", quote: "Tried you by phone just now.", missing: "The intro waiting on her" }, { signal: "sg-2", asked: "Omar, mid-search", quote: "Sorry we missed you.", missing: "Repeats yesterday's note" }],
      proof: { before: [{ name: "repro", ok: false, detail: "0 pass\n 20 fail" }], after: [{ name: "repro", ok: true, detail: "20 pass\n 0 fail" }] },
      reach: { conversations: 19, of: 20 }, diff: { files: 4, added: 61, removed: 8 }, cost: { tokens: 1, usd: 17.62, minutes: 672 },
    },
    decision: { _id: "d9", short_id: "sd-9", status: "pending", report_slug: null, session: null },
    status: "waiting", created_at: 1, updated_at: 1,
  };
  // The decision's detail is in the store, as the page feeds it: an answer adopts the row from there.
  useInboxStore.setState({ trialCards: { tc1: trialCard }, sessionDecisions: {}, decisionDetails: { d9: detailOf(decision) } } as any);
  const { container, unmount } = await mount(<LineDecisionBody decision={decision} detail={detailOf(decision)} answerable />);
  expect(container.querySelector("[data-line-decision]")!.hasAttribute("data-trial")).toBe(true);
  // Never worded as shipping: the question says what you would do, the answers are the plain verbs with no sentence
  // under them, and "nothing ships" is said once, by the trial mark on the answers.
  expect(container.querySelector("[data-line-decision-question]")!.textContent).toBe("Would you ship this? Missed-call notes lead with the open intro");
  const answers = container.querySelector("[data-line-decision-answers]")!;
  const verdicts = [...answers.querySelectorAll("[data-verdict]")];
  expect(verdicts.map((b) => b.textContent!.trim())).toEqual(["Ship", "Revise", "Drop"]);
  expect(answers.querySelector("[data-line-decision-trial-note]")!.textContent).toContain("Trial");
  // The run's own recommendation is marked on its answer, and only there: the session's words say it, the answers
  // carry only the ring, never a second "recommended" line (and never an evals step the trial does not run).
  expect(verdicts.map((b) => b.classList.contains("is-recommended"))).toEqual([false, true, false]);
  expect(answers.querySelector("[data-cc-recommended]")).toBeNull();
  // Revise asks for the note the builder needs before it answers anything.
  await act(async () => { (answers.querySelector("[data-verdict=revise]") as HTMLButtonElement).click(); });
  expect((useInboxStore.getState() as any).sessionDecisions.d9?.status ?? "pending").not.toBe("answered");
  // Under the session's own words the card adds its numbers only: the case is told once, by the session.
  const band = container.querySelector("[data-line-decision-evidence]")!;
  expect(band.hasAttribute("data-compact")).toBe(true);
  expect(band.querySelector("[data-line-decision-case]")).toBeNull();
  expect(band.textContent).not.toContain("Tried you by phone just now.");
  const proof = band.querySelector("[data-line-decision-proof]")!.textContent!;
  expect(proof).toContain("0/20");
  expect(proof).toContain("20/20");
  expect(proof).toContain("19 of 20");
  expect(proof).toContain("$17.62");
  // A built change says its risk too.
  expect(proof).toContain("About 125 follow-up emails a week change");
  // Answered here, the decision's own row flips at once, and the card waits on nobody: the Inbox row and a run's chip read that row.
  expect(trialCardWaits(trialCard as never)).toBe(true);
  const ship = answers.querySelector("[data-verdict=ship]") as HTMLButtonElement;
  await act(async () => { ship.click(); });
  const live = (useInboxStore.getState() as any).sessionDecisions.d9;
  expect(live?.status).toBe("answered");
  expect(trialCardWaits(trialCard as never, live.status)).toBe(false);
  unmount();
});

test("a decision with no short context leads with its doc, and has nothing left to fold", async () => {
  const decision = decisionRow({ context_md: undefined });
  const { container, unmount } = await mount(<LineDecisionBody decision={decision} detail={detailOf(decision, "The plan, in the session's words.")} answerable />);
  expect(container.querySelector("[data-line-decision-context]")!.textContent).toContain("The plan, in the session's words.");
  expect(container.querySelector("[data-line-decision-full]")).toBeNull();
  unmount();
});

test("a decision with neither context nor doc leads with its published proposal, above the answers", async () => {
  useInboxStore.setState({ trialCards: {} } as any);
  const decision = decisionRow({ context_md: undefined, report_slug: "rep1" });
  const { container, unmount } = await mount(<LineDecisionBody decision={decision} detail={detailOf(decision, null)} answerable />);
  const sweet = container.querySelector("[data-line-decision-sweet]")!;
  const lead = sweet.querySelector("[data-line-decision-report]");
  expect(lead).not.toBeNull();
  expect(lead!.compareDocumentPosition(container.querySelector("[data-line-decision-dock] [data-line-decision-answers]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(container.querySelector("[data-line-decision-full]")).toBeNull();
  unmount();
});

test("a session that wrote its own answers and page reads in its own words: the page in the open, the run's figures folded", async () => {
  const own = [
    { label: "Rework it so the email leads with what is waiting on them", description: "Three wordings opened with the call in 24 of 26 reruns." },
    { label: "Ship the rewrite as built", description: "It changes about 127 emails a week." },
    { label: "Drop the rewrite and keep today's email", description: "Replies run about one in five either way." },
  ];
  const decision = decisionRow({ trial: true, question: "After an unanswered call, what should the email lead with?", options: own, context_md: "248 of 252 recent emails open with the call.", report_slug: "rep1" });
  const trialCard = {
    _id: "tc7", workspace: "user:u1", short_id: "tc-77", project_id: "p1", project_title: "AgentWatch", task_id: "t100", task_short_id: "ct-100", task_title: "Rep promises replies", task_status: "open",
    run_id: "run1", run_status: "paused", node_id: "decide", kind: "card", question: decision.question, options: [{ key: "", label: own[0].label }, { key: "S", label: own[1].label }, { key: "D", label: own[2].label }],
    card: { ...card, recommend: { verdict: "revise", why: "Most still open with the call." } }, decision: { _id: "d9", short_id: "sd-9", status: "pending", report_slug: "rep1", session: null }, status: "waiting", created_at: 1, updated_at: 1,
  };
  useInboxStore.setState({ trialCards: { tc7: trialCard }, sessionDecisions: {}, decisionDetails: {} } as any);
  const { container, unmount } = await mount(<LineDecisionBody decision={decision} detail={detailOf(decision, null)} answerable />);
  const sweet = container.querySelector("[data-line-decision-sweet]")!;
  // The session's words, then its page; nothing the run measured stands in front of them.
  expect(sweet.querySelector("[data-line-decision-context]")!.textContent).toContain("248 of 252");
  expect(sweet.querySelector("[data-line-decision-report]")).not.toBeNull();
  expect(sweet.querySelector("[data-line-decision-evidence]")).toBeNull();
  expect(container.querySelector("details[data-line-decision-full] [data-line-decision-evidence]")).not.toBeNull();
  // Its answers are its own rows, each with what it wrote under it: never the fixed three verbs.
  const answers = container.querySelector("[data-line-decision-dock] [data-line-decision-answers]")!;
  expect(answers.querySelector("[data-verdict]")).toBeNull();
  for (const o of own) { expect(answers.textContent).toContain(o.label); expect(answers.textContent).toContain(o.description); }
  unmount();
  useInboxStore.setState({ trialCards: {} } as any);
});

test("a structured card leads with its words; its tiles, checks and replayed cases fold into the run's record", async () => {
  const decision = decisionRow({ card, context_md: undefined, options: CARD_DECISION_OPTIONS.map((o) => ({ ...o })), gate_node_id: "card" });
  const { container, unmount } = await mount(<LineDecisionBody decision={decision} detail={detailOf(decision, null)} answerable />);
  const sweet = container.querySelector("[data-line-decision-sweet]")!;
  expect(sweet.querySelector("[data-card-headline]")!.textContent!.length).toBeGreaterThan(10);
  expect(sweet.querySelector("[data-line-decision-today]")!.textContent).toBe(card.wrong);
  expect(sweet.querySelector("[data-line-decision-change]")!.textContent).toBe(card.change);
  // Nothing the run measured stands before the words: no tile strip, and its one real case shows what was sent before
  // and after without the prompt input it was replayed from.
  expect(sweet.querySelector(".ccd-tiles, .ccd-tile, .cc-example-input")).toBeNull();
  expect(sweet.querySelectorAll("[data-line-decision-case] .cc-example").length).toBe(1);
  const full = container.querySelector<HTMLDetailsElement>("[data-line-decision-full]")!;
  expect(full.open).toBe(false);
  expect(full.querySelector("summary")!.textContent).toBe("The run's record");
  expect(container.querySelector("[data-line-decision-dock] [data-line-decision-answers]")).not.toBeNull();
  expect(container.querySelector("[data-line-decision-full]")).not.toBeNull();
  unmount();
});

test("a trial decision with no words of its own tells every case the card cites, and a settled one reads its answer in place", async () => {
  const decision = decisionRow({ trial: true, context_md: undefined, question: "Ship this change?", options: [{ label: "Ship" }, { label: "Revise" }, { label: "Drop" }] });
  const trialCard = {
    _id: "tc2", workspace: "user:u1", short_id: "tc-59", project_id: "p1", project_title: "AgentWatch", task_id: "t100", task_short_id: "ct-100", task_title: "Rep promises replies", task_status: "open",
    run_id: "run1", run_status: "paused", node_id: "card", kind: "card", question: decision.question, options: [{ key: "S", label: "Ship" }, { key: "R", label: "Revise" }, { key: "D", label: "Drop" }],
    card: { ...card, examples: [], seen: [{ signal: "sg-1", asked: "Dana, weighing an intro", quote: "Tried you by phone just now.", missing: "The intro waiting on her" }, { signal: "sg-2", asked: "Omar, mid-search", quote: "Sorry we missed you.", missing: "Repeats yesterday's note" }] },
    decision: { _id: "d9", short_id: "sd-9", status: "pending", report_slug: null, session: null }, status: "waiting", created_at: 1, updated_at: 1,
  };
  useInboxStore.setState({ trialCards: { tc2: trialCard }, sessionDecisions: {}, decisionDetails: {} } as any);
  const { container, unmount } = await mount(<LineDecisionBody decision={decision} detail={detailOf(decision, null)} answerable />);
  const band = container.querySelector("[data-line-decision-evidence]")!;
  expect(band.hasAttribute("data-compact")).toBe(false);
  const cases = [...band.querySelectorAll("[data-line-decision-case]")].map((c) => c.textContent!);
  expect(cases).toHaveLength(2);
  expect(cases[0]).toContain("Tried you by phone just now.");
  // The note under a quote is "Missing" only when it names something absent.
  expect(cases[0]).toContain("Problem The intro waiting on her");
  expect(cases[1]).toContain("Sorry we missed you.");
  expect(band.textContent).toContain(trialCard.card.change);
  // Nothing folds that only repeats the boxes above it.
  expect(band.querySelector("[data-line-decision-change]")?.textContent ?? "").not.toContain(trialCard.card.wrong);
  unmount();
  const settled = decisionRow({ status: "answered", answer_index: 0, resolved_at: Date.now() });
  const b = await mount(<LineDecisionBody decision={settled} detail={detailOf(settled)} answerable />);
  expect(b.container.querySelector("[data-line-decision-dock]")).toBeNull();
  b.unmount();
});

test("a session's words that quote no conversation get the card's first real message against what changes, above the numbers", async () => {
  const seen = [{ signal: "sg-1", asked: "Dana, weighing an intro", quote: "Hey Dana, tried reaching you by phone just now.", missing: "The Zibra introduction waiting on her" }, { signal: "sg-2", asked: "Omar", quote: "Sorry we missed you.", missing: "Repeats yesterday's note" }];
  const trialCard = {
    _id: "tc5", workspace: "user:u1", short_id: "tc-69", project_id: "p1", project_title: "AgentWatch", task_id: "t100", task_short_id: "ct-100", task_title: "Rep promises replies", task_status: "open",
    run_id: "run1", run_status: "paused", node_id: "card", kind: "card", question: "Ship this change?", options: [{ key: "S", label: "Ship" }, { key: "D", label: "Drop" }],
    card: { ...card, examples: [], seen }, decision: { _id: "d9", short_id: "sd-9", status: "pending", report_slug: null, session: null }, status: "waiting", created_at: 1, updated_at: 1,
  };
  useInboxStore.setState({ trialCards: { tc5: trialCard }, sessionDecisions: {}, decisionDetails: {} } as any);
  // One paragraph, no quotation: the page still shows a before and after on a real conversation.
  const plain = decisionRow({ trial: true, context_md: "Missed-call follow-ups now lead with the contact's open intro or question." });
  const a = await mount(<LineDecisionBody decision={plain} detail={detailOf(plain)} answerable />);
  const band = a.container.querySelector("[data-line-decision-evidence]")!;
  expect(band.hasAttribute("data-compact")).toBe(true);
  const cases = [...band.querySelectorAll("[data-line-decision-case]")];
  expect(cases).toHaveLength(1);
  expect(cases[0].textContent).toContain("Hey Dana, tried reaching you by phone just now.");
  expect(cases[0].textContent).toContain("The Zibra introduction waiting on her");
  expect(band.querySelector("[data-side='after']")!.textContent).toContain(trialCard.card.change);
  // The pair leads the numbers.
  expect(band.firstElementChild!.className).toBe("ld-ev-pair");
  a.unmount();
  // Words that already quote a conversation are never told twice: the numbers only.
  const quoted = decisionRow({ trial: true });
  const b = await mount(<LineDecisionBody decision={quoted} detail={detailOf(quoted)} answerable />);
  expect(b.container.querySelector("[data-line-decision-evidence] [data-line-decision-case]")).toBeNull();
  expect(b.container.querySelector("[data-line-decision-proof]")).not.toBeNull();
  b.unmount();
});

test("a settled trial decision reads as recorded in the trial's words, never as shipped", async () => {
  const settled = decisionRow({ trial: true, card, question: "Ship this change?", options: [{ label: "Ship" }, { label: "Revise" }, { label: "Drop" }], status: "answered", answer_index: 0, resolved_at: Date.now() - 60_000, answered_by: { kind: "user", id: "u1" } });
  useInboxStore.setState({ trialCards: {}, sessionDecisions: {}, decisionDetails: {} } as any);
  const { container, unmount } = await mount(<LineDecisionBody decision={settled} detail={detailOf(settled)} answerable />);
  const text = container.querySelector("[data-line-decision-answers]")!.textContent!;
  expect(text).toContain("Would ship");
  expect(text).toContain("nothing shipped");
  expect(text).not.toMatch(/\bShipped by\b/);
  unmount();
});

test("a run waiting at a step its line dropped offers no answers: one reason, one act that asks it again", async () => {
  const decision = decisionRow({ trial: true });
  const trialCard = {
    _id: "tc3", workspace: "user:u1", short_id: "tc-64", project_id: "p1", project_title: "AgentWatch", task_id: "t100", task_short_id: "ct-100", task_title: "Rep promises replies", task_status: "open",
    run_id: "run1", run_status: "paused", node_id: "proposal_gate", kind: "gate", question: decision.question, options: [{ key: "A", label: "Build it" }, { key: "R", label: "Revise" }],
    stale_gate: true, decision: { _id: "d9", short_id: "sd-9", status: "pending", report_slug: null, session: null }, status: "waiting", created_at: 1, updated_at: 1,
  };
  useInboxStore.setState({ trialCards: { tc3: trialCard }, sessionDecisions: {}, decisionDetails: {} } as any);
  const { container, unmount } = await mount(<LineDecisionBody decision={decision} detail={detailOf(decision)} answerable />);
  const dock = container.querySelector("[data-line-decision-dock]")!;
  expect(dock.querySelector("[data-option]")).toBeNull();
  // The one act runs from the app: no command to paste. Pressed, it says the run is being asked.
  expect(dock.querySelector("[data-line-decision-reask]")!.textContent).not.toContain("cast line trial");
  const reask = dock.querySelector("[data-line-reask='ct-100']") as HTMLButtonElement;
  expect(reask.textContent).toBe("Re-ask");
  await act(async () => { reask.click(); });
  expect((useInboxStore.getState() as any).trialCards.tc3.reask_at).toBeGreaterThan(0);
  expect(reask.textContent).toBe("Asking again");
  expect(reask.disabled).toBe(true);
  // The session is still there to talk to.
  expect(container.querySelector("[data-line-decision-talk-open]")).not.toBeNull();
  unmount();
});

test("the open fix decision for a problem: pending, asked by a run, newest wins, own row over the line's copy", () => {
  const own: any = { a: { _id: "a", status: "pending", task_id: "t1", workflow_run_id: "r1", created_at: 5 } };
  const line: any = {
    a: { _id: "a", status: "answered", task_id: "t1", workflow_run_id: "r1", created_at: 5 },
    b: { _id: "b", status: "pending", task_id: "t1", workflow_run_id: "r0", created_at: 1 },
    c: { _id: "c", status: "pending", task_id: "t2", created_at: 9 },
    d: { _id: "d", status: "withdrawn", task_id: "t3", workflow_run_id: "r3", created_at: 9 },
  };
  expect(openFixDecisionFor(own, line, "t1")?._id).toBe("a");
  expect(openFixDecisionFor(own, line, "t2")).toBeNull();
  expect(openFixDecisionFor(own, line, "t3")).toBeNull();
  expect(openFixDecisionFor(own, line, null)).toBeNull();
  // Cached by the collections' refs: a selector gets the same map back.
  expect(openFixDecisions(own, line)).toBe(openFixDecisions(own, line));
});

test("a host that names the problem leaves out the head, and hears once when the decision stops waiting", async () => {
  const decision = decisionRow();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const answered: Array<[string, string | null]> = [];
  const onAnswered = (id: string, answer: string | null) => answered.push([id, answer]);
  await act(() => root.render(<MemoryRouter><LineDecisionBody decision={decision} detail={detailOf(decision)} answerable head={false} inline onAnswered={onAnswered} /></MemoryRouter>));
  expect(container.querySelector(".ld-head")).toBeNull();
  expect(container.querySelector(".ld-sub")).toBeNull();
  expect(container.querySelector(".ld.ld-inline")).not.toBeNull();
  expect(answered).toHaveLength(0);
  const done = { ...decision, status: "answered", answer_index: 0, resolved_at: Date.now() };
  await act(() => root.render(<MemoryRouter><LineDecisionBody decision={done as never} detail={detailOf(done as never)} answerable head={false} inline onAnswered={onAnswered} /></MemoryRouter>));
  expect(answered).toHaveLength(1);
  expect(answered[0]).toEqual([decision._id, decision.options[0].label]);
  await act(() => root.render(<MemoryRouter><LineDecisionBody decision={done as never} detail={detailOf(done as never)} answerable head={false} inline onAnswered={onAnswered} /></MemoryRouter>));
  expect(answered).toHaveLength(1);
  await act(() => root.unmount());
});

test("on a host that carries the next act, a withdrawn decision's banner says only its state and when", async () => {
  const base = decisionRow();
  const withdrawn = { ...base, status: "withdrawn", resolved_at: Date.now() - 2 * 86_400_000 } as never;
  const { container, unmount } = await mount(<LineDecisionBody decision={withdrawn} detail={detailOf(withdrawn)} answerable act={false} />);
  const banner = container.querySelector("[data-decision-banner]");
  expect(banner?.querySelector("[data-banner-state]")?.textContent).toMatch(/^Withdrawn before anyone answered it · /);
  expect(banner?.querySelector("a")).toBeNull();
  await unmount();
});

test("a decision its line replaced waits on nobody: it says what replaced it, with no answers to press", async () => {
  const decision = decisionRow();
  const detail = { ...detailOf(decision), superseded: { why: "emptied" } };
  const { container, unmount } = await mount(<LineDecisionBody decision={decision} detail={detail} answerable />);
  expect(container.querySelector("[data-decision-banner]")).not.toBeNull();
  expect(container.querySelector("[data-line-decision-dock]")).toBeNull();
  expect(container.querySelector(".ld-sub [data-tone=wait], .ld-sub [data-tone=ask]")).toBeNull();
  await unmount();
});

test("a gate doc written before the runner stripped its bookkeeping line never shows it", async () => {
  const decision = { ...decisionRow(), context_md: "" };
  const { container, unmount } = await mount(<LineDecisionBody decision={decision} detail={detailOf(decision, "work_state: done\n## The plan\n\nShip the small fix.")} answerable />);
  expect(container.textContent).not.toContain("work_state");
  expect(container.textContent).toContain("Ship the small fix.");
  await unmount();
});


test("a trial's presenting session reads as what it is, never by its station title, even with no run on the row", async () => {
  const decision = decisionRow({ trial: true, workflow_run_id: undefined, session_title: "Card words · ct-100" });
  useInboxStore.setState({ trialCards: {}, sessionDecisions: {}, decisionDetails: {} } as any);
  const { container, unmount } = await mount(<LineDecisionBody decision={decision} detail={detailOf(decision)} answerable />);
  const asker = container.querySelector("[data-line-decision-asker]")!;
  expect(asker.textContent).toContain("The session presenting this fix");
  expect(container.innerHTML).not.toContain("Card words");
  unmount();
});
