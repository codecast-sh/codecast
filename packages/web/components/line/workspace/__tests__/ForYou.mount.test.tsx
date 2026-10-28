// Mounts For you (line-journeys.md LJ8.1) on fixture needs of every kind:
// only the end decision is listed (under what the person is asked), never
// what a station asked before its run got there nor the line's own chores (a
// problem assigned, a fix to land, a twin to merge); rows with no buttons, the
// reader holding the open need under one head line (the problem and its age),
// J and K walking the list without leaving it, and no pointers elsewhere.
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
dom.window.HTMLElement.prototype.scrollTo = () => {};
// The list is the Decisions page's (a virtualized GenericListView): rows need a height to be drawn.
Object.defineProperties(dom.window.HTMLElement.prototype, {
  offsetHeight: { get() { return this.hasAttribute("data-index") ? 40 : 4000; } },
  offsetWidth: { get: () => 1200 },
});
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
const pushed: string[] = [];
mock.module("next/navigation", () => ({ useRouter: () => ({ push: (u: string) => pushed.push(u), replace() {} }), useSearchParams: () => new URLSearchParams(), usePathname: () => "/line" }));
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => undefined, useAction: () => async () => ({ ok: false, error: "no app in a test" }), useConvex: () => ({ query: async () => null, mutation: async () => null }) }));
const noThrow = await import("../../../../hooks/useQueryNoThrow");
mock.module("../../../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined }) }));

const { useInboxStore } = await import("../../../../store/inboxStore");
const { ForYouView } = await import("../views/ForYouView");
const { WaitingItem } = await import("../../widgets/WaitingItem");
const { lineNeeds } = await import("../../../../lib/line/lineNeeds");
const { readLineSelection } = await import("../../../../lib/line/lineWorkspaceUrl");

const now = Date.UTC(2026, 9, 12, 12);
const H = 3_600_000;
const row = (kind: string, key: string, over: Record<string, unknown> = {}) => ({ key: `${kind}:${key}`, kind, at: now - H, projectId: "p1", title: `Problem ${key}`, ref: `ct-${key}`, detail: null, caseId: key, runId: null, cardId: null, cardRef: null, ...over });
const groups = [
  { kind: "decide", label: "", rows: [row("decide", "3", { title: "Quinn or Riley", at: now - 9 * H, cardId: "d3", cardRef: "sd-3", decisionId: "d3", change: "fix", assignee: "u2", reach: 4, findings: 6, severity: 8 }), row("decide", "5", { title: "Card names come out cut", cardId: "d5", cardRef: "sd-5", decisionId: "d5", change: "judge", assignee: null })] },
  // A problem assigned to the viewer is the line's to carry (Problems' Not started), never For you's.
  { kind: "mine", label: "", rows: [row("mine", "40", { title: "Held by hand" })] },
  // What a station asked before a fix was presented is on Problems, never in this list.
  { kind: "question", label: "", rows: [row("question", "30", { title: "One consistent rep", note: "Akash took the call. Has Quinn left the account, or is Riley's record wrong?" })] },
  { kind: "confirm", label: "", rows: [row("confirm", "31", { title: "Grader faulted Eric", note: "One report. Is this a real problem?" })] },
  { kind: "failed", label: "", rows: [row("failed", "6", { runId: "r6", title: "Eval gate fails", fail: { key: "deadend:prove", step: "prove", label: "Prove: the fix still needs Cameron's yes before it ships.", raw: "" } })] },
  { kind: "stuck", label: "", rows: [row("stuck", "p1", { caseId: null, ref: null, waiting: 47, switchOff: true })] },
] as any;
const needs = lineNeeds(groups, { row: () => "line" });
// The problems Problems lists: ct-6 stopped needing a yes (Needs a new ask), ct-20 ready with no line set up (Not started).
const history = { occurrences: [], occurrencesFrom: "history", since: null, capped: false, attempts: [], ships: [], deploys: [], coverage: { state: "none", targets: [], words: "" }, watches: [], regressions: [], closes: [], recurrences: [], regressed: false, cameBack: false, firstAt: null, lastActivity: 0 };
const issue = (id: string) => ({ id, ref: `ct-${id}`, title: `Problem ${id}`, status: "open", findings: 1, quotes: [], runs: [], lastRunAt: 0, where: { tone: "calm", end: null, text: "" }, history, process: "line" });
const tasks = ["6", "20"].map((id) => ({ _id: id, short_id: `ct-${id}`, status: "open", readiness: "ready", goal_ref: "g-1", assignee: null, workflow_run_id: null, project_id: "p1", cause: { signal_count: 2, first_seen: 0, last_seen: 0, fingerprints: [] } }));
const workspace = {
  needs, now, ready: true, processes: [{ key: "line", title: "Standard" }], projects: [{ _id: "p1", title: "Callers" }], project: null, open: 12,
  problems: [issue("6"), issue("20")], allInbox: groups, rows: { tasks, signals: [] }, admissions: new Map(), trialProjects: new Set(), trialRuns: new Set(), names: new Map(), sources: new Map(), overlaps: new Map(),
} as any;
const empty = { problems: [], allInbox: [], rows: { tasks: [], signals: [] } };

useInboxStore.setState({
  currentUser: { _id: "u1" }, projects: { p1: { _id: "p1", title: "Callers" } }, tasks: {}, teamMembers: [{ _id: "u1", name: "Me" }, { _id: "u2", name: "Sam" }, { _id: "u3", name: "Jo" }],
  // The decision rows the two needs stand on: the list For you draws is these rows, as the Decisions page draws them.
  sessionDecisions: {
    d3: { _id: "d3", short_id: "sd-3", conversation_id: "c", session_id: "s", question: "Quinn or Riley", options: [{ label: "Quinn" }, { label: "Riley" }], blocking: true, status: "pending", created_at: now - 9 * H, workflow_run_id: "r3", task_id: "3", gate_node_id: "decide", holder: { kind: "user", id: "u2" }, problem_severity: 8, area_project_id: "p1", in_queue: false, line_workspace: "team:t1" },
    d5: { _id: "d5", short_id: "sd-5", conversation_id: "c", session_id: "s", question: "Card names come out cut", options: [{ label: "Fix" }, { label: "Leave" }], blocking: true, status: "pending", created_at: now - H, workflow_run_id: "r5", task_id: "5", asked_user_ids: [], area_project_id: "p1", in_queue: false, line_workspace: "team:t1" },
  },
  workflowRuns: { r6: { _id: "r6", task_id: "6", status: "failed", created_at: now - 5 * H, updated_at: now - 4 * H, node_statuses: [{ node_id: "prove", label: "Prove", status: "completed", session: { result: "The fix is ready, but it still needs Cameron's yes before it ships." } }] } },
} as any);

const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);
const selects: any[] = [];
const q = (s: string) => host.querySelector(s) as HTMLElement | null;
const listed = () => [...host.querySelectorAll<HTMLElement>("[data-decision-row]")].map((r) => `${r.dataset.decisionRow}@${r.dataset.decisionOwner}`);
/** A need read where its problem names it (the problem's band), as For you no longer lists what a station asked early. */
async function renderNeed(need: any) {
  await act(async () => { root.render(React.createElement(WaitingItem, { key: need.key, need, now, head: false, asked: false, onProblem() {}, onRun() {} })); });
}
async function render(search: string, ws: any = workspace) {
  await act(async () => { root.render(React.createElement(ForYouView, { model: { steps: {}, runs: [] } as any, workspace: ws, selection: readLineSelection(new URLSearchParams(search)), select: (p: any, _c: any, o: any) => selects.push([p, o]), href: (p: any) => `/line?view=${p.view ?? ""}${p.need ? `&need=${p.need}` : ""}` })); });
}

test("with nothing open the flows' decisions are the Decisions list across the page, grouped by area; nothing opens by itself", async () => {
  selects.length = 0;
  pushed.length = 0;
  await render("");
  expect(q("[data-line-foryou]")?.dataset.mode).toBe("table");
  expect(q("[data-line-foryou]")?.dataset.lineForyou).toBe("2");
  // The same rows and owners as the Decisions page's Team list: Sam holds sd-3, nobody sd-5.
  expect(listed()).toEqual(["sd-3@user:u2", "sd-5@none"]);
  expect([...host.querySelectorAll("[data-list-tabs] button")].map((b) => b.textContent)).toEqual(["Team2", "Mine", "Unassigned1", "Escalated"]);
  const row = q("[data-decision-row='sd-3']")!;
  expect(row.textContent).toContain("Quinn or Riley");
  expect(row.textContent).toContain("Fix");
  // A question, a new problem to confirm, a step that finished mid-run and a problem assigned by hand wait on nobody here.
  for (const ref of ["ct-30", "ct-31", "ct-6", "ct-40"]) expect(q(`[data-decision-row='${ref}']`)).toBeNull();
  expect(host.querySelectorAll("[data-line-pointer]").length).toBe(0);
  expect(selects).toEqual([]);
  // A row opens its decision in For you's reader.
  await act(async () => { (row.closest("[data-list-row-state], [data-index] > div") as HTMLElement).click(); });
  expect(pushed.at(-1)).toBe("/line?view=&need=sd-3");
});

test("open, the list sits beside the reader; its head is the problem and the pager, and nothing said twice", async () => {
  await render("need=sd-3");
  expect(q("[data-line-foryou]")?.dataset.mode).toBe("read");
  expect(listed()).toEqual(["sd-3@user:u2", "sd-5@none"]);
  const head = q("[data-line-foryou-head]")!;
  expect(head.textContent).not.toContain("ct-3");
  expect(head.textContent).not.toContain("Quinn or Riley");
  expect(head.textContent).not.toContain("Callers");
  expect(q("[data-line-foryou-problem]")?.textContent).toBe("Open the problem");
  expect(q(".fy-pos")?.textContent).toBe("1 of 2");
  expect(head.querySelectorAll("[aria-label='Previous'], [aria-label='Next']").length).toBe(2);
  // One item: nothing to page through.
  await render("need=sd-3", { ...workspace, needs: needs.filter((n: any) => n.ref === "sd-3") });
  expect(q(".fy-pos")).toBeNull();
  expect(q("[data-line-foryou-head] [aria-label='Previous']")).toBeNull();
});

test("the pager opens the next decision in the list's order; a question is read, with its answer box, where its problem names it", async () => {
  selects.length = 0;
  await render("need=sd-3");
  expect(q("[data-line-foryou-reader]")?.dataset.lineForyouReader).toBe("decision");
  await act(async () => { q<HTMLButtonElement>("[data-line-foryou-head] [aria-label='Next']")!.click(); });
  expect(selects.at(-1)).toEqual([{ need: "sd-5", decision: null, card: null }, { replace: true }]);
  await renderNeed(needs.find((n: any) => n.ref === "ct-30"));
  expect(q("[data-line-ask-box]")).not.toBeNull();
  expect(host.textContent).toContain("Has Quinn left the account, or is Riley's record wrong?");
});

test("a run that stopped needing a yes is not For you's; on its problem its reader asks the yes in one line and offers it", async () => {
  await render("need=ct-6");
  expect(q("[data-line-foryou-reader]")?.dataset.lineForyouReader).toBe("missing");
  await renderNeed(needs.find((n: any) => n.ref === "ct-6"));
  // Its host names only the problem, so the reader asks it.
  expect(q("[data-line-need-ask]")?.textContent).toBe("Prove finished: go on to Build?");
  expect(q("[data-line-start-again]")?.textContent).toBe("Go on to Build (new run)");
});

test("the reader of a run that stopped needing a yes (its problem's band) shows what the step said, and going on is one act: a review of the new run it takes, which starts nothing until confirmed", async () => {
  const started: string[] = [];
  const updates: Array<[string, unknown]> = [];
  const real = { startLineCause: useInboxStore.getState().startLineCause, updateTask: useInboxStore.getState().updateTask, addTaskComment: useInboxStore.getState().addTaskComment };
  useInboxStore.setState({ startLineCause: async (id: string) => { started.push(id); return null; }, updateTask: async (id: string, patch: unknown) => { updates.push([id, patch]); }, addTaskComment: async () => {} } as any);
  await act(async () => { root.render(React.createElement(WaitingItem, { need: needs.find((n: any) => n.ref === "ct-6"), now, head: false, onProblem() {}, onRun() {} })); });
  expect(q("[data-line-need-said]")?.textContent).toContain("still needs Cameron's yes before it ships");
  expect(q("[data-line-need-drop]")?.textContent).toBe("Not a problem");
  // No note-only yes beside it: the run is the yes.
  expect(q("[data-line-need-yes]")).toBeNull();
  expect(document.querySelectorAll("[data-line-start-again]").length).toBe(1);
  const run = q("[data-line-start-again]")!;
  expect(run.textContent).toBe("Go on to Build (new run)");
  await act(async () => { run.click(); });
  const review = document.querySelector("[data-switch-review]")!;
  expect(review).not.toBeNull();
  expect(review.textContent).toContain("Go on to Build (new run)");
  expect(review.textContent).toContain("Every step through Prove");
  expect(review.textContent).toContain("Build, when Prove passes again");
  expect(started).toEqual([]);
  expect(updates).toEqual([]);
  useInboxStore.setState(real as any);
});

test("findings and a step's words under a need are one line each until opened: a long report never opens by itself", async () => {
  const base = needs.find((n: any) => n.ref === "ct-6");
  const long = "The call ran 40 minutes. " + "Every line of the transcript. ".repeat(400);
  const before = useInboxStore.getState().signals;
  await act(async () => { useInboxStore.setState({ signals: { ...(before ?? {}), f1: { _id: "f1", short_id: "sg-1", task_id: base.caseId, source: "person", kind: "bug", title: "Caller was cut off mid-pitch", detail_md: long, created_at: now - H, observed_at: now - H } } } as any); });
  await act(async () => { root.render(React.createElement(WaitingItem, { key: "fold", need: base, now, head: false, onProblem() {}, onRun() {} })); });
  const finding = q("[data-line-finding='sg-1']")!;
  expect(finding).not.toBeNull();
  expect(finding.hasAttribute("data-open")).toBe(false);
  expect(finding.querySelector(".fr-open")).toBeNull();
  const said = q("[data-line-need-said] .fr")!;
  expect(said.hasAttribute("data-open")).toBe(false);
  expect(q("[data-line-need-said] .lwn-said")).toBeNull();
  await act(async () => { said.querySelector<HTMLButtonElement>(".fr-row")!.click(); });
  expect(q("[data-line-need-said] .lwn-said")?.textContent).toContain("still needs Cameron's yes before it ships");
  await act(async () => { finding.querySelector<HTMLButtonElement>(".fr-row")!.click(); });
  expect(q("[data-line-finding='sg-1'] .fr-open")?.textContent).toContain("Every line of the transcript.");
  await act(async () => { useInboxStore.setState({ signals: before } as any); });
});

test("a fix nobody answered offers its card's own answers: the recommended one first, the saved fix landed from its branch, Drop closing the problem with no run, Ask again priced as a new run", async () => {
  const before = useInboxStore.getState().lineCards;
  const lapsed = { ...needs.find((n: any) => n.ref === "ct-6"), kind: "lapsed", key: "lapsed:ct-77", ref: "ct-77", caseId: "t-77", problemRef: "ct-77", title: "Replies miss the account", runId: "r-77" };
  for (const [verdict, first] of [["drop", "Drop: close the problem"], ["ship", "Ship this fix"]] as const) {
    useInboxStore.setState({ lineCards: { ...(before ?? {}), c77: { _id: "c77", short_id: "sd-77", task_id: "t-77", status: "withdrawn", created_at: now, card: { recommend: { verdict, why: "x" } } } } } as any);
    await act(async () => { root.render(React.createElement(WaitingItem, { key: verdict, need: lapsed, now, head: false, onProblem() {}, onRun() {} })); });
    const acts = [...document.querySelectorAll("[data-line-closed-acts] > button")].map((b) => b.textContent ?? "");
    // A built fix (WaitingItem's lapsed dock is built) lands from its branch without a new run.
    expect(acts.length).toBe(3);
    expect(acts[0].startsWith(first)).toBe(true);
    expect(acts.some((a) => a.startsWith("Ship this fix"))).toBe(true);
    expect(acts.find((a) => a.startsWith("Ask again"))).toMatch(/^Ask again \(new run/);
  }
  useInboxStore.setState({ lineCards: before } as any);
});

test("a need the address names that is not an open decision says so, and never opens another item in its place", async () => {
  selects.length = 0;
  await render("need=ct-99");
  expect(q("[data-line-foryou-reader]")?.dataset.lineForyouReader).toBe("missing");
  expect(q("[data-line-foryou-missing]")?.textContent).toContain("Not an open decision");
  expect(q("[data-line-foryou-missing] a")?.textContent).toBe("Open the problem");
  expect(host.querySelector(".fy-row[aria-current='true']")).toBeNull();
  expect(selects).toEqual([]);
});

test("a problem that left the list keeps its name, says what moved it, and offers the next waiting item first", async () => {
  selects.length = 0;
  const live = { ...history, attempts: [{ runId: "r20", n: 3, start: now - 7 * 60_000, end: null, live: true, outcome: { end: null, text: "running" }, card: null }], occurrences: [{ at: now - 8 * 60_000, reopened: false }] };
  await render("need=ct-20", { ...workspace, problems: [issue("6"), { ...issue("20"), title: "Cold nudges stop after 5 failed attempts even when the failures are a provider outage, so 40 contacts never get their nudge", history: live }] });
  const left = q("[data-line-foryou-left]")!;
  expect(left.querySelector(".fy-title")?.textContent).toContain("so 40 contacts never get their nudge");
  expect(left.querySelector("[data-line-foryou-moved] dd")?.textContent).toBe("Run 3 started again 7m ago after a new finding");
  expect([...left.querySelectorAll(".fy-left-acts > *")].map((a) => a.textContent)).toEqual(["Next decision", "Open the run", "Open the problem"]);
  await act(async () => { left.querySelector<HTMLButtonElement>("[data-line-foryou-next]")!.click(); });
  expect(selects.at(-1)?.[0]).toMatchObject({ need: "sd-3" });
});

test("an item answered while open leaves the list and the next one opens in its place", async () => {
  await render("need=sd-3");
  selects.length = 0;
  await render("need=sd-3", { ...workspace, needs: needs.filter((n: any) => n.ref !== "sd-3") });
  expect(selects.at(-1)).toEqual([{ need: "sd-5", decision: null, card: null }, { replace: true }]);
});

test("a new problem is confirmed real in one press, a note optional (ct-58683)", async () => {
  const writes: any[] = [];
  useInboxStore.setState({ updateTask: async (ref: string, patch: any) => { writes.push([ref, patch]); }, addTaskComment: async () => {} } as any);
  const conf = lineNeeds([{ kind: "confirm", label: "", rows: [row("confirm", "7", { title: "Grader faulted Eric", note: "The fix is probably in the grader prompt. A person needs to say what Eric's card showed." })] }] as any, { row: () => "line" });
  await renderNeed(conf[0]);
  expect(q("[data-line-ask-q]")?.textContent).toBe("Is this a real problem?");
  expect(q("[data-line-ask-cause]")).toBeNull();
  const yes = q("[data-line-ask-confirm]") as HTMLButtonElement;
  expect(yes.textContent).toBe("Yes, it is real");
  await act(async () => { yes.click(); });
  expect(writes).toEqual([["ct-7", { readiness: "ready", readiness_note: "Confirmed by a person." }]]);
});

test("a confirm whose open question weighs causes answers both at once: each cause is a yes, beside Not a problem (ct-58683)", async () => {
  const writes: any[] = [];
  useInboxStore.setState({ updateTask: async (ref: string, patch: any) => { writes.push([ref, patch]); }, addTaskComment: async () => {} } as any);
  // Grounding's note as saved, cut inside its second alternative.
  const conf = lineNeeds([{ kind: "confirm", label: "", rows: [row("confirm", "17", { title: "Grader faulted Eric", note: "The fix is probably in the grader prompt or in how card context is built, but the signal doesn't say which. A person needs to confirm whether the card's name set came from truncated data (a data or code bug) or from th\u2026" })] }] as any, { row: () => "line" });
  await renderNeed(conf[0]);
  // The question asked is its own, whole to a sentence end; each yes below answers it.
  expect(q("[data-line-ask-q]")?.textContent).toBe("Is it true that the card's name set came from truncated data (a data or code bug)?");
  expect(q("[data-line-ask-open]")).toBeNull();
  const acts = [...(q(".ask-acts")?.children ?? [])].map((b) => b.textContent);
  expect(acts).toEqual(["Yes: the card's name set came from truncated dataA data or code bug", "Yes, another cause", "Not a problem"]);
  await act(async () => { (q("[data-line-ask-cause]") as HTMLButtonElement).click(); });
  expect(writes).toEqual([["ct-17", { readiness: "ready", readiness_note: "Confirmed: Real: The card's name set came from truncated data (a data or code bug)" }]]);
});

test("a question said as a statement is asked as a question, each alternative a one-press answer (ct-58311)", async () => {
  const writes: any[] = [];
  useInboxStore.setState({ updateTask: async (ref: string, patch: any) => { writes.push([ref, patch]); }, addTaskComment: async () => {} } as any);
  const qn = lineNeeds([{ kind: "question", label: "", rows: [row("question", "8", { title: "One consistent rep", note: "Akash dealt with Quinn but the follow-ups were signed Riley. It can't be worked yet because the report says the persona rule is under review, and nothing says whether Quinn has actually left (so Riley is correct) or is still active (so the switch is the bug)." })] }] as any, { row: () => "line" });
  await renderNeed(qn[0]);
  expect(q("[data-line-ask-q]")?.textContent).toBe("Has Quinn actually left, or is Quinn still active?");
  const choices = [...host.querySelectorAll<HTMLButtonElement>("[data-line-ask-choice]")];
  expect(choices.map((c) => c.textContent)).toEqual(["Quinn has actually leftSo Riley is correct", "Quinn is still activeSo the switch is the bug"]);
  // The choices answer in one press; the free box has its own button, idle until something is typed.
  expect(q("[data-line-ask-confirm]")?.textContent).toBe("Answer with this");
  expect((q("[data-line-ask-confirm]") as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { choices[1].click(); });
  expect(writes).toEqual([["ct-8", { readiness: "ready", readiness_note: "Confirmed: Quinn is still active (so the switch is the bug)" }]]);
});

test("a problem opened on a finding that says nothing asks no question: No supporting finding, Close first (ct-57470)", async () => {
  const writes: any[] = [];
  const rule = "A change to outbound cold email ships only after an A/B test shows it works as well as what it replaces.";
  useInboxStore.setState({
    updateTask: async (ref: string, patch: any) => { writes.push([ref, patch]); }, addTaskComment: async () => {},
    tasks: { "9": { _id: "9", short_id: "ct-9", source: "signal", status: "open", readiness: "needs_context", title: rule, project_id: "p1",
      description: `Opened by a bug report from AgentWatch.\n\nAbout: the match judge\n\n**${rule}** (severity 5/10, ex-matching-engine-1)\n\nplaceholder\n\n1 finding in this AgentWatch cluster (match judge).` } },
  } as any);
  const qn = lineNeeds([{ kind: "question", label: "", rows: [row("question", "9", { title: rule, note: "The finding body is just 'placeholder'. Someone needs to open the linked cluster and name the violating change before work starts." })] }] as any, { row: () => "line" });
  await renderNeed(qn[0]);
  expect(q("[data-line-ask-kind]")?.getAttribute("data-line-ask-kind")).toBe("unsupported");
  expect(q("[data-line-ask-q]")?.textContent).toBe("No supporting finding");
  expect(host.textContent).not.toContain("open the linked cluster");
  const close = q("[data-line-ask-drop]") as HTMLButtonElement;
  expect(close.hasAttribute("data-primary")).toBe(true);
  expect(close.textContent).toBe("Close: no evidence");
  // Keeping it starts paid work: "It is real" opens the review and writes nothing until confirmed.
  await act(async () => { (q("[data-line-ask-confirm]") as HTMLButtonElement).click(); });
  expect(writes).toEqual([]);
  expect(document.body.textContent).toContain("Keep it as a problem");
  await act(async () => { close.click(); });
  expect(writes).toEqual([["ct-9", { status: "dropped" }]]);
  useInboxStore.setState({ tasks: {} } as any);
});

test("what the stopped step advised leads: a wait is the primary and parks the problem, its yes is the second act; with no advice no answer leads", async () => {
  const updates: Array<[string, unknown]> = [];
  const real = { updateTask: useInboxStore.getState().updateTask, addTaskComment: useInboxStore.getState().addTaskComment };
  useInboxStore.setState({ updateTask: async (id: string, patch: unknown) => { updates.push([id, patch]); }, addTaskComment: async () => {} } as any);
  const base = needs.find((n: any) => n.ref === "ct-6");
  const draw = async (need: any) => { await act(async () => { root.render(React.createElement(WaitingItem, { key: JSON.stringify(need.fail?.advice ?? null), need, now, head: false, onProblem() {}, onRun() {} })); }); };
  await draw(base);
  expect(q("[data-line-need-advice]")).toBeNull();
  expect(q("[data-line-start-again]")?.hasAttribute("data-primary")).toBe(false);
  // With no advice recorded, waiting is still offered beside going on, and neither leads; the step finished, never "stopped".
  expect(q("[data-line-need-wait]")?.hasAttribute("data-primary")).toBe(false);
  expect(q("[data-line-need-dock]")?.textContent).toContain("Finished");
  expect(q("[data-line-need-dock]")?.textContent).not.toContain("Stopped");
  await draw({ ...base, fail: { ...base.fail, advice: { act: "wait", by: null, why: "Still one case." } } });
  expect(q("[data-line-need-advice]")?.textContent).toBe("Prove recommends: wait");
  expect(q("[data-line-need-wait]")?.hasAttribute("data-primary")).toBe(true);
  expect(q("[data-line-start-again]")?.textContent).toBe("Go on to Build anyway (new run)");
  expect(q("[data-line-start-again]")?.hasAttribute("data-primary")).toBe(false);
  await act(async () => { q("[data-line-need-wait]")!.click(); });
  expect(updates[0]).toEqual(["ct-6", { readiness: "needs_context", readiness_note: "Prove advised it waits for more findings: Still one case." }]);
  expect(q("[data-line-need-wait-recorded]")).not.toBeNull();
  await draw({ ...base, fail: { ...base.fail, advice: { act: "review", by: "an engineer", why: "It changes the runner." } } });
  expect(q("[data-line-need-advice]")?.textContent).toBe("Prove recommends: review by an engineer");
  expect(q("[data-line-start-again]")?.textContent).toBe("Reviewed: go on to Build (new run)");
  expect(q("[data-line-start-again]")?.hasAttribute("data-primary")).toBe(false);
  useInboxStore.setState(real as any);
});

test("a built fix opens with the decision its run's session presented, and nothing structured stands in for one that has none", async () => {
  const before = { lineCards: useInboxStore.getState().lineCards, workflowRuns: useInboxStore.getState().workflowRuns };
  const built = { ...needs.find((n: any) => n.ref === "ct-6"), kind: "review", key: "review:t-88", ref: "ct-88", caseId: "t-88", problemRef: "ct-88", title: "Warm offers ride the cold rail", runId: "r-88", fail: { key: "review:implement", step: "implement", label: "Handed off for review", raw: "", review: { ask: "Needs a look", gate: "Eval red" } } };
  const opened: unknown[][] = [];
  const draw = async (need: any, key: string) => { await act(async () => { root.render(React.createElement(WaitingItem, { key, need, head: false, onProblem() {}, onRun: (...a: unknown[]) => { opened.push(a); } })); }); };
  await act(async () => { useInboxStore.setState({ workflowRuns: { ...before.workflowRuns, "r-88": { _id: "r-88", task_id: "t-88", status: "failed", node_statuses: [{ node_id: "prove", label: "Prove", status: "completed", session: { _id: "s-prove" } }, { node_id: "implement", label: "Implement", status: "failed", session: { _id: "s-build" } }, { node_id: "eval", status: "failed" }] } } } as any); });

  // No session presented it: one line naming the step it is with, that session and the run. No gates, files or findings.
  await draw(built, "none");
  expect(q("[data-line-need-review]")?.getAttribute("data-line-need-review")).toBe("not-presented");
  expect(q("[data-line-need-not-presented] > span")?.textContent).toBe("Waiting on Implement to present it");
  expect(q("[data-line-need-session]")?.getAttribute("data-line-need-session")).toBe("s-build");
  await act(async () => { q("[data-line-need-run]")!.click(); });
  expect(opened).toEqual([["r-88", "t-88"]]);
  expect(q("[data-line-decision]")).toBeNull();
  expect(q(".lwn-col")!.children.length).toBe(1);
  expect(q("[data-line-need-evidence]")).toBeNull();
  // A plan approval the run once asked is not the fix presented.
  await act(async () => { useInboxStore.setState({ lineCards: { ...(before.lineCards ?? {}), c86: { _id: "c86", short_id: "sd-86", task_id: "t-88", workflow_run_id: "r-88", gate_node_id: "plan_gate", status: "answered", created_at: now } } } as any); });
  expect(q("[data-line-decision]")).toBeNull();
  // The build's plumbing (branch, send back, land) is the run's: off its page no dock, on it the dock carries it.
  expect(q("[data-line-need-dock]")).toBeNull();
  await act(async () => { root.render(React.createElement(WaitingItem, { key: "run-page", need: built, head: false, runShown: "r-88", onProblem() {}, onRun() {} })); });
  expect(q("[data-line-need-dock]")).not.toBeNull();

  // The run's session presented it: its decision is the page, whatever another run's decision or this run's plan approval says.
  await act(async () => { useInboxStore.setState({ lineCards: { ...(before.lineCards ?? {}), c87: { _id: "c87", short_id: "sd-87", task_id: "t-88", workflow_run_id: "r-old", status: "withdrawn", created_at: now }, c86: { _id: "c86", short_id: "sd-86", task_id: "t-88", workflow_run_id: "r-88", gate_node_id: "plan_gate", status: "answered", created_at: now }, c88: { _id: "c88", short_id: "sd-88", task_id: "t-88", workflow_run_id: "r-88", gate_node_id: "decide", status: "answered", created_at: now - H } } } as any); });
  for (const kind of ["review", "unlanded"]) {
    await draw({ ...built, kind, fail: kind === "review" ? built.fail : null }, kind);
    expect(q("[data-line-need-review]")?.getAttribute("data-line-need-review")).toBe("decision");
    expect(q("[data-line-need-review] > [data-line-decision]")?.getAttribute("data-line-decision")).toBe("sd-88");
    expect(q("[data-line-need-not-presented]")).toBeNull();
    expect(q("[data-line-need-dock] [data-line-need-run]")).not.toBeNull();
  }
  await act(async () => { useInboxStore.setState(before as any); });
});

test("a trial card no session presented is the same one line, never a panel of its figures", async () => {
  const before = useInboxStore.getState().workflowRuns;
  await act(async () => { useInboxStore.setState({ workflowRuns: { ...before, "r-34": { _id: "r-34", task_id: "t-34", status: "paused", node_statuses: [{ node_id: "review_words", label: "Reviewer", status: "running", session: { _id: "s-words" } }] } } } as any); });
  const card = { ...needs.find((n: any) => n.ref === "ct-6"), kind: "decision", key: "decide:tc-34", ref: "tc-34", cardRef: "tc-34", decisionRef: null, trial: true, caseId: "t-34", problemRef: "ct-34", runId: "r-34", fail: null };
  await act(async () => { root.render(React.createElement(WaitingItem, { key: "tc", need: card, head: false, onProblem() {}, onRun() {} })); });
  expect(q("[data-line-need-not-presented]")?.getAttribute("data-line-need-not-presented")).toBe("preparing");
  expect(q("[data-line-need-not-presented] > span")?.textContent).toBe("Reviewer is preparing this decision");
  expect(q("[data-line-need-session]")?.getAttribute("data-line-need-session")).toBe("s-words");
  expect(q("[data-line-trial-panel]")).toBeNull();
  await act(async () => { useInboxStore.setState({ workflowRuns: before } as any); });
});

test("an older address's who and group open the list on the matching tab and owner", async () => {
  await render("who=u2&group=none");
  expect(listed()).toEqual(["sd-3@user:u2"]);
  await render("who=none");
  expect(listed()).toEqual(["sd-5@none"]);
  await render("who=me");
  expect(listed()).toEqual([]);
});
