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
// spot with its answers right under them; a chat with that session; and the
// full proposal folded below. A structured card leads with the card's top.

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
  IS_REACT_ACT_ENVIRONMENT: true,
});

// No server: every query is still loading, every mutation exists. Keep the other exports real.
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => undefined, useConvex: () => ({ query: async () => null, mutation: async () => null }) }));
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

test("leads with the session's words and its answers, chat beside, full proposal folded", async () => {
  const decision = decisionRow();
  const { container, unmount } = await mount(<LineDecisionBody decision={decision} detail={detailOf(decision)} answerable source="AgentWatch" />);
  const head = container.querySelector(".ld-head")!;
  expect(head.querySelector("[data-line-decision-problem]")!.textContent).toBe("ct-100");
  expect(head.textContent).toContain("Rep promises replies that never come");
  expect(head.textContent).toContain("AgentWatch");
  expect(head.querySelector("[data-line-decision-asker]")!.textContent).toContain("Fix run for ct-100");
  expect(container.querySelector("[data-line-decision]")!.hasAttribute("data-trial")).toBe(false);

  const sweet = container.querySelector("[data-line-decision-sweet]")!;
  expect(sweet.querySelector("[data-line-decision-question]")!.textContent).toBe("Ship the honest-reply change?");
  expect(sweet.querySelector("blockquote")!.textContent).toContain("They'll get back to you today.");
  expect(sweet.querySelector("table")).not.toBeNull();
  // The session's own options, then a typed answer that goes to the session.
  const answers = sweet.querySelector("[data-line-decision-answers]")!;
  expect(answers.textContent).toContain("Ship it");
  expect(answers.textContent).toContain("Try a softer wording");
  expect(answers.textContent!.toLowerCase()).toContain("own words");

  expect(container.querySelector("[data-line-decision-talk]")).not.toBeNull();
  const full = container.querySelector("details[data-line-decision-full]") as HTMLDetailsElement;
  expect(full.open).toBe(false);
  expect(full.textContent).toContain("Every file the change touches.");
  // The sweet spot never repeats the full proposal.
  expect(sweet.textContent).not.toContain("Every file the change touches.");
  unmount();
});

test("a trial run's decision is marked and says nothing ships", async () => {
  useInboxStore.setState({ trialProjects: { p1: { _id: "p1", workspace: "user:u1", title: "AgentWatch", since: 0 } } } as any);
  const decision = decisionRow({ trial: true });
  const { container, unmount } = await mount(<LineDecisionBody decision={decision} detail={detailOf(decision)} answerable />);
  expect(container.querySelector("[data-line-decision]")!.hasAttribute("data-trial")).toBe(true);
  expect(container.querySelector("[data-line-decision-trial-note]")!.textContent).toContain("nothing ships");
  unmount();
});

test("a decision with no short context leads with its doc, and has nothing left to fold", async () => {
  const decision = decisionRow({ context_md: undefined });
  const { container, unmount } = await mount(<LineDecisionBody decision={decision} detail={detailOf(decision, "The plan, in the session's words.")} answerable />);
  expect(container.querySelector("[data-line-decision-context]")!.textContent).toContain("The plan, in the session's words.");
  expect(container.querySelector("[data-line-decision-full]")).toBeNull();
  unmount();
});

test("a structured card leads with the card's top; the whole card folds into the full proposal", async () => {
  const decision = decisionRow({ card, context_md: undefined, options: CARD_DECISION_OPTIONS.map((o) => ({ ...o })), gate_node_id: "card" });
  const { container, unmount } = await mount(<LineDecisionBody decision={decision} detail={detailOf(decision, null)} answerable />);
  const sweet = container.querySelector("[data-line-decision-sweet]")!;
  expect(sweet.querySelector("[data-card-headline]")!.textContent!.length).toBeGreaterThan(10);
  expect(sweet.querySelector(".ccd-today")!.textContent).toContain(card.wrong);
  expect(sweet.querySelector("[data-line-decision-answers]")).not.toBeNull();
  expect(container.querySelector("[data-line-decision-full]")).not.toBeNull();
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
