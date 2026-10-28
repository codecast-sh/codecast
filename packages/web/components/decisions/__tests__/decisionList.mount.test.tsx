// Mounts the Decisions page's list (DecisionsList) and Flows' For you on one
// store fixture: the Team view groups by owner with an Unassigned group of its
// own; a filter narrows it and saves as a view; rows picked together open the
// decision palette, and assigning them repaints their owner at once from the
// store (no server wired here: the paint is the store action's alone); For you
// lists the flows' decisions as the same rows with the same owners.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/decisions" });
const restoreGlobals = replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event,
  localStorage: dom.window.localStorage, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true, CSS: { escape: (s: string) => s }, MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: (f: any) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IntersectionObserver: class { observe() {} disconnect() {} },
});
Object.defineProperties(dom.window.HTMLElement.prototype, {
  offsetHeight: { get() { return this.hasAttribute("data-index") ? 40 : 4000; } },
  offsetWidth: { get: () => 1200 },
});
dom.window.HTMLElement.prototype.scrollTo = () => {};
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

let search = new URLSearchParams("tab=team");
const pushed: string[] = [];
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: (u: string) => pushed.push(u), replace: (u: string) => { pushed.push(u); search = new URLSearchParams(u.split("?")[1] ?? ""); } }),
  useSearchParams: () => search, usePathname: () => "/decisions", useParams: () => ({}),
}));
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => undefined, useConvex: () => ({ query: async () => null, mutation: async () => null }) }));
const noThrow = await import("../../../hooks/useQueryNoThrow");
mock.module("../../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined }) }));

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { DecisionsList } = await import("../DecisionsPage");
const { DecisionPalette } = await import("../DecisionPalette");
const { ForYouView } = await import("../../line/workspace/views/ForYouView");
const { readLineSelection } = await import("../../../lib/line/lineWorkspaceUrl");

const NOW = Date.now();
const H = 3_600_000;
const WS = "team:t1";
const dec = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id, short_id: `sd-${id.slice(1)}`, conversation_id: "c1", session_id: "s1", question: `Question ${id}`, options: [{ label: "Ship" }, { label: "Hold" }],
  blocking: true, status: "pending", created_at: NOW - H, in_queue: false, team_workspace: WS, category: "scope", ...over,
});
// d1 and d2 are flows' decisions (a run asked them about a problem), d3 and d4 sessions' questions.
const flow = (over: Record<string, unknown>) => ({ workflow_run_id: "r1", task_id: "t9", gate_node_id: "decide", team_workspace: undefined, line_workspace: WS, ...over });
const fixture = () => ({
  d1: dec("d1", flow({ holder: { kind: "user", id: "u2" }, problem_severity: 9, problem_findings: 12, problem_reach: 3 })),
  d2: dec("d2", flow({ asked_user_ids: [] })),
  d3: dec("d3", { holder: { kind: "user", id: "u1" }, in_queue: true, created_at: NOW - 30 * H }),
  d4: dec("d4", { holder: { kind: "user", id: "u2" }, blocking: false, category: "approach" }),
});
const savedViews: any[] = [];
beforeEach(() => {
  search = new URLSearchParams("tab=team");
  pushed.length = 0;
  savedViews.length = 0;
  // The store's own decision actions (another file in a run may have stubbed them): the palette's paint is theirs.
  const real = useInboxStore.getInitialState();
  useInboxStore.setState({
    passDecision: real.passDecision, unassignDecision: real.unassignDecision, escalateDecision: real.escalateDecision, answerDecision: real.answerDecision,
    currentUser: { _id: "u1", name: "Me" },
    clientState: { ...useInboxStore.getState().clientState, ui: { active_team_id: "t1" } },
    teamMembers: [{ _id: "u1", name: "Me" }, { _id: "u2", name: "Sam" }, { _id: "u3", name: "Jo" }],
    projects: {}, tasks: {}, savedViews: {},
    sessionDecisions: fixture(),
    createSavedView: (opts: any) => savedViews.push(opts),
  } as any);
});

const host = document.createElement("div");
document.body.appendChild(host);
async function mount(ui: React.ReactElement) {
  const root = createRoot(host);
  await act(async () => { root.render(ui); });
  return { unmount: () => act(async () => root.unmount()) };
}
const rows = () => [...host.querySelectorAll<HTMLElement>("[data-decision-row]")].map((r) => `${r.dataset.decisionRow}@${r.dataset.decisionOwner}`);
const headers = () => [...host.querySelectorAll<HTMLElement>("[data-list-scroll] [data-index]")].filter((r) => !r.querySelector("[data-decision-row]")).map((r) => r.textContent?.replace(/\s+/g, " ").trim());
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); });

test("Team groups every open decision by its owner, Unassigned a group of its own", async () => {
  const m = await mount(<DecisionsList />);
  expect(headers()).toEqual(["SSam(2)", "MMe (you)(1)", "Unassigned(1)"]);
  expect(rows()).toEqual(["sd-1@user:u2", "sd-4@user:u2", "sd-3@user:u1", "sd-2@none"]);
  const tabs = [...host.querySelectorAll("[data-list-tabs] button")].map((b) => b.textContent);
  expect(tabs).toEqual(["Mine1", "Team4", "Unassigned1", "Escalated", "Answered"]);
  await m.unmount();
});

test("a filter narrows the list, shows as a chip, and saves as a view of the Decisions page", async () => {
  search = new URLSearchParams("tab=team&blocking=blocking&owner=user:u2");
  const m = await mount(<DecisionsList />);
  expect(rows()).toEqual(["sd-1@user:u2"]);
  expect(host.querySelector(".cq-filter-bar")?.textContent).toContain("Blocking");
  await click([...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Save view")));
  const input = host.querySelector<HTMLInputElement>("input[placeholder='View name...']")!;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, "Sam's blockers"); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  await act(async () => { input.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  expect(savedViews).toEqual([{ name: "Sam's blockers", page: "decisions", prefs: { tab: "team", owner: "user:u2", blocking: "blocking" } }]);
  await m.unmount();
});

test("rows picked together open the decision palette, and assigning them repaints their owner at once", async () => {
  const m = await mount(<DecisionsList />);
  // Pick sd-1 and sd-4 by their boxes, then the list's actions key opens the palette over both.
  for (const id of ["sd-1", "sd-4"]) await click(host.querySelector(`[data-decision-row="${id}"]`)!.closest("[data-list-row-state], [data-index] > div")!.querySelector("button"));
  await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "d", code: "KeyD", bubbles: true })); });
  const palette = useInboxStore.getState().palette;
  expect([palette.targetType, palette.targets.map((t: any) => t.short_id)]).toEqual(["decision", ["sd-1", "sd-4"]]);

  const p = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { p.render(<DecisionPalette targets={palette.targets} mode={palette.initialMode} standalone onClose={() => useInboxStore.getState().closePalette()} />); });
  const item = (key: string) => document.querySelector(`[data-decision-palette-item="${key}"]`);
  expect([...document.querySelectorAll("[data-decision-palette-item]")].map((e) => e.getAttribute("data-decision-palette-item"))).toEqual(["assign", "pass", "escalate", "answer", "dismiss"]);
  await click(item("assign"));
  await click(item("user:u3"));
  // Both now belong to Jo, painted from the store before any server answer.
  expect(["d1", "d4"].map((id) => (useInboxStore.getState().sessionDecisions as any)[id].passed_to)).toEqual([{ by: "u1", kind: "user", id: "u3" }, { by: "u1", kind: "user", id: "u3" }]);
  expect(rows()).toEqual(["sd-1@user:u3", "sd-4@user:u3", "sd-3@user:u1", "sd-2@none"]);
  expect(headers()).toEqual(["JJo(2)", "MMe (you)(1)", "Unassigned(1)"]);
  await act(async () => p.unmount());
  await m.unmount();
});

test("an answer every picked decision offers answers them all; one some lack is not offered", async () => {
  const p = createRoot(document.body.appendChild(document.createElement("div")));
  const st = useInboxStore.getState().sessionDecisions as any;
  (useInboxStore.getState().sessionDecisions as any).d4 = { ...st.d4, options: [{ label: "Hold" }, { label: "Later" }] };
  const targets = [st.d3, { ...st.d4, options: [{ label: "Hold" }, { label: "Later" }] }];
  useInboxStore.setState({ sessionDecisions: { ...st, d4: targets[1] } } as any);
  await act(async () => { p.render(<DecisionPalette targets={targets} mode="answer" standalone onClose={() => {}} />); });
  const answers = [...document.querySelectorAll("[data-decision-palette-item^='answer:']")].map((e) => e.textContent);
  expect(answers).toEqual(["Hold"]);
  await act(async () => p.unmount());
});

test("For you lists the flows' decisions as the same rows, with the same owners", async () => {
  const need = (id: string, sd: string) => ({ key: `decision:${id}`, ref: sd, kind: "decision", counted: true, decisionId: id, projectId: null, process: "line", since: NOW - H, title: "P", line: "P", ask: "P", name: null, problemRef: null, caseId: null, runId: null, decisionRef: sd, cardRef: null, trial: false, note: null, fail: null, why: null });
  const workspace = { needs: [need("d1", "sd-1"), need("d2", "sd-2")], now: NOW, ready: true, processes: [], projects: [], problems: [], names: new Map(), sources: new Map() } as any;
  const m = await mount(<ForYouView model={{ steps: {}, runs: [] } as any} workspace={workspace} selection={readLineSelection(new URLSearchParams("view=foryou&group=who"))} select={() => {}} href={() => "/flows"} />);
  const forYou = rows();
  // Its problem's people reached and findings stay on the row, read off the decision itself.
  const sd1 = host.querySelector('[data-decision-row="sd-1"]')!;
  expect([sd1.querySelector("[data-decision-reach]")?.textContent, sd1.querySelector("[data-decision-findings]")?.textContent]).toEqual(["3", "12"]);
  await m.unmount();
  const page = await mount(<DecisionsList />);
  const team = rows().filter((r) => forYou.some((f) => f.split("@")[0] === r.split("@")[0]));
  expect(forYou).toEqual(["sd-1@user:u2", "sd-2@none"]);
  expect(forYou).toEqual(team);
  await page.unmount();
});
