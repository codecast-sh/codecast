// Mounts For you (line-journeys.md LJ8.1) on fixture needs of every kind:
// only what can be answered now is listed (the groups named for the act), rows
// with no buttons, the reader holding the open need under one head line (the
// problem and its age), J and K walking the list without leaving it, and the
// quiet pointers to Problems counted by the Problems list itself.
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
const { WaitingItem } = await import("../../widgets/WaitingItem");
const { lineNeeds } = await import("../../../../lib/line/lineNeeds");
const { readLineSelection } = await import("../../../../lib/line/lineWorkspaceUrl");
const { ageShort } = await import("../../../../lib/lineFlow");

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
// The problems Problems lists: ct-6 stopped needing a yes (Needs a new ask), ct-20 ready with no line set up (Not started).
const history = { occurrences: [], occurrencesFrom: "history", since: null, capped: false, attempts: [], ships: [], deploys: [], coverage: { state: "none", targets: [], words: "" }, watches: [], regressions: [], closes: [], recurrences: [], regressed: false, cameBack: false, firstAt: null, lastActivity: 0 };
const issue = (id: string) => ({ id, ref: `ct-${id}`, title: `Problem ${id}`, status: "open", findings: 1, quotes: [], runs: [], lastRunAt: 0, where: { tone: "calm", end: null, text: "" }, history, process: "line" });
const tasks = ["6", "20"].map((id) => ({ _id: id, short_id: `ct-${id}`, status: "open", readiness: "ready", goal_ref: "g-1", assignee: null, workflow_run_id: null, project_id: "p1", cause: { signal_count: 2, first_seen: 0, last_seen: 0, fingerprints: [] } }));
const workspace = {
  needs, now, ready: true, processes: [{ key: "line", title: "Codecast's line" }], projects: [{ _id: "p1", title: "Callers" }], project: null, open: 12,
  problems: [issue("6"), issue("20")], allInbox: groups, rows: { tasks }, admissions: new Map(), trialProjects: new Set(), names: new Map(), sources: new Map(), overlaps: new Map(),
} as any;
const empty = { problems: [], allInbox: [], rows: { tasks: [] } };

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
  await act(async () => { root.render(React.createElement(ForYouView, { model: { steps: {}, runs: [] } as any, workspace: ws, selection: readLineSelection(new URLSearchParams(search)), select: (p: any, _c: any, o: any) => selects.push([p, o]), href: (p: any) => `/line?view=${p.view ?? ""}` })); });
}

test("only what can be answered now is listed, the reader's N of M is the list; a row is the problem's title and carries no button", async () => {
  await render("");
  expect([...host.querySelectorAll<HTMLElement>("[data-line-need-group]")].map((g) => `${g.dataset.lineNeedGroup}:${g.querySelectorAll(".fy-row").length}`)).toEqual(["question:1", "confirm:1"]);
  expect(q("[data-line-foryou]")?.dataset.lineForyou).toBe("2");
  expect(q(".fy-pos")?.textContent).toBe("1 of 2");
  // What is asked is the reader's; the list says what each item is about.
  expect(q("[data-line-need-ref='ct-3'] .fy-ask")?.textContent).toBe("Quinn or Riley");
  expect(q("[data-line-need-ref='ct-5'] .fy-ask")?.textContent).toBe("Card names come out cut");
  expect(q("[data-line-need-ref='ct-6']")).toBeNull();
  expect(host.querySelectorAll(".fy-row button").length).toBe(0);
  // Arriving names the first need in the address, in place.
  expect(selects.at(-1)).toEqual([{ need: "ct-3", decision: null, card: null }, { replace: true }]);
});

test("what no answer can reach is one quiet pointer per Problems chip, counted by the Problems list, outside the walk", async () => {
  await render("need=ct-3");
  const pointers = [...host.querySelectorAll<HTMLElement>("[data-line-foryou-pointer]")];
  expect(pointers.map((p) => [p.dataset.lineForyouPointer, p.textContent])).toEqual([["newask", "Needs a new ask1"], ["notstarted", "Not started1"]]);
  expect(host.querySelectorAll(".fy-row").length).toBe(2);
});

test("the reader's head names the problem once: its ref and title open it, then its age", async () => {
  await render("need=ct-3");
  const head = q("[data-line-foryou-head]")!;
  expect(q("[data-line-foryou-problem]")?.textContent).toBe("ct-3Quinn or Riley");
  expect(head.querySelector(".fy-age")?.textContent).toBe(ageShort(9 * H));
  expect(head.querySelector(".fy-process")).toBeNull();
  // The body opens on what is asked: no second head inside it.
  expect(q(".fy-reader-b [data-headless]")).not.toBeNull();
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

test("a run that stopped needing a yes is not For you's: its address says so and points at the problem", async () => {
  await render("need=ct-6");
  expect(q("[data-line-foryou-reader]")?.dataset.lineForyouReader).toBe("missing");
  expect(q("[data-line-foryou-missing] a")?.textContent).toBe("Open the problem");
});

test("the reader of a run that stopped needing a yes (its problem's band) shows what the step said, and its one act opens a review that starts nothing", async () => {
  const started: string[] = [];
  useInboxStore.setState({ startLineCause: async (id: string) => { started.push(id); return null; } } as any);
  await act(async () => { root.render(React.createElement(WaitingItem, { need: needs.find((n: any) => n.ref === "ct-6"), now, head: false, onProblem() {}, onRun() {} })); });
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
  await render("need=ct-5", { ...workspace, needs: needs.filter((n: any) => n.ref === "ct-5"), ...empty });
  expect(q("[data-line-foryou]")?.hasAttribute("data-single")).toBe(true);
  await render("need=ct-5");
  expect(q("[data-line-foryou]")?.hasAttribute("data-single")).toBe(false);
});

test("a new problem is confirmed real in one press, a note optional, beside what grounding still does not know (ct-58683)", async () => {
  const writes: any[] = [];
  useInboxStore.setState({ updateTask: async (ref: string, patch: any) => { writes.push([ref, patch]); }, addTaskComment: async () => {} } as any);
  const conf = lineNeeds([{ kind: "confirm", label: "", rows: [row("confirm", "7", { title: "Grader faulted Eric", note: "The fix is probably in the grader prompt or in how card context is built, but the signal doesn't say which. A person needs to confirm whether the card's name set came from truncated data or from the grader." })] }] as any, { row: () => "line" });
  await render("need=ct-7", { ...workspace, needs: conf, ...empty });
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
  await render("need=ct-8", { ...workspace, needs: qn, ...empty });
  expect(q("[data-line-ask-q]")?.textContent).toBe("Has Quinn actually left, or is Quinn still active?");
  const choices = [...host.querySelectorAll<HTMLButtonElement>("[data-line-ask-choice]")];
  expect(choices.map((c) => c.textContent)).toEqual(["Quinn has actually leftSo Riley is correct", "Quinn is still activeSo the switch is the bug"]);
  // Nothing typed: the choices are the answer; the free box is for something else.
  expect(q("[data-line-ask-confirm]")).toBeNull();
  await act(async () => { choices[1].click(); });
  expect(writes).toEqual([["ct-8", { readiness: "ready", readiness_note: "Confirmed: Quinn is still active (so the switch is the bug)" }]]);
});
