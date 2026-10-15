// Mounts one problem's page in jsdom (line-journeys.md LJ8.3) on a cause
// shaped like Union's real AgentWatch runs: a fix merged and deployed, the
// problem coming back after it, a third run live. Checks what a person can do
// there: the head says the problem once and where it stands once; the band
// holds the act for its state (a waiting decision answerable in place, a
// failure started again only through a review); each finding opens in place,
// whole, with the link named for where it goes; the runs read as Work rows;
// and none of the old page's furniture (Came from, tiles, chart, pills) is drawn.
import { afterAll, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { replaceGlobals } from "../../../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/line?view=problems&case=t1", pretendToBeVisual: true });
class NoResize { observe() {} unobserve() {} disconnect() {} }
const restoreGlobals = replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent,
  NodeFilter: dom.window.NodeFilter, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, DocumentFragment: dom.window.DocumentFragment,
  ResizeObserver: NoResize, requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number, cancelAnimationFrame: (id: number) => clearTimeout(id),
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => undefined, useAction: () => async () => null, useConvex: () => ({ query: async () => null, mutation: async () => null }) }));
const noThrow = await import("../../../../../../hooks/useQueryNoThrow");
mock.module("../../../../../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined }) }));

const { useInboxStore } = await import("../../../../../../store/inboxStore");
const { buildLineModel } = await import("../../../../../../lib/line/lineModel");
const { agentwatchGraph } = await import("../../../../../../lib/line/__tests__/agentwatchGraph.fixture");
const { union57382Run } = await import("../../../../../../lib/line/__tests__/unionLineRuns.fixture");
const { ProblemPage } = await import("../ProblemPage");

const DAY = 86_400_000;
const T0 = union57382Run.created_at;
const NOW = T0 + 30 * DAY;
const SHA = "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3";
const shippedAt = T0 + 5 * DAY;
const done = (node_id: string, at: number) => ({ node_id, status: "completed", outcome: "success", started_at: at, completed_at: at + 60_000 });
const base = { ...union57382Run, task_id: "t1", workflow_slug: "agentwatch", updated_at: union57382Run.updated_at ?? T0 } as any;
const second = {
  ...base, _id: "run-2", status: "completed", created_at: T0 + 4 * DAY, updated_at: shippedAt + DAY,
  node_statuses: [
    ...(base.node_statuses ?? []).filter((n: any) => n.node_id !== "prove" && n.node_id !== "refine").map((n: any) => ({ ...n, started_at: T0 + 4 * DAY, completed_at: T0 + 4 * DAY + 1 })),
    done(CARD_GATE_NODE_ID, shippedAt - DAY), done("ship", shippedAt), done("merge", shippedAt), done("watch", shippedAt + 1),
  ],
  merge: { sha: SHA, branch: "line/ct-57382", into: "main", at: shippedAt, pr_url: "https://github.com/unionmatching/union/pull/812" },
};
const card = {
  _id: "d-card", short_id: "sd-9", status: "answered", workflow_run_id: "run-2", task_id: "t1", gate_node_id: CARD_GATE_NODE_ID, created_at: shippedAt - 2 * DAY,
  options: [{ label: "[S] Ship" }, { label: "[R] Revise" }], answer_index: 0, resolved_at: shippedAt - DAY,
  card: { headline: "Keep the sender fixed per thread", change: "Pin the sender identity on the thread's first send", recommend: { verdict: "ship", why: "The eval holds" }, diff: { files: 3, added: 42, removed: 7, pr: "https://github.com/unionmatching/union/pull/812" } },
};
const task = { _id: "t1", short_id: "ct-57382", title: "Not met: Sender identity re-derived per send", status: "in_progress", project_id: "p1", goal_ref: "g-1", created_at: T0 - 5 * DAY, cause: { signal_count: 3, first_seen: T0 - 3 * DAY, last_seen: shippedAt + 4 * DAY, fingerprints: [] } };
const failed = { ...base, _id: "run-3", status: "failed", fail_reason: "no outgoing edge from investigate (outcome failure, review_verdict none)", current_node_id: "investigate", created_at: T0 + 20 * DAY, updated_at: T0 + 20 * DAY + 60_000,
  node_statuses: [done("bind", T0 + 20 * DAY), { node_id: "investigate", status: "failed", outcome: "failure", started_at: T0 + 20 * DAY, completed_at: T0 + 20 * DAY + 2000, result_preview: "Could not read the cluster: the export timed out" }] };
const build = (runs: any[]) => buildLineModel({
  runs, tasks: [task] as any, signals: [], decisions: [card as any], graph: agentwatchGraph, watchDays: 7, now: NOW,
  occurrences: [{ _id: "t1", task_id: "t1", project_id: "p1", sources: ["agentwatch"], since: T0 - 60 * DAY, capped: false, observed: [T0 - 3 * DAY, shippedAt + 3 * DAY, shippedAt + 4 * DAY], reopened: [shippedAt + 3 * DAY] }],
  deploys: [{ _id: "dep-1", project_id: "p1", at: shippedAt + DAY, sha: SHA.slice(0, 12), repository: "unionmatching/union", surface: "backend", environment: null, version: null, source: "codecast", via: "repository", title: "Deployed backend", url: null }],
} as any, "agentwatch");

const signals = [
  { _id: "s0", short_id: "sg-10", source: "person", kind: "bug", title: "Sender identity re-derived per send", observed_at: T0 - 3 * DAY, created_at: T0 - 3 * DAY, task_id: "t1", user_id: "u2",
    detail_md: "Evidence read Oct 8 on the box: the thread's second send came from Riley.\n\nCause: the sender is chosen per send, not per thread.", evidence_url: "https://admin.unionmatching.com/admin/agent-runs?run=3a3b" },
  { _id: "s1", short_id: "sg-11", source: "agentwatch", kind: "prompt_miss", title: "Not met: A contact deals with one consistent representative", observed_at: shippedAt + 3 * DAY, created_at: shippedAt + 3 * DAY, task_id: "t1",
    detail_md: "**A contact deals with one consistent representative.** (severity 6/10, ex-1)\n\nGabe heard from Quinn, then Riley.\n\n> Quick update on the note I sent Monday\n\nBreaks expectation `ex-1`.\n\n128 findings in this AgentWatch cluster (comms judge).", evidence_url: "https://admin.unionmatching.com/admin/agent-watch?cluster=c&finding=f" },
  { _id: "s2", short_id: "sg-12", source: "judge:comms", kind: "bug", judge: "comms", moment: "mo-7", subject: "ex-1", title: "Riley signed Quinn's thread", observed_at: shippedAt + 4 * DAY, created_at: shippedAt + 4 * DAY, task_id: "t1" },
];

const picks: Array<Record<string, unknown>> = [];
/** How each pick lands in history (LineSelectOptions), beside it. */
const pickOpts: Array<unknown> = [];
const props = (m: any, inbox: any[] = [], needs: any[] = []) => ({
  model: m, order: ["t0", "t1", "t2"],
  workspace: {
    model: m, project: null, projects: [{ _id: "p1", title: "Union" }], graphKey: "agentwatch", unread: false, now: NOW, rollup: null, allRollups: [],
    rows: { signals: [], tasks: [task], runs: [], decisions: [] }, sources: new Map(), admissions: new Map([["p1", { role: { id: "r", handle: "lead", paused: false }, on: true, slots: 2, busy: 0, hands: 0, handsCap: 6, queued: 0 }]]),
    trialProjects: new Set(), trialRuns: new Set(), overlaps: new Map(), names: new Map(), inbox, needs, forYou: 0,
  } as any,
  selection: { view: "problems", mode: "table", project: null, graph: null, step: null, tab: null, run: null, case: "t1", source: null, finding: null, ask: false, card: null, decision: null, need: null, status: null, quiet: false, q: null, sort: null, win: null } as any,
  select: (p: Record<string, unknown>, _c?: unknown, o?: unknown) => { picks.push(p); pickOpts.push(o); },
  href: () => "/line?view=problems",
});

async function mount(p: ReturnType<typeof props>, store: Record<string, unknown> = {}) {
  picks.length = 0;
  useInboxStore.setState({ currentUser: { _id: "u1", name: "Me" }, signals: Object.fromEntries(signals.map((s) => [s._id, s])), sessionDecisions: {}, lineCards: {}, trialCards: {}, workflowRuns: {}, tasks: { t1: task }, projects: { p1: { _id: "p1", title: "Union" } }, ...store } as any);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(ProblemPage, p as any)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { host, root };
}
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); }); };

describe("ProblemPage", () => {
  test("says the problem once, where it stands once, and draws none of the old furniture", async () => {
    const { host, root } = await mount(props(build([second, base])));
    const page = host.querySelector('[data-line-view="problem"]')!;
    expect(text(page.querySelector(".pp-title"))).toBe("Not met: Sender identity re-derived per send");
    // Merged and deployed, then two findings after it: the one state line says so, and nothing else on the page repeats it.
    const state = text(page.querySelector("[data-line-state]"));
    expect(state).toMatch(/^In production .+, 2 since$/);
    expect(text(page).split(state).length).toBe(2);
    expect(page.getAttribute("data-band")).toBe("production");
    for (const gone of [".lwt-from", ".lwt-stats", ".lwp-pill", ".lwt-brief", "[data-line-came-from]"]) expect(page.querySelector(gone)).toBeNull();
    // The page leads with the problem's life on one axis, above where its newest run stands.
    expect(page.querySelector("[data-line-problem-timeline] .lwt-chart")).not.toBeNull();
    const order = [...page.querySelectorAll(".pp-title, [data-line-problem-timeline], [data-line-stage-track]")].map((e) => e.matches(".pp-title") ? "title" : e.matches("[data-line-stage-track]") ? "stage" : "timeline");
    expect(order).toEqual(["title", "timeline", "stage"]);
    // The old labels, as labels: a finding's own words may say "came from".
    expect(text(page)).not.toMatch(/Came from|First seen|Newest|Brief for the next run|card unanswered/);
    // The band's facts: merged with its pull request, in production on its date, findings since.
    const band = page.querySelector("[data-line-band]")!;
    expect(text(band)).toMatch(/Merged.+the pull request/);
    expect(text(band)).toMatch(/Since\s?2 findings/);
    // prev and next walk the list it came from.
    const [prev, next] = [...page.querySelectorAll(".pp-crumbs .lw-iconbtn")] as HTMLButtonElement[];
    expect(prev.disabled).toBe(false);
    await click(next);
    expect(picks.at(-1)).toMatchObject({ case: "t2" });
    root.unmount();
  });

  test("findings open in place, whole: one line each on arrival; a judge's opens its moment; a person's shows all its words and the link it points to", async () => {
    const { host, root } = await mount(props(build([second, base])));
    const rows = [...host.querySelectorAll(".fr")];
    expect(rows.map((r) => r.getAttribute("data-line-finding"))).toEqual(["sg-12", "sg-11", "sg-10"]);
    // Nothing is open on arrival (a finding can hold a whole call). Opened, a judge finding shows the moment it read, and can be marked wrong.
    expect(host.querySelector(".fr[data-open]")).toBeNull();
    await click(rows[0].querySelector(".fr-row"));
    expect(rows[0].querySelector('[data-line-finding-open="moment"]')).not.toBeNull();
    expect(rows[0].querySelector("[data-line-moment]")).not.toBeNull();
    expect(text(rows[0].querySelector('[data-line-judge-wrong="open"]'))).toBe("Judge is wrong");
    // The moment the fix went live divides the list: the two findings above it count against the fix. Its date is the
    // band's, never said again on the divider.
    expect(text(host.querySelector("[data-line-findings-divider]"))).toBe("Went live");
    expect(rows[1].hasAttribute("data-since")).toBe(true);
    // Open the AgentWatch finding: its words whole, without its bookkeeping, and the link named for where it goes; no "Judge is wrong".
    await click(rows[1].querySelector(".fr-row"));
    const open = host.querySelector('[data-line-finding="sg-11"] .fr-open')!;
    expect(text(open)).toContain("Gabe heard from Quinn, then Riley.");
    expect(text(open)).toContain("Quick update on the note I sent Monday");
    expect(text(open)).not.toMatch(/128 findings|Breaks expectation|severity 6/);
    // The link is small: where it goes in a word, named in full on its title.
    expect(text(open.querySelector("[data-line-finding-link]"))).toBe("Open the finding in Union");
    expect(open.querySelector("[data-line-judge-wrong]")).toBeNull();
    expect(picks.at(-1)).toEqual({ finding: "sg-11" });
    // A click that opens a finding is a history entry: Back closes it and stays on the problem.
    expect(pickOpts.at(-1)).toEqual({ push: true });
    // The person's finding: every paragraph, and its agent run link.
    await click(rows[2].querySelector(".fr-row"));
    const person = host.querySelector('[data-line-finding="sg-10"] .fr-open')!;
    expect(text(person)).toContain("Cause: the sender is chosen per send, not per thread.");
    expect(text(person.querySelector("[data-line-finding-link]"))).toBe("Open the agent run in Union");
    // Closing one rewrites the entry rather than adding one.
    await click(host.querySelector('[data-line-finding="sg-10"] .fr-row'));
    expect(pickOpts.at(-1)).toEqual({ replace: true });
    root.unmount();
  });

  test("Work: one row per run, newest open, with what it found, changed and how it ended; Open run goes to the run", async () => {
    const { host, root } = await mount(props(build([second, base])));
    const runs = [...host.querySelectorAll(".pw-run")];
    expect(runs.length).toBe(2);
    expect(text(runs[0].querySelector(".pw-n"))).toBe("Run 2");
    expect(text(runs[0].querySelector(".pw-what"))).toBe("Keep the sender fixed per thread");
    expect(text(runs[0].querySelector(".pw-out"))).toBe("In production");
    expect(text(runs[0].querySelector(".pw-body"))).toMatch(/Change.+the pull request/);
    await click(runs[0].querySelector("[data-line-open-run]"));
    expect(picks.at(-1)).toMatchObject({ run: "run-2" });
    root.unmount();
  });

  test("a failed run: the band names the step and its reason, and Start again opens a review, never a run", async () => {
    const m = build([failed, second, base]);
    const row = { key: "failed:run-3", kind: "failed", at: T0 + 20 * DAY, projectId: "p1", title: task.title, ref: task.short_id, detail: null, caseId: "t1", runId: "run-3", cardId: null, cardRef: null,
      fail: { key: "deadend-failed:investigate", step: "investigate", label: "Investigate failed: Could not read the cluster", raw: "" } };
    const { host, root } = await mount(props(m, [{ kind: "failed", label: "Failed", rows: [row] }]));
    const band = host.querySelector('[data-line-band="failed"]')!;
    expect(band).not.toBeNull();
    expect(text(host.querySelector("[data-line-state]"))).toMatch(/^Failed at /);
    // The reason heads with the step's word; the step's own words follow whole, said once.
    expect(text(band.querySelector(".pb-reason"))).toBe("Investigate failed");
    expect(text(band.querySelector(".pb-output"))).toBe("Could not read the cluster: the export timed out");
    const start = band.querySelector("[data-line-start-again]")!;
    expect(text(start)).toMatch(/^Start again/);
    const calls: string[] = [];
    useInboxStore.setState({ startLineCause: async (id: string) => { calls.push(id); } } as any);
    await click(start);
    expect(document.querySelector("[data-switch-review]")).not.toBeNull();
    expect(calls).toEqual([]);
    await click(document.querySelector("[data-switch-cancel]"));
    expect(calls).toEqual([]);
    root.unmount();
  });

  test("a decision that waits on the viewer is in the band, answerable, with no ?decision= in the address", async () => {
    const m = build([second, base]);
    const need = { key: "decide:d1", ref: "sd-20", kind: "decision", counted: true, ask: "Ship it?", title: task.title, problemRef: task.short_id, caseId: "t1", projectId: "p1", process: "agentwatch", since: NOW - DAY, runId: "run-2", decisionRef: "sd-20", cardRef: null, trial: false, note: null, fail: null, why: null, findings: 3 };
    const { host, root } = await mount(props(m, [], [need]));
    const band = host.querySelector('[data-line-band="decision"]')!;
    expect(band).not.toBeNull();
    expect(band.hasAttribute("data-boxed")).toBe(true);
    expect(band.querySelector('[data-line-decision="sd-20"]')).not.toBeNull();
    expect(text(host.querySelector("[data-line-state]"))).toMatch(/^Fix to decide, since /);
    root.unmount();
  });

  test("a question waits in the band with its answer box; Answer marks the problem ready with the answer", async () => {
    const m = build([second, base]);
    const t = { ...task, status: "open", readiness: "needs_context", readiness_note: "Akash dealt with Quinn but the follow-ups were signed Riley. It can't be worked yet because nothing says whether Quinn has left or is still active?" };
    const p = props(m);
    const issue = p.model.issues.find((i: any) => i.id === "t1")!;
    (issue as any).ask = t.readiness_note;
    const writes: unknown[] = [];
    const { host, root } = await mount(p, { tasks: { t1: t }, updateTask: async (...a: unknown[]) => { writes.push(a); }, addTaskComment: async () => {} });
    const band = host.querySelector('[data-line-band="ask"]')!;
    expect(band).not.toBeNull();
    expect(text(band.querySelector(".ask-q"))).toMatch(/whether Quinn has left or is still active\?$/);
    const box = band.querySelector("[data-line-ask-box]") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Quinn left on Oct 1");
      box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await click(band.querySelector("[data-line-ask-confirm]"));
    expect(writes).toEqual([["ct-57382", { readiness: "ready", readiness_note: "Confirmed: Quinn left on Oct 1" }]]);
    root.unmount();
  });
});
