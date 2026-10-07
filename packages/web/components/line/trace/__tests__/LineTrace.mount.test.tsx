// Mounts the trace (docs/architecture/line-map.md LX4) in jsdom on the line
// fixtures: the story reads one step per stage, a run reads station by
// station with its loops, a step that has not happened says what it waits
// on, and the page resolves a ref from the store's rows.
import { afterAll, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/line/trace/sg-a1", pretendToBeVisual: true });
const matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400, matchMedia }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  matchMedia,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollTo = () => {};
const { createRoot } = await import("react-dom/client");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

// Same mocks as the other line mount tests: bun shares mock.module across the
// files of one run, so they must agree.
mock.module("../../../../hooks/useSyncCollection", () => ({
  useSyncCollection: () => ({ ready: true }),
  useFeederError: () => {},
  entityIdArgs: () => "skip",
  applyCollectionFeed: () => {},
  keyRowsBy: (rows: any[]) => rows ?? [],
}));
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {} }),
  usePathname: () => "/line/trace/sg-a1",
  useSearchParams: () => new URLSearchParams(""),
}));
mock.module("../../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: null }) }));

const F = await import("../../../../lib/line/__tests__/lineFixtures");
const { buildLineTrace, resolveTraceRef } = await import("../../../../lib/line/lineTrace");
const { TraceStory } = await import("../TraceStory");
const { LineTracePage } = await import("../LineTracePage");
const { useInboxStore } = await import("../../../../store/inboxStore");

type Rows = typeof F.rows;
const answeredBy = (d: any) => (d.answered_by?.id === "u1" ? "Ashot Petrosian" : null);

async function mount(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return { host, done: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}

async function story(ref: string, rows: Rows = F.rows) {
  const resolved = resolveTraceRef(ref, rows);
  if (!resolved) throw new Error(`no cause for ${ref}`);
  const trace = buildLineTrace(resolved, rows, { now: F.NOW, answeredBy });
  return { trace, ...(await mount(React.createElement(TraceStory, { trace, rows }))) };
}

const q = (host: HTMLElement, sel: string) => host.querySelector<HTMLElement>(sel);
const qa = (host: HTMLElement, sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
const step = (host: HTMLElement, stage: string) => q(host, `[data-trace-step="${stage}"]`)!;
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";

describe("TraceStory", () => {
  test("shipped and held: the finder's words, the group, a loop drawn twice, who answered the card", async () => {
    const { host, done } = await story("sg-a1");
    expect(q(host, "[data-trace-story]")?.dataset.traceOutcome).toBe("held");
    // One step per stage, in the story's order, the run as one block.
    expect(qa(host, "[data-trace-story] > li").map((li) => li.dataset.traceStep ?? "run")).toEqual(["finding", "group", "cause", "ground", "run", "card", "card", "ship", "watch", "outcome"]);

    const finding = step(host, "finding");
    expect(text(finding.querySelector("[data-trace-detail]"))).toBe("The agent answered a different question than the broker asked.");
    expect(finding.querySelector<HTMLAnchorElement>('a[href^="https://admin.example.com/agentwatch"]')?.textContent).toContain("Where it was seen");
    expect(text(finding)).toContain("Breaks ex-union-3");
    expect(text(finding)).toContain("agentwatch · prompt miss");

    // The siblings each open their own trace.
    const siblings = qa(step(host, "group"), "[data-trace-sibling]");
    expect(siblings.map((s) => s.dataset.traceSibling)).toEqual(["sg-a2", "sg-a3"]);
    expect(siblings[0].querySelector("a")?.getAttribute("href")).toBe("/line/trace/sg-a2");
    expect(text(step(host, "group"))).toContain("It opened this cause");

    // Two rounds through build: the earlier one folds into one row, and implement says it is its second visit.
    const run = q(host, "[data-trace-run]")!;
    expect(run.dataset.traceRounds).toBe("2");
    expect(text(run.querySelector("[data-trace-loops]"))).toBe("2 rounds through build");
    expect(text(run.querySelector("[data-trace-loop]"))).toContain("An earlier round went through Implement, Verify, Eval, Review, Decide");
    const impl = run.querySelector<HTMLElement>('[data-trace-station="implement"]')!;
    expect(impl.dataset.traceVisit).toBe("2");
    expect(impl.querySelector("[data-trace-session]")?.getAttribute("href")).toBe("/conversation/jx_impl2");
    expect(run.querySelector("[data-trace-run-link]")?.getAttribute("href")).toBe("/workflows/runs/run_a");

    // The card's routine steps fold, and open on a click.
    expect(run.querySelector('[data-trace-station="card_write"]')).toBeNull();
    await act(async () => { run.querySelector<HTMLButtonElement>("[data-trace-routine]")!.click(); });
    expect(run.querySelector('[data-trace-station="card_write"]')).not.toBeNull();

    const cards = qa(host, '[data-trace-step="card"]');
    expect(text(cards[0])).toContain("Answered Revise");
    expect(text(cards[1])).toContain("Ashot Petrosian answered Ship");
    expect(cards[1].querySelector("a")?.getAttribute("href")).toBe("/decisions/sd-2");
    expect(text(step(host, "outcome"))).toContain("Held: the fix stayed fixed through its watch");
    await done();
  });

  test("dissolved: the stages after prove say why nothing happened there", async () => {
    const { host, done } = await story("ct-102");
    expect(q(host, "[data-trace-story]")?.dataset.traceOutcome).toBe("dissolved");
    expect(q(host, '[data-trace-station="dissolve"]')?.textContent).toContain("Closed: the problem did not reproduce");
    for (const [stage, words] of [["card", "No card: the problem did not reproduce"], ["ship", "Not shipped: the problem did not reproduce"], ["watch", "Nothing shipped to watch"]]) {
      expect(step(host, stage).dataset.traceStatus).toBe("skipped");
      expect(text(step(host, stage).querySelector("[data-trace-detail]"))).toBe(words);
    }
    expect(text(step(host, "outcome"))).toContain("Dissolved");
    await done();
  });

  test("reopened during the watch: the watch fails and names the signal that came back", async () => {
    const { host, done } = await story("ct-106");
    expect(q(host, "[data-trace-story]")?.dataset.traceOutcome).toBe("reopened");
    const watch = step(host, "watch");
    expect(watch.dataset.traceStatus).toBe("failed");
    expect(text(watch)).toContain("Its signal came back");
    expect(watch.querySelector('a[href="/line/trace/sg-f2"]')?.textContent).toContain("Timezone test fails again");
    expect(step(host, "outcome").dataset.traceStatus).toBe("failed");
    await done();
  });

  test("a failed run then a rerun: each run its own block, the first muted with its reason, the second live", async () => {
    const G0 = F.NOW - 2 * F.DAY;
    const causeG = { _id: "task_g", short_id: "ct-107", title: "Digest misses Friday", status: "in_progress", created_at: G0, cause: { signal_count: 1, first_seen: G0, last_seen: G0, fingerprints: ["ci:fri"] }, project_id: "proj" } as any;
    const sigG = { _id: "sig_g1", short_id: "sg-g1", task_id: "task_g", created_at: G0, observed_at: G0, source: "ci", kind: "bug", title: "Friday digest empty", attach: "new", fingerprint: "ci:fri" } as any;
    const run1 = { _id: "run_g1", status: "failed", task_id: "task_g", workflow_name: "line", current_node_id: "verify", fail_reason: "max_visits=3 exceeded on implement",
      node_statuses: [F.n("ground", G0 + F.MIN, 3), F.n("analyze", G0 + 5 * F.MIN), F.n("prove", G0 + 10 * F.MIN, 20), F.n("red", G0 + 31 * F.MIN), F.n("implement", G0 + 35 * F.MIN, 40), F.n("verify", G0 + 76 * F.MIN, 5, "failed")],
      created_at: G0 + F.MIN, updated_at: G0 + 81 * F.MIN } as any;
    const R = G0 + F.DAY;
    const run2 = { _id: "run_g2", status: "running", task_id: "task_g", workflow_name: "line", current_node_id: "implement",
      node_statuses: [F.n("ground", R, 3), F.n("analyze", R + 5 * F.MIN), F.n("prove", R + 10 * F.MIN, 20), F.n("red", R + 31 * F.MIN), F.n("implement", R + 35 * F.MIN, 0, "running")],
      created_at: R, updated_at: R + 40 * F.MIN } as any;
    const rows = { ...F.rows, tasks: [...F.rows.tasks, causeG], signals: [...F.rows.signals, sigG], runs: [...F.rows.runs, run1, run2] };
    const { host, done } = await story("sg-g1", rows);
    const runs = qa(host, "[data-trace-run]");
    expect(runs.map((r) => r.dataset.traceRun)).toEqual(["run_g1", "run_g2"]);
    expect(runs.map((r) => r.dataset.traceStatus)).toEqual(["failed", "current"]);
    expect(text(runs[0])).toContain("Run 1");
    expect(text(runs[1])).toContain("Run 2");
    expect(runs[0].querySelector('[data-trace-station="verify"]')?.dataset.traceStatus).toBe("failed");
    expect(text(runs[0].querySelector('[data-trace-station="verify"]'))).toContain("Checks failed");
    // The first run speaks muted: a later run followed it.
    expect(runs[0].querySelector("[data-run-outcome]")?.className).toContain("text-sol-text-dim");
    expect(runs[1].querySelector('[data-trace-station="implement"]')?.dataset.traceStatus).toBe("current");
    // Nothing after build has happened: each says what it waits on.
    expect(text(step(host, "card").querySelector("[data-trace-detail]"))).toBe("Waiting for a card: it is written once the change passes review");
    expect(step(host, "ship").dataset.traceStatus).toBe("waiting");
    expect(text(step(host, "watch").querySelector("[data-trace-detail]"))).toBe("Waiting for the ship: the watch starts when the change lands");
    await done();
  });

  test("compact: the panel's version leaves the finder's full words and the per-station times out", async () => {
    const resolved = resolveTraceRef("sg-a1", F.rows)!;
    const trace = buildLineTrace(resolved, F.rows, { now: F.NOW });
    const { host, done } = await mount(React.createElement(TraceStory, { trace, rows: F.rows, compact: true }));
    expect(q(host, "[data-trace-story]")?.dataset.compact).toBe("");
    expect(q(host, "[data-trace-finder-words]")).toBeNull();
    expect(qa(host, "[data-trace-station]").length).toBeGreaterThan(5);
    await done();
  });
});

describe("LineTracePage", () => {
  const WS = "user:u1";
  const seed = () => {
    const ws = <T,>(list: T[]) => Object.fromEntries(list.map((r: any) => [r._id, { ...r, workspace: WS }]));
    useInboxStore.setState({
      currentUser: { _id: "u1", name: "Ashot Petrosian" },
      clientStateInitialized: true,
      clientState: { ...(useInboxStore.getState() as any).clientState, ui: {} },
      teams: [], teamMembers: [],
      projects: {},
      tasks: ws(F.rows.tasks),
      signals: ws(F.rows.signals),
      workflowRuns: ws(F.rows.runs),
      sessionDecisions: ws(F.decisionsA),
    } as any);
  };

  test("a signal's ref opens its cause's story from the store, with the finding first", async () => {
    seed();
    const { host, done } = await mount(React.createElement(LineTracePage, { refParam: "sg-a1" }));
    expect(text(q(host, "[data-trace-head] h1"))).toBe("Broker replies skip the question asked");
    expect(q(host, "[data-trace-via]")?.dataset.traceVia).toBe("signal");
    expect(q(host, "[data-trace-story]")?.dataset.traceOutcome).toBe("held");
    expect(qa(host, '[data-trace-step="card"]').length).toBe(2);
    expect(text(qa(host, '[data-trace-step="card"]')[1])).toContain("You answered Ship");
    // The header never repeats the cause's title in its steps, and says the path in one line.
    expect(text(q(host, "[data-trace-summary]"))).toMatch(/^Found .*, 1 run/);
    expect(text(q(step(host, "cause"), "[data-trace-title]"))).toBe("Filed as ct-101");
    // The path strip: only the nodes it went through, each chip going to its step.
    const chips = qa(host, "[data-trace-chip]").map((c) => c.dataset.traceChip);
    expect(chips).toEqual(expect.arrayContaining(["expectations", "signals", "causes", "implement", "end:held"]));
    expect(chips).not.toContain("end:dissolved");
    // The whole map is behind Full size. It lights the path, loops included, and a hovered
    // step focuses its node. (The fixtures sit weeks before the clock this page reads, so the
    // map's sources, a two week reading, have aged out; the rest of the path is drawn.)
    expect(q(host, "[data-trace-map]")).toBeNull();
    await act(async () => { q(host, "[data-trace-map-zoom]")!.click(); });
    const lit = qa(host, '[data-trace-map] [data-map-node][data-on="true"]').map((n) => n.dataset.mapNode);
    expect(lit).toEqual(expect.arrayContaining(["expectations", "signals", "causes", "implement", "decide", "ship", "end:held"]));
    expect(q(host, '[data-trace-map] [data-map-node="end:dissolved"]')?.dataset.on).toBeUndefined();
    await act(async () => { step(host, "cause").dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })); });
    expect(q(host, '[data-trace-map] [data-map-node="causes"]')?.dataset.focused).toBe("true");
    await done();
  });

  test("a cause held in another workspace (another team's line) still traces", async () => {
    seed();
    const other = <T,>(list: T[]) => Object.fromEntries(list.map((r: any) => [r._id, { ...r, workspace: "team:t2" }]));
    useInboxStore.setState({ tasks: other(F.rows.tasks), signals: other(F.rows.signals), workflowRuns: other(F.rows.runs) } as any);
    const { host, done } = await mount(React.createElement(LineTracePage, { refParam: "ct-101" }));
    expect(q(host, "[data-trace-missing]")).toBeNull();
    expect(text(q(host, "[data-trace-head] h1"))).toBe("Broker replies skip the question asked");
    expect(text(step(host, "finding"))).toContain("The agent answered a different question than the broker asked.");
    await done();
  });

  test("a ref nothing on the line matches says so, and what a trace takes", async () => {
    seed();
    const { host, done } = await mount(React.createElement(LineTracePage, { refParam: "sg-nope" }));
    expect(q(host, "[data-trace-missing]")).not.toBeNull();
    expect(text(host)).toContain("Nothing on the line matches sg-nope");
    await done();
  });
});
