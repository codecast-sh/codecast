import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { priorityCardFixture as card } from "../__fixtures__/priorityCard.fixture";

// A priority card is its person's alone and is acted on only through the card
// (isPriorityCard): every decision surface built for a session's own questions
// leaves the session out of it. The cards view files it under Priorities, not
// its session; no line names or links the session; no owner button, bulk verb
// or stack box takes it; the Answered feed draws its record, not its options.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/decisions" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  location: dom.window.location,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent,
  Event: dom.window.Event,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ConvexProvider } = await import("convex/react");
const { offlineConvexClient } = await import("../../../test-helpers/offlineConvex");
const convex = offlineConvexClient("https://example.convex.cloud");
const { useInboxStore } = await import("../../../store/inboxStore");
const { DecisionCompactCard } = await import("../DecisionCompactCard");
const { AskingSessionView } = await import("../DecisionParties");
const { DecisionListRow } = await import("../DecisionListRow");
const { AnsweredFeed } = await import("../AnsweredFeed");
const { decisionScopeKey, groupDecisions, PRIORITIES_SCOPE } = await import("../../../lib/decisionGroups");
const { answerDecisions, dismissDecisions, unassignDecisions, sharedAnswers } = await import("../../../lib/decisions/decisionBulk");
const { questionCards } = await import("../../../lib/threadCards");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const CONV = "c-host-session";
const row = (extra: Record<string, unknown> = {}): any => ({
  _id: "d-pcc-surface", short_id: "sd-9001", conversation_id: CONV, session_id: "s", session_title: "Host session title",
  question: "Should your priorities follow what you worked on today?", options: card.changes.map((c) => ({ label: c.id })),
  kind: "multi", silent: true, blocking: true, status: "pending", created_at: 1, asked_user_ids: ["me"], priority_card: card, ...extra,
});
const ask = (extra: Record<string, unknown> = {}): any => ({
  _id: "d-ask", conversation_id: CONV, session_id: "s", question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }],
  blocking: true, status: "pending", created_at: 2, asked_user_ids: ["me"], ...extra,
});

useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [CONV]: { _id: CONV, title: "Host session title" } } }));

async function mount(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<ConvexProvider client={convex}><MemoryRouter>{ui}</MemoryRouter></ConvexProvider>));
  return { container, unmount: () => act(() => root.unmount()) };
}

test("the cards view files a card under Priorities, never its session", () => {
  expect(decisionScopeKey(row())).toBe(PRIORITIES_SCOPE);
  expect(decisionScopeKey(ask())).toBe(`session:${CONV}`);
  const groups = groupDecisions([row(), ask()], []);
  expect(groups.map((g) => g.key).sort()).toEqual([`scope:${PRIORITIES_SCOPE}`, `scope:session:${CONV}`].sort());
});

test("the compact card names the pass, not the host session, with no link, thread or stack box", async () => {
  const { container, unmount } = await mount(<DecisionCompactCard decision={row()} onToggleSelect={() => {}} />);
  expect(container.querySelector("[data-decision-card-source]")!.textContent).toBe("Priorities pass");
  expect(container.textContent).not.toContain("Host session title");
  expect(container.querySelector("[data-asking-session]")).toBeNull();
  expect(container.querySelector("[data-decision-discussion]")).toBeNull();
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  await unmount();
}, 30_000);

test("the asking-session line draws nothing for a card", async () => {
  const { container, unmount } = await mount(<AskingSessionView decision={row()} onJumpToAsk={() => {}} />);
  expect(container.innerHTML).toBe("");
  await unmount();
});

test("a list row has no owner button for a card", async () => {
  const ctx = { now: 10, grouped: new Set<any>(), areaName: () => "", owner: () => null };
  const state: any = { onOpenPalette: () => {} };
  const card = await mount(<DecisionListRow d={row()} state={state} ctx={ctx} />);
  expect(card.container.querySelector("[data-decision-assign]")).toBeNull();
  expect(card.container.textContent).toContain(`${row().priority_card.changes.length} changes to your priorities`);
  await card.unmount();
  const plain = await mount(<DecisionListRow d={ask()} state={state} ctx={ctx} />);
  expect(plain.container.querySelector("[data-decision-assign]")).not.toBeNull();
  await plain.unmount();
});

test("no bulk verb takes a card", () => {
  const calls: string[] = [];
  const real = useInboxStore.getState();
  useInboxStore.setState({
    answerDecision: ((id: string, a: any) => { calls.push(`${a.dismiss ? "dismiss" : "answer"}:${id}`); return Promise.resolve(); }) as any,
    unassignDecision: ((id: string) => calls.push(`unassign:${id}`)) as any,
  });
  try {
    expect(dismissDecisions([row(), ask()])).toBe(1);
    expect(answerDecisions([row({ kind: "single", options: [{ label: "Yes" }] }), ask()], "Yes")).toBe(1);
    expect(unassignDecisions([row({ passed_to: { kind: "user", id: "u2" } }), ask({ passed_to: { kind: "user", id: "u2" } })])).toBe(1);
    expect(sharedAnswers([row()])).toEqual([]);
    expect(calls).toEqual(["dismiss:d-ask", "answer:d-ask", "unassign:d-ask"]);
  } finally {
    useInboxStore.setState({ answerDecision: real.answerDecision, unassignDecision: real.unassignDecision });
  }
});

test("a card makes no question thread", () => {
  expect(questionCards([row(), ask()]).map((c) => c.id)).toEqual(["question:d-ask"]);
});

test("the Answered feed draws a card's record, not its options, and opens the card", async () => {
  const answered = row({ status: "answered", answer_json: [0, 1, 2], resolved_at: 5 });
  const { container, unmount } = await mount(<AnsweredFeed rows={[answered]} />);
  const record = container.querySelector("[data-answered-feed-priority-card]") as HTMLAnchorElement;
  expect(record.textContent).toContain(`Accepted 3 of ${card.changes.length}`);
  expect(record.getAttribute("href")).toBe("/decisions/sd-9001");
  expect(container.querySelector("[data-answered-feed-options]")).toBeNull();
  expect(container.querySelector("[data-answered-feed-session]")).toBeNull();
  expect(container.textContent).not.toContain("Host session title");
  await unmount();
  const corrected = await mount(<AnsweredFeed rows={[row({ status: "answered", answer_text: "Checkout stays at #9.", resolved_at: 5 })]} />);
  expect(corrected.container.querySelector("[data-answered-feed-priority-card] h3")!.textContent).toBe("You sent a correction");
  expect(corrected.container.querySelector("[data-answered-feed-words]")!.textContent).toBe("Checkout stays at #9.");
  await corrected.unmount();
});
