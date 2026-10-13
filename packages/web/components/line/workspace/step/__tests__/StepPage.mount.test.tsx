// Mounts the step page (line-journeys.md LJ8.6) on fixture steps. A person's
// step opens on what waits there, the first waiting row open as the real thing
// (WaitingItem, stubbed here: it is tested where it lives) and no answer drawn
// as an inert row with key caps. An agent's step groups its failures by cause,
// each heading carrying Edit instructions, which opens the instructions in edit;
// an open row reads its report in plain words, without machine paths.
import { afterAll, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/line", pretendToBeVisual: true });
const matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400, matchMedia }),
  document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), matchMedia, IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

mock.module("../../../../../hooks/useSyncCollection", () => ({ useSyncCollection: () => ({ ready: true }), useFeederError: () => {}, entityIdArgs: () => "skip", applyCollectionFeed: () => {}, keyRowsBy: (r: any[]) => r ?? [] }));
// bun shares mock.module across every file in one run: stub only while this
// file runs, and hand later files (ProblemPage, ForYou) the real components.
const realWaiting = await import("../../../widgets/WaitingItem");
const realDecision = await import("../../../widgets/LineDecision");
const RealWaitingItem = realWaiting.WaitingItem;
const RealLineDecision = realDecision.LineDecision;
let stubbing = true;
afterAll(() => { stubbing = false; });
mock.module("../../../widgets/WaitingItem", () => ({ ...realWaiting, WaitingItem: (p: any) => stubbing ? React.createElement("div", { "data-stub-waiting": p.need.ref }, p.need.ask) : React.createElement(RealWaitingItem, p) }));
mock.module("../../../widgets/LineDecision", () => ({ ...realDecision, LineDecision: (p: any) => stubbing ? React.createElement("div", { "data-stub-decision": p.id }) : React.createElement(RealLineDecision as any, p) }));

const { StepPage } = await import("../StepPage");
const { useInboxStore } = await import("../../../../../store/inboxStore");

const now = Date.now();
const dec = (id: string, over: any = {}) => ({
  id: `${id}:s`, runId: `run-${id}`, caseId: `t-${id}`, caseRef: `ct-${id}`, caseTitle: `Problem ${id} with a whole title that is never cut`, at: now - 3_600_000, durationMs: 60_000, status: "done",
  received: { from: null, fromLabel: null, summary: "", said: false, sessionId: null, href: null },
  decided: { outcome: null, words: "Done", result: null, to: null, toLabel: null, toWords: null },
  reasoning: null, label: null, labels: [], ...over,
});
const step = (id: string, kind: string, decisions: any[], extra: any = {}) => ({
  id, kind, label: id === "decide" ? "Decide" : "Prove", fileLabel: null, purpose: kind === "person" ? "You read the change and its proof, then decide." : "Proves one mechanism before anyone writes a fix.",
  stage: "prove", half: "fix", prompt: null, outcomes: [], answers: [], decisions, tally: { total: decisions.length, rows: [], failed: 0, cutOff: 0, live: 0 }, model: null, maxVisits: null, timeoutS: null, ...extra,
});
const outcome = (state: string, words: string, why: string | null = null) => ({ state, verb: state === "answered" ? "Ship" : null, trial: false, words, ref: null, at: null, why });
const decide = step("decide", "person", [dec("1", { status: "waiting" }), dec("2", { status: "waiting", at: now - 7_200_000 }), dec("3", { decided: { outcome: "S", words: "Ship", result: null, to: "ship", toLabel: "Ship", toWords: "Ship" }, answer: outcome("answered", "Would ship · trial") }),
  // The run went on past the card with nobody answering: its visit reads "shipped", yet it is no answer.
  dec("18", { id: "run-18:decide", decided: { outcome: "shipped", words: "Shipped", result: null, to: "ship", toLabel: "Ship", toWords: "Ship" }, answer: outcome("lapsed", "Lapsed") }),
  dec("19", { id: "run-19:decide", status: "failed", answer: outcome("withdrawn", "Withdrawn", "The problem was merged into another while the run waited") })],
  { answers: [{ answer: "Ship", does: "Approve it" }, { answer: "Revise", does: "Send it back" }, { answer: "Drop", does: "Reject it" }] });
const prove = step("prove", "agent", [
  dec("4", { status: "failed", decided: { outcome: "failed", words: "could not write a test for the problem", result: null, to: null, toLabel: null, toWords: null } }),
  dec("5", { status: "failed", decided: { outcome: "failed", words: "could not write a test for the problem", result: null, to: null, toLabel: null, toWords: null } }),
  dec("6", { id: "run-6:prove", reasoning: 'Proved it with a unit test.\n\n```json\n{"outcome":"red"}\n```', decided: { outcome: "red", words: "red", result: { rung: "unit", check: "bun test x.test.ts", red: false, dir: "/Users/ec2-user/.codecast/worktrees/line-6" }, to: null, toLabel: null, toWords: null } }),
], { prompt: { kind: "prompt", text: "Prove one mechanism.", readable: "Prove one mechanism.", includes: [], file: "line/prove.md", version: null, versions: [] } });
const model = { graphKey: "line", title: "Line", graphs: [], graph: { nodes: [], edges: [] }, steps: { decide, prove }, order: ["prove", "decide"], runs: [], issues: [], labels: { right: 0, wrong: 0 } } as any;
const need = (n: string) => ({ key: `decide:${n}`, ref: `sd-${n}`, kind: "decision", counted: true, ask: `Ship the fix for problem ${n}?`, title: "", problemRef: `ct-${n}`, caseId: `t-${n}`, projectId: null, process: "line", since: now, runId: `run-${n}`, decisionRef: `sd-${n}`, cardRef: null, trial: false, note: null, fail: null, why: null, findings: null });
// What the Problems list reads too: a step counts a failure only where Problems files it (useStepFacts standing).
const ws = {
  rows: { runs: [], signals: [], tasks: [], decisions: [] }, needs: [need("1"), need("2")], now, project: null, projects: [],
  allInbox: [], problems: [], sources: new Map(), overlaps: new Map(), admissions: new Map(), trialProjects: new Set(), trialHeld: new Map(), trialRuns: new Set(), names: new Map(), processes: [],
} as any;
const sel = (over: any) => ({ view: "line", mode: "table", project: null, graph: "line", step: null, tab: null, run: null, case: null, source: null, finding: null, ask: false, card: null, decision: null, need: null, status: null, quiet: false, q: null, sort: null, win: null, show: null, ...over });

async function mount(selection: any) {
  const moves: any[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const select = (patch: any, _c?: any, opts?: any) => moves.push({ patch, replace: !!opts?.replace });
  await act(async () => { root.render(<StepPage model={model} workspace={ws} selection={selection} select={select as any} href={() => "#"} />); });
  return { host, root, moves };
}

test("the Decide step opens on what waits, the first waiting decision open and answerable; its answers are never inert rows", async () => {
  const bare = await mount(sel({ step: "decide" }));
  // Opened with no filter, a person's step with something waiting puts show=waiting in the address.
  expect(bare.moves).toContainEqual({ patch: { show: "waiting" }, replace: true });
  bare.root.unmount();

  const { host, root } = await mount(sel({ step: "decide", show: "waiting" }));
  const counts = [...host.querySelectorAll("[data-line-step-count]")].map((b) => b.textContent);
  expect(counts).toEqual(["2Waiting", "2No answer", "1Answered"]);
  const rows = host.querySelectorAll("[data-line-step-row]");
  expect(rows.length).toBe(2);
  // Oldest wait first, and it is open as the real decision.
  expect(rows[0].getAttribute("data-line-step-row")).toBe("t-2");
  expect(rows[0].hasAttribute("data-open")).toBe(true);
  expect(host.querySelector("[data-stub-waiting]")?.getAttribute("data-stub-waiting")).toBe("sd-2");
  expect(host.querySelectorAll(".lw-answer, kbd").length).toBe(0);

  // The Question tab reads the answers as a plain list.
  await act(async () => { (host.querySelector("[data-line-step-tab=instructions]") as HTMLElement).click(); });
  expect([...host.querySelectorAll("[data-line-step-answers] dt")].map((d) => d.textContent)).toEqual(["Ship", "Revise", "Drop"]);
  expect(host.querySelectorAll("kbd, button[data-answer]").length).toBe(0);
  root.unmount();
});

test("an agent's failures are grouped by cause, and the cause's act opens its instructions in edit", async () => {
  const { host, root } = await mount(sel({ step: "prove" }));
  const groups = [...host.querySelectorAll("[data-line-step-group=failed]")];
  expect(groups.length).toBe(1);
  expect(groups[0].querySelector("h3")?.textContent).toBe("2 Could not write a test for the problem");
  // A failed row's one act is to start the problem again.
  await act(async () => { (groups[0].querySelector("[data-line-step-row] .sp-row-tog") as HTMLElement).click(); });
  expect(groups[0].querySelector("[data-line-start-again]")).not.toBeNull();
  await act(async () => { (groups[0].querySelector("[data-line-step-fix]") as HTMLElement).click(); });
  expect(host.querySelector("[data-line-step-instructions=prove]")).not.toBeNull();
  expect(host.querySelector("textarea")).not.toBeNull();
  root.unmount();
});

test("a passed row opens as the run page's own step, with right or wrong as its act", async () => {
  const visit = { index: 0, node: "prove", label: "Prove", kind: "agent", at: now, startedAt: now, completedAt: now + 1, durationMs: 1, status: "done", inferred: false,
    received: { from: null, fromLabel: null, summary: "", said: false, sessionId: null, href: null }, decided: prove.decisions[2].decided, why: "Proved it with a unit test.", sessionId: null };
  model.runs = [{ id: "run-6", caseId: "t-6", caseRef: "ct-6", caseTitle: "Problem 6", status: "completed", live: false, outcome: { tone: "ok", text: "Done" }, at: now, updatedAt: now, durationMs: 1, at_node: "prove", graphHash: null, visits: [visit] }];
  const { host, root } = await mount(sel({ step: "prove", show: "passed" }));
  const row = host.querySelector("[data-line-step-row=t-6]")!;
  expect(row.textContent).toContain("reproduced: its test fails without the fix");
  await act(async () => { (row.querySelector(".sp-row-tog") as HTMLElement).click(); });
  expect(row.querySelector("[data-line-step-visit] [data-run-open-step=prove]")).not.toBeNull();
  // The row's title stays the problem, its ref a link to it.
  expect(row.querySelector(".sp-row-title")?.textContent).toContain("Problem 6");
  expect(row.querySelector("a.sp-row-ref")).toBeNull(); // no openCase in this fixture's nav
  expect(row.querySelector("[data-line-step-mark]")).not.toBeNull();
  model.runs = [];
  root.unmount();
});

test("no answer at a person's step: grouped by its word, no Edit instructions; a lapsed card offers its own answers, the recommended Drop first and free, a closed problem says why", async () => {
  const wrote: any[] = [];
  const real = { updateTask: useInboxStore.getState().updateTask, addTaskComment: useInboxStore.getState().addTaskComment };
  useInboxStore.setState({
    tasks: { "t-18": { _id: "t-18", status: "open", project_id: "p1" }, "t-19": { _id: "t-19", status: "dropped" } } as any,
    lineCards: { c18: { _id: "c18", short_id: "sd-18", status: "withdrawn", workflow_run_id: "run-18", gate_node_id: "decide", created_at: now, card: { recommend: { verdict: "drop", why: "It covers 0 of 7 conversations" } } } } as any,
    updateTask: ((ref: string, patch: any) => { wrote.push(["task", ref, patch]); }) as any,
    addTaskComment: ((ref: string, text: string) => { wrote.push(["comment", ref, text]); }) as any,
  });
  const { host, root } = await mount(sel({ step: "decide", show: "failed" }));
  const groups = [...host.querySelectorAll("[data-line-step-group=failed]")];
  expect(groups.map((g) => g.querySelector("h3")?.textContent).sort()).toEqual(["1 Lapsed", "1 Withdrawn"]);
  expect(host.querySelector("[data-line-step-fix]")).toBeNull();
  const lapsed = host.querySelector("[data-line-step-row=t-18]")!;
  await act(async () => { (lapsed.querySelector(".sp-row-tog") as HTMLElement).click(); });
  expect(lapsed.querySelector("[data-stub-decision]")?.getAttribute("data-stub-decision")).toBe("sd-18");
  // The card recommended Drop: Drop leads, filled; Ask again follows and says it is a new run.
  const acts = [...lapsed.querySelectorAll("[data-line-closed-acts] > button")];
  expect(acts.map((b) => b.textContent)[0]).toBe("Drop: close the problem");
  expect(acts[0].hasAttribute("data-primary")).toBe(true);
  expect(lapsed.querySelector("[data-line-start-again]")?.textContent).toMatch(/^Ask again \(new run/);
  expect(lapsed.querySelector("[data-line-start-again]")?.hasAttribute("data-primary")).toBe(false);
  expect(lapsed.querySelector(".sp-row-title")?.textContent).toContain("Problem 18");
  // Drop records the decision on the problem and closes it; no run starts.
  await act(async () => { (lapsed.querySelector("[data-line-closed-drop]") as HTMLElement).click(); });
  expect(wrote).toContainEqual(["task", "ct-18", { status: "dropped" }]);
  expect(wrote.find((w) => w[0] === "comment")?.[2]).toContain("sd-18");
  expect(lapsed.querySelector("[data-line-closed-dropped]")).not.toBeNull();
  useInboxStore.setState(real as any);
  const withdrawn = host.querySelector("[data-line-step-row=t-19]")!;
  expect(withdrawn.textContent).toContain("merged into another");
  await act(async () => { (withdrawn.querySelector(".sp-row-tog") as HTMLElement).click(); });
  expect(withdrawn.querySelector("[data-line-start-again]")).toBeNull();
  expect(withdrawn.textContent).toContain("nothing to ask again");
  root.unmount();
});
