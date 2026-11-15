import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

// A reader cannot decide from a question and its option labels; the context
// the asker wrote is what the answer rests on. The sheet reads it whole, in
// one flow with the options after it; the fold shows the question and its
// status only, and opening it is the sheet.
mock.module("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a> }));
mock.module("../../../lib/convexUrl", () => ({ CONVEX_URL: "https://convex.test", getConvexUrl: () => "https://convex.test" }));
mock.module("../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: undefined, error: null }) }));
mock.module("../../../hooks/useSyncPendingPermissions", () => ({ usePendingPermissions: () => undefined }));
mock.module("../../../hooks/useJumpToDecisionAsk", () => ({ useJumpToDecisionAsk: () => async () => true, locateDecisionAsk: async () => null }));
mock.module("../../PublishedPageEmbed", () => ({ PublishedPageEmbed: () => null }));
// Wraps the real renderer rather than replacing it: bun shares this mock with every later file in a run, and those read real markdown.
const RealMarkdown = (await import("../../tools/MarkdownRenderer")).MarkdownRenderer;
mock.module("../../tools/MarkdownRenderer", () => ({ MarkdownRenderer: (props: any) => <div data-md><RealMarkdown {...props} /></div> }));

import { SessionDecisionCard } from "../../SessionDecisionCard";

import { closeDomWindow } from "../../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/questions" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const context = "The migration is deployed and idempotent.\n\nRunning it now seats four workspaces and bills one turn each.";
const item = (blocking: boolean): any => ({
  key: "decide:d1",
  source: "decide",
  conversationId: "c1",
  decisionId: "d1",
  question: "Run the one time root seat on prod now, or wait?",
  contextMd: context,
  options: [
    { label: "Run it now", description: "seats 4 workspaces" },
    { label: "Wait", description: "nothing runs" },
  ],
  blocking,
  defaultOption: blocking ? undefined : 1,
  createdAt: Date.now() - 60_000,
});

async function mount(ui: React.ReactNode) {
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  const root = createRoot(pane);
  await act(() => root.render(<MemoryRouter>{ui}</MemoryRouter>));
  return { pane, unmount: () => act(() => root.unmount()) };
}

function readingOrder(pane: HTMLElement) {
  const question = pane.querySelector("h1.decision-question")!;
  const body = pane.querySelector("[data-decision-context]")!;
  const firstOption = pane.querySelector("[data-option]")!;
  expect(question).not.toBeNull();
  expect(body).not.toBeNull();
  expect(firstOption).not.toBeNull();
  // The reasoning sits between the question and the option rows, all in one flow.
  expect(question.compareDocumentPosition(body) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(body.compareDocumentPosition(firstOption) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  return body;
}

test("an advisory card in a session view starts folded to one badge: the question on its tooltip, no reasoning, one click to open", async () => {
  const { pane, unmount } = await mount(<SessionDecisionCard item={item(false)} stepper={null} />);
  const fold = pane.firstElementChild!;
  expect(fold.classList.contains("decision-card")).toBe(true);
  expect(fold.classList.contains("decision-fold")).toBe(true);
  const pill = fold.querySelector("button") as HTMLButtonElement;
  expect(fold.querySelectorAll("button")).toHaveLength(1);
  expect(pill.textContent).toContain("Asked for your steer");
  expect(pill.title).toContain("root seat");
  expect(pill.title).toContain("proceeding with Wait");
  expect(fold.textContent).not.toContain("root seat");
  expect(pane.querySelector("[data-decision-context]")).toBeNull();
  expect(pane.querySelector("[data-option]")).toBeNull();
  await act(() => { pill.click(); });
  expect(pane.firstElementChild!.classList.contains("decision-doc")).toBe(true);
  const body = readingOrder(pane);
  expect(body.textContent).toContain("seats four workspaces and bills one turn each");
  unmount();
});

test("a blocking card owns the pane and reads the reasoning whole, in the document page's type", async () => {
  const { pane, unmount } = await mount(<SessionDecisionCard item={item(true)} stepper={null} />);
  const root = pane.firstElementChild!;
  expect(root.classList.contains("decision-doc")).toBe(true);
  expect(root.classList.contains("decision-sheet")).toBe(true);
  const body = readingOrder(pane);
  expect(body.textContent).toContain("bills one turn each");
  expect(pane.querySelector("h1.decision-question")!.textContent).toContain("root seat");
  // Nothing in the sheet scrolls on its own: one scroll box holds the
  // question, the reasoning and the options together.
  const scrollers = Array.from(pane.querySelectorAll<HTMLElement>("[class*='overflow-y-auto']"));
  expect(scrollers).toHaveLength(1);
  expect(scrollers[0].contains(pane.querySelector("h1.decision-question"))).toBe(true);
  expect(scrollers[0].contains(pane.querySelector("[data-option]"))).toBe(true);
  unmount();
});

test("in the queue an advisory card opens as the sheet, with its place in the queue on the chrome row", async () => {
  const stepper: any = { position: 2, total: 5, onDone: () => {}, onSkip: () => {}, onExit: () => {} };
  const { pane, unmount } = await mount(<SessionDecisionCard item={item(false)} stepper={stepper} />);
  const root = pane.firstElementChild!;
  expect(root.classList.contains("decision-sheet")).toBe(true);
  const place = pane.querySelector("[data-decision-place]")!;
  expect(place.textContent).toContain("2 of 5");
  expect(place.querySelector('[aria-label="Previous decision"]')).toBeNull(); // no onPrev handed in
  expect(place.querySelector('[aria-label="Next decision"]')).not.toBeNull();
  readingOrder(pane);
  unmount();
});

test("the sheet seats the reasoning and the options as the two cells of one grid, so a wide pane can set them side by side", async () => {
  const { pane, unmount } = await mount(<SessionDecisionCard item={item(true)} stepper={null} />);
  const grid = pane.querySelector(".decision-sheet-grid")!;
  expect(grid.getAttribute("data-split")).toBe("true");
  expect(grid.children).toHaveLength(2);
  expect(grid.children[0].classList.contains("decision-sheet-context")).toBe(true);
  expect(grid.children[1].classList.contains("decision-sheet-options")).toBe(true);
  unmount();
});

test("a question with no reasoning keeps one column", async () => {
  const bare = { ...item(true), contextMd: undefined };
  const { pane, unmount } = await mount(<SessionDecisionCard item={bare} stepper={null} />);
  const grid = pane.querySelector(".decision-sheet-grid")!;
  expect(grid.getAttribute("data-split")).toBe("false");
  expect(grid.children).toHaveLength(1);
  unmount();
});

// A decision posted from a role's own standing thread is the role's ask
// (org-staffing.md S28): the chrome row reads as that role, its face and
// handle, in the sheet and on the fold, never "Waiting on your decision".
test("a decision from a role's standing thread names the role that asks", async () => {
  const role = { _id: "org_roles_growth", short_id: "or-7", name: "Growth lead", handle: "growth", avatar: "stag", status: "active", tenure_kind: "standing" };
  const session = { _id: "c1", title: "Growth lead", standing_role_id: "org_roles_growth", role, project_path: "/src/union" };
  const sheet = await mount(<SessionDecisionCard item={{ ...item(true), session }} stepper={null} />);
  const asker = sheet.pane.querySelector("[data-decision-asker]")!;
  expect(asker.getAttribute("data-decision-asker")).toBe("growth");
  expect(asker.textContent).toContain("@growth asks");
  expect(sheet.pane.textContent).not.toContain("Waiting on your decision");
  sheet.unmount();
  const fold = await mount(<SessionDecisionCard item={{ ...item(false), session }} stepper={null} />);
  expect(fold.pane.textContent).toContain("@growth asks");
  expect(fold.pane.textContent).not.toContain("Asked for your steer");
  fold.unmount();
});

// One decision, one place to read it: a plan gate attaches the plan as a
// document, and the sheet draws it with the facts and the ladder the decision
// page draws (DecisionSections), never a link out to read what is answered.
test("the sheet reads an attached document and the task in place, with no link to the page, and no ladder when no role stood between", async () => {
  const { useInboxStore } = await import("../../../store/inboxStore");
  const decision: any = {
    _id: "d2", short_id: "sd-9", conversation_id: "c1", status: "pending", blocking: true, created_at: Date.now() - 60_000,
    question: "Approve the plan?", options: [{ label: "Approve" }, { label: "Revise" }], task_id: "t1", station: "plan_gate",
  };
  useInboxStore.getState().syncTable("decisionDetails", [{
    _id: "d2", decision,
    doc: { _id: "doc1", content: "## The plan\n\nStale callbacks get a promise flag." },
    task: { _id: "t1", short_id: "ct-42", title: "Call cards ring the wrong numbers" },
    stack: null, ladder: [], asked_users: [{ _id: "u1", name: "Ashot" }], holder_role: null, grant_offer: null, grant: null,
  } as any]);
  const plan = { ...item(true), key: "decide:d2", decisionId: "d2", docId: "doc1", contextMd: undefined, question: decision.question, options: decision.options };
  const { pane, unmount } = await mount(<SessionDecisionCard item={plan} stepper={null} />);
  expect(pane.querySelector("[data-decision-doc]")!.textContent).toContain("Stale callbacks get a promise flag");
  expect(pane.textContent).toContain("ct-42");
  expect(pane.textContent).not.toContain("The ladder");
  expect(pane.textContent).not.toContain("read the full decision");
  expect(pane.querySelector("a[href^='/decisions/']")).toBeNull();
  unmount();
});

test("a blocking card stays folded when the pane was just opened at a message: the jump asked for the thread", async () => {
  const { pane, unmount } = await mount(<SessionDecisionCard item={item(true)} stepper={null} targetNonce={Date.now()} />);
  expect(pane.firstElementChild!.classList.contains("decision-fold")).toBe(true);
  unmount();
  // A target from long before the ask says nothing about it.
  const stale = await mount(<SessionDecisionCard item={item(true)} stepper={null} targetNonce={Date.now() - 60_000} />);
  expect(stale.pane.firstElementChild!.classList.contains("decision-sheet")).toBe(true);
  stale.unmount();
});

test("scrolling up off the top of the sheet folds it and puts the thread on the ask", async () => {
  const { useInboxStore } = await import("../../../store/inboxStore");
  const before = useInboxStore.getState().messages;
  useInboxStore.setState({ messages: { ...before, c1: [
    { _id: "m1", role: "user", content: "seat the roots" },
    { _id: "m2", role: "assistant", content: "", tool_calls: [{ id: "t1", name: "Bash", input: "cast decide \"Run the one time root seat on prod now, or wait?\"" }] },
    { _id: "m3", role: "assistant", content: "waiting" },
  ] } } as any);
  const scrolled: string[] = [];
  const { pane, unmount } = await mount(<SessionDecisionCard item={item(true)} stepper={null} scrollToMessage={(id) => scrolled.push(id)} />);
  const sheet = pane.firstElementChild!;
  await act(() => { sheet.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -40, bubbles: true })); });
  expect(pane.firstElementChild!.classList.contains("decision-fold")).toBe(true);
  expect(scrolled).toEqual(["m2"]);
  unmount();
  useInboxStore.setState({ messages: before } as any);
});

test("a thread with several open asks steps between them from the sheet's header, without answering", async () => {
  const second = { ...item(true), key: "decide:d2", decisionId: "d2", question: "Who may use the credential?" };
  const picked: Array<[string, string]> = [];
  const { pane, unmount } = await mount(<SessionDecisionCard item={item(true)} stepper={null} asks={[item(true), second]} onPick={(key, size) => picked.push([key, size])} />);
  const place = pane.querySelector("[data-decision-place]")!;
  expect(place.textContent).toContain("1 of 2");
  await act(() => { (place.querySelector('[aria-label="Next decision in this thread"]') as HTMLElement).click(); });
  await act(() => { (place.querySelector('[aria-label="Previous decision in this thread"]') as HTMLElement).click(); });
  // Either way from the first of two lands on the second, at the size being read.
  expect(picked).toEqual([["decide:d2", "full"], ["decide:d2", "full"]]);
  unmount();
});

test("an ask picked from the card opens at the size it was picked at, whatever it would open at by itself", async () => {
  const { pane, unmount } = await mount(<SessionDecisionCard item={item(true)} stepper={null} startSize="line" />);
  expect(pane.firstElementChild!.classList.contains("decision-fold")).toBe(true);
  unmount();
});

// The thread's card as the conversation view mounts it: one pane that outlives the thread it shows.
const { ThemeContext } = await import("../../ThemeProvider");
const { ThreadDecisionCard } = await import("../../SessionDecisionCard");
const Thread = ({ conversationId, asks }: { conversationId: string; asks: any[] }) => <ThreadDecisionCard conversationId={conversationId} asks={asks} stepper={null} />;
const modern = (ui: React.ReactNode) => (
  <ThemeContext.Provider value={{ theme: "light", toggleTheme: () => {}, visualStyle: "modern", setVisualStyle: () => {} } as any}>{ui}</ThemeContext.Provider>
);
const ask = (n: number, blocking = false): any => ({ ...item(blocking), key: `decide:d${n}`, decisionId: `d${n}`, question: `Question ${n}?` });
const press = (el: Element | null) => act(() => { (el as HTMLElement).click(); });

test("in the Modern style a thread's other asks are rows on the docked card: pressing one brings it up, and once it is answered the card is back on the first", async () => {
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  const root = createRoot(pane);
  const draw = (asks: any[]) => act(() => root.render(<MemoryRouter>{modern(<Thread conversationId="c1" asks={asks} />)}</MemoryRouter>));
  const question = () => pane.querySelector("[data-cc-ask-question]")?.textContent;
  const rows = () => [...pane.querySelectorAll("[data-decision-other]")].map((b) => b.getAttribute("data-decision-other"));

  await draw([ask(1), ask(2), ask(3)]);
  expect(question()).toBe("Question 1?");
  expect(rows()).toEqual(["decide:d2", "decide:d3"]);
  // The agent's default on each of these is the second option.
  expect(pane.querySelector("[data-decision-options] [data-decision-proceeding]")?.textContent).toBe("proceeding with this");

  await press(pane.querySelector('[data-decision-other="decide:d3"]'));
  expect(question()).toBe("Question 3?");
  expect(rows()).toEqual(["decide:d1", "decide:d2"]);
  // Picked from the dock, it stays docked.
  expect(pane.querySelector("[data-session-decision]")!.classList.contains("decision-fold")).toBe(true);

  // Answered: it leaves the thread's asks and the first is shown again.
  await draw([ask(1), ask(2)]);
  expect(question()).toBe("Question 1?");
  expect(rows()).toEqual(["decide:d2"]);
  await act(() => root.unmount());
});

test("what is typed as an answer is still there after stepping to another ask and back", async () => {
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  const root = createRoot(pane);
  await act(() => root.render(<MemoryRouter>{modern(<Thread conversationId="c1" asks={[ask(1), ask(2)]} />)}</MemoryRouter>));
  const box = () => pane.querySelector<HTMLInputElement>('input[aria-label="Answer in your own words"]')!;
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(() => { setValue.call(box(), "neither, pause it at night"); box().dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  expect(box().value).toBe("neither, pause it at night");
  await press(pane.querySelector('[data-decision-other="decide:d2"]'));
  expect(box().value).toBe("");
  await press(pane.querySelector('[data-decision-other="decide:d1"]'));
  expect(box().value).toBe("neither, pause it at night");
  await act(() => root.unmount());
  const { useInboxStore } = await import("../../../store/inboxStore");
  useInboxStore.getState().clearDraft("decision:d1");
});

test("an advisory ask stepped to in the sheet, then folded, stays folded when the person leaves the thread and comes back", async () => {
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  const root = createRoot(pane);
  const draw = (conversationId: string, asks: any[]) => act(() => root.render(<MemoryRouter><Thread conversationId={conversationId} asks={asks} /></MemoryRouter>));
  const card = () => pane.querySelector("[data-session-decision]");
  const asks = [ask(1, true), ask(2)];

  await draw("c1", asks);
  // The blocking ask opens as the sheet; stepping from its header brings the advisory one up as the sheet too.
  expect(card()!.classList.contains("decision-sheet")).toBe(true);
  await press(pane.querySelector('[aria-label="Next decision in this thread"]'));
  expect(pane.querySelector("h1.decision-question")!.textContent).toBe("Question 2?");
  expect(card()!.classList.contains("decision-sheet")).toBe(true);

  // Another thread, then back: the pick was this visit's, so the thread opens on its first ask, as it always has.
  await draw("c2", []);
  expect(card()).toBeNull();
  await draw("c1", asks);
  expect(pane.querySelector("h1.decision-question")!.textContent).toBe("Question 1?");

  // And the size is spent once: the same ask drawn again (its card remounted) opens the way it opens by itself.
  await press(pane.querySelector('[aria-label="Next decision in this thread"]'));
  expect(card()!.classList.contains("decision-sheet")).toBe(true);
  await draw("c1", []);
  await draw("c1", [ask(2)]);
  expect(card()!.classList.contains("decision-fold")).toBe(true);
  await act(() => root.unmount());
});

test("a permission ask behind an ordinary one is never a row or a step: it waits for its own card in the transcript", async () => {
  const { useInboxStore } = await import("../../../store/inboxStore");
  const before = useInboxStore.getState().sessionDecisions;
  useInboxStore.setState({ sessionDecisions: { ...before, d2: { _id: "d2", conversation_id: "c1", status: "pending", question: "Question 2?", options: [], run: { id: "r1" } } } } as any);
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  const root = createRoot(pane);
  await act(() => root.render(<MemoryRouter>{modern(<Thread conversationId="c1" asks={[ask(1), ask(2), ask(3)]} />)}</MemoryRouter>));
  expect(pane.querySelector("[data-cc-ask-question]")!.textContent).toBe("Question 1?");
  expect([...pane.querySelectorAll("[data-decision-other]")].map((b) => b.getAttribute("data-decision-other"))).toEqual(["decide:d3"]);
  // Counted among the asks the card steps through: two, not three.
  expect(pane.querySelector("[data-cc-ask]")!.textContent).toContain("1 of 2");
  await act(() => root.unmount());
  useInboxStore.setState({ sessionDecisions: before } as any);
});

test("the rows opened past the first few stay open from one ask to the next", async () => {
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  const root = createRoot(pane);
  await act(() => root.render(<MemoryRouter>{modern(<Thread conversationId="c1" asks={[1, 2, 3, 4, 5, 6].map((n) => ask(n))} />)}</MemoryRouter>));
  const rows = () => pane.querySelectorAll("[data-decision-other]").length;
  expect(rows()).toBe(3);
  await press(pane.querySelector("[data-decision-others-more]"));
  expect(rows()).toBe(5);
  await press(pane.querySelector('[data-decision-other="decide:d6"]'));
  expect(pane.querySelector("[data-cc-ask-question]")!.textContent).toBe("Question 6?");
  expect(rows()).toBe(5);
  await act(() => root.unmount());
});
