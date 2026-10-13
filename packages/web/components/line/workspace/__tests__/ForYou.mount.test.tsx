// Mounts For you (line-journeys.md LJ8.1) on fixture needs of every kind:
// the counted groups named for the act, "Needs a new ask" below them, rows
// with no buttons, the reader holding the open need (a question's answer box,
// a stopped run's words and its one act, which opens the review and starts
// nothing until confirmed), J and K walking the list without leaving it, and
// the Not started row linking to Problems.
import { afterAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

setDefaultTimeout(60_000);
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/line", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true, CSS: { escape: (s: string) => s }, MutationObserver: dom.window.MutationObserver, CustomEvent: dom.window.CustomEvent, DocumentFragment: dom.window.DocumentFragment, NodeFilter: dom.window.NodeFilter, requestAnimationFrame: (f: any) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({ useRouter: () => ({ push() {} }), useSearchParams: () => new URLSearchParams(), usePathname: () => "/line" }));
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => undefined, useConvex: () => ({ query: async () => null, mutation: async () => null }) }));
const noThrow = await import("../../../../hooks/useQueryNoThrow");
mock.module("../../../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined }) }));

const { useInboxStore } = await import("../../../../store/inboxStore");
const { ForYouView } = await import("../views/ForYouView");
const { lineNeeds } = await import("../../../../lib/line/lineNeeds");
const { readLineSelection } = await import("../../../../lib/line/lineWorkspaceUrl");

const now = Date.UTC(2026, 9, 12, 12);
const H = 3_600_000;
const row = (kind: string, key: string, over: Record<string, unknown> = {}) => ({ key: `${kind}:${key}`, kind, at: now - H, projectId: "p1", title: `Problem ${key}`, ref: `ct-${key}`, detail: null, caseId: key, runId: null, cardId: null, cardRef: null, ...over });
const groups = [
  { kind: "question", label: "", rows: [row("question", "3", { title: "Quinn or Riley", note: "Akash took the call. Has Quinn left the account, or is Riley's record wrong?", at: now - 9 * H })] },
  { kind: "confirm", label: "", rows: [row("confirm", "5", { title: "Card names come out cut", note: "One report. Is this a real problem?" })] },
  { kind: "failed", label: "", rows: [row("failed", "6", { runId: "r6", title: "Eval gate fails", fail: { key: "deadend:prove", step: "prove", label: "Prove: the fix still needs Cameron's yes before it ships.", raw: "" } })] },
  { kind: "stuck", label: "", rows: [row("stuck", "p1", { caseId: null, ref: null, waiting: 47, switchOff: true })] },
] as any;
const needs = lineNeeds(groups, { row: () => "line" });
const workspace = { needs, notStarted: { problems: 47, lines: 1 }, now, ready: true, processes: [{ key: "line", title: "Codecast's line" }], projects: [{ _id: "p1", title: "Callers" }], project: null, open: 12 } as any;

useInboxStore.setState({
  currentUser: { _id: "u1" }, projects: { p1: { _id: "p1", title: "Callers" } }, tasks: {},
  workflowRuns: { r6: { _id: "r6", task_id: "6", status: "failed", created_at: now - 5 * H, updated_at: now - 4 * H, node_statuses: [{ node_id: "prove", label: "Prove", status: "completed", session: { result: "The fix is ready, but it still needs Cameron's yes before it ships." } }] } },
} as any);

const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);
const selects: any[] = [];
const q = (s: string) => host.querySelector(s) as HTMLElement | null;
async function render(search: string, ws: any = workspace) {
  await act(async () => { root.render(React.createElement(ForYouView, { model: {} as any, workspace: ws, selection: readLineSelection(new URLSearchParams(search)), select: (p: any, _c: any, o: any) => selects.push([p, o]), href: (p: any) => `/line?view=${p.view ?? ""}` })); });
}

test("groups named for the act, counted first; a row is the problem's title, whole, and carries no button", async () => {
  await render("");
  expect([...host.querySelectorAll<HTMLElement>("[data-line-need-group]")].map((g) => `${g.dataset.lineNeedGroup}:${g.querySelectorAll(".fy-row").length}`)).toEqual(["question:1", "confirm:1", "newask:1"]);
  expect(q("[data-line-foryou]")?.dataset.lineForyou).toBe("2");
  // What is asked is the reader's; the list says what each item is about.
  expect(q("[data-line-need-ref='ct-3'] .fy-ask")?.textContent).toBe("Quinn or Riley");
  expect(q("[data-line-need-ref='ct-5'] .fy-ask")?.textContent).toBe("Card names come out cut");
  expect(q("[data-line-need-ref='ct-6'] .fy-ask")?.textContent).toBe("Eval gate fails");
  expect(host.querySelectorAll(".fy-row button").length).toBe(0);
  // Arriving names the first need in the address, in place.
  expect(selects.at(-1)).toEqual([{ need: "ct-3", decision: null, card: null }, { replace: true }]);
  expect(q("[data-line-foryou-notstarted]")?.getAttribute("href")).toBe("/line?view=problems&status=notstarted");
});

test("a question opens with its answer box; J moves to the next need without leaving the list", async () => {
  selects.length = 0;
  await render("need=ct-3");
  expect(q("[data-line-foryou-reader]")?.dataset.lineForyouReader).toBe("question");
  expect(q("[data-line-ask-box]")).not.toBeNull();
  expect(q(".fy-reader")?.textContent).toContain("Has Quinn left the account, or is Riley's record wrong?");
  q("[data-line-need-ref='ct-3']")!.focus();
  await act(async () => { q(".fy-list")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "j", bubbles: true })); });
  expect(selects.at(-1)).toEqual([{ need: "ct-5", decision: null, card: null }, { replace: true }]);
});

test("a run that stopped needing a yes shows what the step said, and its one act opens a review that starts nothing", async () => {
  const started: string[] = [];
  useInboxStore.setState({ startLineCause: async (id: string) => { started.push(id); return null; } } as any);
  await render("need=ct-6");
  expect(q("[data-line-foryou-reader]")?.dataset.lineForyouReader).toBe("stopped");
  expect(q("[data-line-need-said]")?.textContent).toContain("still needs Cameron's yes before it ships");
  const act1 = q("[data-line-start-again]")!;
  expect(act1.textContent).toBe("Start a new run to ask again");
  expect(q("[data-line-need-drop]")?.textContent).toBe("Not a problem");
  await act(async () => { act1.click(); });
  expect(document.querySelector("[data-switch-review]")).not.toBeNull();
  expect(started).toEqual([]);
});

test("a need the address names that is not waiting on the viewer says so, and never opens another item in its place", async () => {
  selects.length = 0;
  await render("need=ct-99");
  expect(q("[data-line-foryou-reader]")?.dataset.lineForyouReader).toBe("missing");
  expect(q("[data-line-foryou-missing]")?.textContent).toContain("Not waiting on you");
  expect(q("[data-line-foryou-missing] a")?.textContent).toBe("Open the problem");
  expect(host.querySelector(".fy-row[aria-current='true']")).toBeNull();
  expect(selects).toEqual([]);
});

test("an item answered while open leaves the list and the next one opens in its place", async () => {
  await render("need=ct-3");
  selects.length = 0;
  await render("need=ct-3", { ...workspace, needs: needs.filter((n: any) => n.ref !== "ct-3") });
  expect(selects.at(-1)).toEqual([{ need: "ct-5", decision: null, card: null }, { replace: true }]);
});

test("one item and nothing else listed: the reader takes the whole width", async () => {
  await render("need=ct-5", { ...workspace, needs: needs.filter((n: any) => n.ref === "ct-5"), notStarted: { problems: 0, lines: 0 } });
  expect(q("[data-line-foryou]")?.hasAttribute("data-single")).toBe(true);
  await render("need=ct-5");
  expect(q("[data-line-foryou]")?.hasAttribute("data-single")).toBe(false);
});

test("a new problem is confirmed real in one press, a note optional, beside what grounding still does not know (ct-58683)", async () => {
  const writes: any[] = [];
  useInboxStore.setState({ updateTask: async (ref: string, patch: any) => { writes.push([ref, patch]); }, addTaskComment: async () => {} } as any);
  const conf = lineNeeds([{ kind: "confirm", label: "", rows: [row("confirm", "7", { title: "Grader faulted Eric", note: "The fix is probably in the grader prompt or in how card context is built, but the signal doesn't say which. A person needs to confirm whether the card's name set came from truncated data or from the grader." })] }] as any, { row: () => "line" });
  await render("need=ct-7", { ...workspace, needs: conf, notStarted: { problems: 0, lines: 0 } });
  expect(q("[data-line-ask-q]")?.textContent).toBe("Is this a real problem?");
  expect(q("[data-line-ask-open]")?.textContent).toContain("Which is it: the card's name set came from truncated data, or from the grader?");
  const yes = q("[data-line-ask-confirm]") as HTMLButtonElement;
  expect(yes.textContent).toBe("Yes, it is real");
  expect(yes.disabled).toBe(false);
  await act(async () => { yes.click(); });
  expect(writes).toEqual([["ct-7", { readiness: "ready", readiness_note: "Confirmed by a person." }]]);
});

test("a question said as a statement is asked as a question, each alternative a one-press answer (ct-58311)", async () => {
  const writes: any[] = [];
  useInboxStore.setState({ updateTask: async (ref: string, patch: any) => { writes.push([ref, patch]); }, addTaskComment: async () => {} } as any);
  const qn = lineNeeds([{ kind: "question", label: "", rows: [row("question", "8", { title: "One consistent rep", note: "Akash dealt with Quinn but the follow-ups were signed Riley. It can't be worked yet because the report says the persona rule is under review, and nothing says whether Quinn has actually left (so Riley is correct) or is still active (so the switch is the bug)." })] }] as any, { row: () => "line" });
  await render("need=ct-8", { ...workspace, needs: qn, notStarted: { problems: 0, lines: 0 } });
  expect(q("[data-line-ask-q]")?.textContent).toBe("Has Quinn actually left, or is Quinn still active?");
  const choices = [...host.querySelectorAll<HTMLButtonElement>("[data-line-ask-choice]")];
  expect(choices.map((c) => c.textContent)).toEqual(["Quinn has actually leftSo Riley is correct", "Quinn is still activeSo the switch is the bug"]);
  // Nothing typed: the choices are the answer; the free box is for something else.
  expect(q("[data-line-ask-confirm]")).toBeNull();
  await act(async () => { choices[1].click(); });
  expect(writes).toEqual([["ct-8", { readiness: "ready", readiness_note: "Confirmed: Quinn is still active (so the switch is the bug)" }]]);
});
