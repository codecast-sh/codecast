// The bisect pages (U14): the ruler model brackets a range the way the search
// narrows it; the free answer lights the first class that differs for each
// Tier 0 answer; a pinned answer shows its commit and no Start; a narrowed
// one is priced, with the agent confirm gating Start; the live page draws the
// ruler mid-run, flags a stall, shows the drift banner and the result card;
// and the list reads every bisect. All through the fixture world.

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/evals/bisect", pretendToBeVisual: true });
const DOM_GLOBAL = /^(navigator|getComputedStyle|requestAnimationFrame|cancelAnimationFrame|Node|NodeFilter|Element|Text|Range|Selection|Document\w*|MutationObserver|DOMRect\w*|HTML\w*Element|SVG\w*Element|\w*Event)$/;
const restoreGlobals = replaceGlobals({
  ...Object.fromEntries(Object.getOwnPropertyNames(dom.window).filter((k) => DOM_GLOBAL.test(k)).map((k) => [k, (dom.window as unknown as Record<string, unknown>)[k]])),
  window: dom.window,
  document: dom.window.document,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ConvexProvider } = await import("convex/react");
// Session pills resolve through Convex; the marketing stub answers every query with nothing.
const { heroConvexStub } = await import("../../../app/(marketing)/heroFly/convexStub");
const { matchEvalsRoute } = await import("@codecast/shared/contracts/evalsApi");
const { useEvalsStore } = await import("../../../store/evalsStore");
const { evalsFixtureWorld } = await import("../__fixtures__/world");
const { attributionPairs, fixtureBisect } = await import("../__fixtures__/bisect");
const { rulerModel, orderCandidates, probesLeftFor, bisectSummaryWord } = await import("../bisectModel");
const { AttributionView } = await import("../AttributionView");
const { BisectView, isStalled } = await import("../BisectView");
const { BisectListView } = await import("../BisectListView");
const { commitSessionId } = await import("../CommitPanel");
const { BisectPlanPanel, canStart } = await import("../BisectPlanPanel");
const { BisectNewPage } = await import("../pages/BisectNewPage");
const { BisectPage } = await import("../pages/BisectPage");
const { BisectListPage } = await import("../pages/BisectListPage");
type Attribution = import("@codecast/shared/contracts/evalsApi").Attribution;
type BisectResponse = import("@codecast/shared/contracts/evalsApi").BisectResponse;
type BisectPlan = import("@codecast/shared/contracts/evalsApi").BisectPlan;
type BisectListResponse = import("@codecast/shared/contracts/evalsApi").BisectListResponse;

// A loaded machine renders a DiffView in seconds, and the case search walks the world.
setDefaultTimeout(120_000);

const world = evalsFixtureWorld();
const pairs = attributionPairs(world as never);
const posts: Array<{ path: string; body: unknown }> = [];
const gets: Array<{ path: string; query: Record<string, string> }> = [];
/** Whether the world's running bisect holds the one-bisect lock; most tests start on a free machine. */
let lockHeld = false;

beforeAll(() => {
  // One world for the test and the pages, so batch names agree.
  const transport = {
    kind: "fixture" as const,
    async send(req: import("@codecast/shared/contracts/evalsApi").EvalsBridgeRequest) {
      if (req.method === "POST") posts.push({ path: req.path, body: req.body });
      else gets.push({ path: req.path, query: req.query });
      const route = matchEvalsRoute(req.method, req.path);
      if (!route) return { status: 404, body: { error: "no route", reason: "not-found" } };
      try {
        const body = structuredClone(world.answer(route.key, route.params, req.query, req.body));
        if (route.key === "GET /bisects" && !lockHeld) (body as BisectListResponse).running = null;
        return { status: 200, body };
      } catch (e) {
        return { status: 404, body: { error: (e as Error).message, reason: "not-found" } };
      }
    },
  };
  useEvalsStore.setState({ connection: "connected", transport, resources: {} });
});

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <ConvexProvider client={heroConvexStub}>
        <MemoryRouter initialEntries={["/evals/bisect"]}>{node}</MemoryRouter>
      </ConvexProvider>,
    ),
  );
  return { container, unmount: () => act(async () => root.unmount()) };
}

/** Lets fetches and the plan's debounce settle. */
async function settle(container: HTMLElement, until: (c: HTMLElement) => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!until(container) && Date.now() < end) await act(async () => new Promise((r) => setTimeout(r, 40)));
  return until(container);
}

const attribution = (k: keyof typeof pairs) => {
  const p = pairs[k]!;
  return world.answer("GET /attribution", {}, { surface: p.surface, good: p.good, bad: p.bad }) as Attribution;
};
const bisect = (id: string) => world.answer("GET /bisect/:id", { id }, {}) as BisectResponse;

describe("the ruler model", () => {
  const running = bisect("b-settle-1003");
  const culprit = bisect("b-settle-0927");
  const range = bisect("b-call-summary-0929");

  it("orders commits by date with the patch last", () => {
    const ordered = orderCandidates([...running.state.candidates].reverse());
    const commitTimes = ordered.filter((c) => c.kind === "commit").map((c) => Date.parse((c as { commit: { at: string } }).commit.at));
    expect(commitTimes).toEqual([...commitTimes].sort((a, b) => a - b));
    expect(ordered[ordered.length - 1].kind).toBe("patch");
  });

  it("brackets the range the search has left, a class at a time", () => {
    const m = rulerModel(running.state);
    expect(m.goodAt).toBeGreaterThanOrEqual(0);
    expect(m.badAt).toBeGreaterThan(m.goodAt);
    expect(m.tiles.some((t) => t.verdict === "pending")).toBe(true);
    expect(m.tiles.some((t) => t.recorded)).toBe(true);
    // A tile inside the brackets is neither known good nor after the oldest known bad.
    for (const t of m.tiles) expect(t.outside).toBe(t.index <= m.goodAt || t.index > m.badAt);
    const r = rulerModel(range.state);
    const rangeClass = r.tiles[0].classN;
    expect(r.tiles.filter((t) => t.classN === rangeClass).every((t) => !t.outside)).toBe(true);
  });

  it("lifts the culprit and has nothing left to probe", () => {
    const m = rulerModel(culprit.state);
    expect(m.culpritAt).not.toBeNull();
    expect(m.tiles[m.culpritAt!].culprit).toBe(true);
    expect(m.probesLeft).toBe(0);
    expect(probesLeftFor(1)).toBe(0);
    expect(probesLeftFor(5)).toBe(3);
  });

  it("names a list row by outcome", () => {
    expect(bisectSummaryWord({ status: "done", outcome: "culprit", culprit: "0123456789ab" })).toBe("culprit 01234567");
    expect(bisectSummaryWord({ status: "done", outcome: "drift", culprit: null })).toBe("drift, not source");
    expect(bisectSummaryWord({ status: "probing", outcome: null, culprit: null })).toBe("probing");
  });
});

describe("the free answer", () => {
  it("finds a pair in the world for every Tier 0 answer", () => {
    for (const k of ["footing", "freeze", "live-reads", "noise", "pinned", "narrowed", "unattributable", "agent"] as const) expect(pairs[k], k).toBeTruthy();
  });

  for (const [k, kind] of [["footing", "footing"], ["freeze", "freeze"], ["live-reads", "live-reads"], ["noise", "noise"], ["narrowed", "source"], ["unattributable", "source"]] as const) {
    it(`lights ${k} as the answer, with the lines before it reading same`, async () => {
      const a = attribution(k);
      const { container, unmount } = await mount(<AttributionView attribution={a} />);
      const lines = [...container.querySelectorAll("[data-evb-class]")].map((el) => [el.getAttribute("data-evb-class"), el.getAttribute("data-state")]);
      expect(lines.map(([c]) => c)).toEqual(["footing", "freeze", "live-reads", "source", "noise"]);
      const at = lines.findIndex(([, s]) => s === "answer");
      expect(lines[at][0]).toBe(kind);
      expect(lines.slice(0, at).every(([, s]) => s === "same")).toBe(true);
      expect(container.querySelector(`[data-evb-answer="${kind}"]`)).toBeTruthy();
      // The rendered prompt change is always shown.
      expect(container.querySelector("[data-evb-prompt-diffs]")).toBeTruthy();
      if (k === "unattributable") expect(container.querySelector('[data-evb-confidence="unattributable"]')).toBeTruthy();
      if (k === "narrowed") expect(container.querySelectorAll("[data-evb-candidate]").length).toBeGreaterThan(1);
      await unmount();
    });
  }

  it("shows a pinned answer's commit and no Start", async () => {
    const p = pairs.pinned!;
    const { container, unmount } = await mount(<BisectNewPage view={{ view: "bisect-new", surface: p.surface, good: p.good, bad: p.bad, freeze: null }} />);
    expect(await settle(container, (c) => !!c.querySelector("[data-evb-commit]:not([data-evb-commit='loading'])"))).toBe(true);
    expect(container.querySelector('[data-evb-confidence="pinned"]')).toBeTruthy();
    expect(container.querySelector("[data-evb-start]")).toBeNull();
    expect(container.querySelector("[data-evb-plan]")).toBeNull();
    await unmount();
  });

  it("prices a narrowed range and starts it", async () => {
    const p = pairs.narrowed!;
    posts.length = 0;
    const { container, unmount } = await mount(<BisectNewPage view={{ view: "bisect-new", surface: p.surface, good: p.good, bad: p.bad, freeze: null }} />);
    expect(await settle(container, (c) => !!c.querySelector('[data-evb-plan="priced"] [data-evb-cost]'))).toBe(true);
    const cost = container.querySelector("[data-evb-cost]")!.textContent!;
    expect(cost).toMatch(/2 controls \+ up to \d+ probes? \+ confirmation, \d+ freezes, 3 to 5 reps: at most \d+ reps, about \$[\d.]+, budget \$[\d.]+/);
    expect(container.querySelector("[data-evb-confirm]")).toBeNull();
    const start = container.querySelector<HTMLButtonElement>("[data-evb-start]")!;
    expect(start.disabled).toBe(false);
    expect(start.querySelector("kbd")).toBeTruthy();
    // Seeding the default freeze set costs no second plan.
    expect(posts.filter((x) => x.path === "/bisect/plan").length).toBe(1);
    await act(async () => start.click());
    expect(await settle(container, () => posts.some((x) => x.path === "/bisect"))).toBe(true);
    await unmount();
  });

  it("offers the plan for an unattributable range too, since Start renders the candidates and can map the unreplayable end", async () => {
    const p = pairs.unattributable!;
    const a = attribution("unattributable");
    expect(a.answer.kind === "source" && a.answer.candidates.length).toBeGreaterThan(0);
    const { container, unmount } = await mount(<BisectNewPage view={{ view: "bisect-new", surface: p.surface, good: p.good, bad: p.bad, freeze: null }} />);
    expect(await settle(container, (c) => !!c.querySelector('[data-evb-plan="priced"] [data-evb-cost]'))).toBe(true);
    expect(container.querySelector('[data-evb-confidence="unattributable"]')).toBeTruthy();
    await unmount();
  });

  it("asks an agent surface for a confirm before Start", async () => {
    const p = pairs.agent!;
    const { container, unmount } = await mount(<BisectNewPage view={{ view: "bisect-new", surface: p.surface, good: p.good, bad: p.bad, freeze: null }} />);
    expect(await settle(container, (c) => !!c.querySelector("[data-evb-confirm]"))).toBe(true);
    const start = () => container.querySelector<HTMLButtonElement>("[data-evb-start]")!;
    expect(start().disabled).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>("[data-evb-confirm] input")!.click());
    expect(start().disabled).toBe(false);
    await unmount();
  });

  it("names the bisect holding the lock and holds Start until it is done", async () => {
    const p = pairs.narrowed!;
    lockHeld = true;
    useEvalsStore.setState({ resources: {} });
    try {
      const { container, unmount } = await mount(<BisectNewPage view={{ view: "bisect-new", surface: p.surface, good: p.good, bad: p.bad, freeze: null }} />);
      expect(await settle(container, (c) => !!c.querySelector('[data-evb-plan="priced"] [data-evb-blocked]'))).toBe(true);
      expect(container.querySelector("[data-evb-blocked]")!.getAttribute("data-evb-blocked")).toBe("b-settle-1003");
      expect(container.querySelector('[data-evb-blocked] a')!.getAttribute("href")).toBe("/evals/bisect/b-settle-1003");
      expect(container.querySelector<HTMLButtonElement>("[data-evb-start]")!.disabled).toBe(true);
      await unmount();
    } finally {
      lockHeld = false;
      useEvalsStore.setState({ resources: {} });
    }
  });

  it("lists a bisect already over the range, with its culprit, before anyone pays again", async () => {
    const done = bisect("b-settle-0927").state;
    const { container, unmount } = await mount(<BisectNewPage view={{ view: "bisect-new", surface: done.surface, good: done.plan.good.batch!, bad: done.plan.bad.batch!, freeze: null }} />);
    expect(await settle(container, (c) => !!c.querySelector('[data-evb-prior-row="b-settle-0927"]'))).toBe(true);
    const row = container.querySelector('[data-evb-prior-row="b-settle-0927"]')!;
    expect(row.getAttribute("href")).toBe("/evals/bisect/b-settle-0927");
    expect(row.textContent).toContain(`culprit ${done.answer?.kind === "culprit" ? done.answer.commit.sha.slice(0, 8) : ""}`);
    expect(row.textContent).toContain("these same ends");
    // The running bisect over the same ends is listed first.
    expect(container.querySelector("[data-evb-prior-row]")!.getAttribute("data-evb-prior-row")).toBe("b-settle-1003");
    await unmount();
  });

  it("says when no candidate is left, and widens to every commit on request", async () => {
    const p = pairs.empty!;
    const a = attribution("empty");
    expect(a.answer).toMatchObject({ kind: "source", confidence: "empty", candidates: [] });
    gets.length = 0;
    const { container, unmount } = await mount(<BisectNewPage view={{ view: "bisect-new", surface: p.surface, good: p.good, bad: p.bad, freeze: null }} />);
    expect(await settle(container, (c) => !!c.querySelector("[data-evb-empty]"))).toBe(true);
    // No false "narrowed": no confidence scale, no plan, and the one way forward is a button.
    expect(container.querySelector("[data-evb-confidence]")).toBeNull();
    expect(container.querySelector("[data-evb-plan]")).toBeNull();
    expect(container.textContent).not.toContain("A bisect can replay them");
    if (a.answer.kind === "source" && a.answer.rangeCommits > 0) expect(container.querySelector("[data-evb-widen]")).toBeTruthy();
    await unmount();
    const wide = await mount(<BisectNewPage view={{ view: "bisect-new", surface: p.surface, good: p.good, bad: p.bad, freeze: null, all: true }} />);
    expect(await settle(wide.container, (c) => !!c.querySelector("[data-evb-widened]"))).toBe(true);
    expect(gets.some((g) => g.path === "/attribution" && g.query.allCommits === "1")).toBe(true);
    await wide.unmount();
  });

  it("narrows the fixture the way the engine does: a recorded good batch's commit is never a candidate", () => {
    for (const k of ["pinned", "narrowed", "agent", "empty"] as const) {
      const a = attribution(k);
      if (a.answer.kind !== "source") continue;
      const shas = new Set(a.answer.candidates.flatMap((c) => (c.kind === "commit" ? [c.commit.sha] : [])));
      for (const r of a.answer.narrowedBy) if (r.verdict === "good") expect(shas.has(r.sha)).toBe(false);
      expect(a.answer.noDeclaredSourceMoved && a.answer.candidates.some((c) => c.kind === "patch")).toBe(false);
    }
  });

  it("refuses Start over budget or with no freeze", () => {
    const plan = (world.answer("POST /bisect/plan", {}, {}, { surface: pairs.narrowed!.surface, good: pairs.narrowed!.good, bad: pairs.narrowed!.bad }) as BisectPlan);
    const settings = { freezes: plan.freezes.map((f) => f.id), reps: 3, budgetUsd: null, maxMinutes: null, allCommits: false };
    expect(canStart({ plan, pending: false, starting: false, confirm: false, settings })).toBe(true);
    expect(canStart({ plan, pending: false, starting: false, confirm: false, settings: { ...settings, budgetUsd: plan.bound.maxUsd / 2 } })).toBe(false);
    expect(canStart({ plan, pending: false, starting: false, confirm: false, settings: { ...settings, freezes: [] } })).toBe(false);
    expect(canStart({ plan, pending: true, starting: false, confirm: false, settings })).toBe(false);
  });

  it("shows the bound in plain words and an over-budget warning", async () => {
    const plan = (world.answer("POST /bisect/plan", {}, {}, { surface: pairs.agent!.surface, good: pairs.agent!.good, bad: pairs.agent!.bad }) as BisectPlan);
    const settings = { freezes: plan.freezes.map((f) => f.id), reps: 3, budgetUsd: plan.bound.maxUsd / 2, maxMinutes: null, allCommits: false };
    const noop = () => {};
    const { container, unmount } = await mount(
      <BisectPlanPanel plan={plan} pending={false} error={null} freezeOptions={plan.freezes} settings={settings} onSettings={noop} confirm onConfirm={noop} starting={false} startError={null} onStart={noop} />,
    );
    expect(container.querySelector("[data-evb-cost]")!.textContent).toContain(plan.summary);
    expect(container.textContent).toContain("would refuse to start");
    expect(container.querySelector<HTMLButtonElement>("[data-evb-start]")!.disabled).toBe(true);
    await unmount();
  });
});

describe("one bisect", () => {
  // The world's bisects run on the real clock (buildBisects).
  const NOW = Date.now();

  it("draws the live ruler mid-run with its rail", async () => {
    const data = bisect("b-settle-1003");
    const { container, unmount } = await mount(<BisectView data={data} steps={data.steps} now={NOW} onStop={() => {}} stopping={false} />);
    expect(container.querySelector("[data-evb-ruler]")).toBeTruthy();
    expect(container.querySelectorAll('[data-evb-control]').length).toBe(2);
    expect(container.querySelector('[data-evb-wells="probe"]')).toBeTruthy();
    expect(container.querySelector(".evb-bracket--good")).toBeTruthy();
    expect(container.querySelector(".evb-bracket--bad")).toBeTruthy();
    expect(container.querySelector("[data-evb-stop]")).toBeTruthy();
    expect(container.querySelector("[data-evb-stalled]")).toBeNull();
    expect(container.textContent).toContain(`tmux attach -t evals-bisect-b-settle-1003`);
    expect(container.querySelector("[data-evb-log]")!.textContent).toContain("waiting on claude -p");
    await unmount();
  });

  it("tallies each probe's wells in words, marks flipped and control rows, and links landed reps to their runs", async () => {
    const data = bisect("b-settle-1003");
    const { container, unmount } = await mount(<BisectView data={data} steps={data.steps} now={NOW} onStop={() => {}} stopping={false} />);
    const tallies = [...container.querySelectorAll("[data-evb-tally]")].map((t) => t.textContent ?? "");
    expect(tallies.some((t) => /^\d+ pass \d+ fail$/.test(t))).toBe(true);
    expect(tallies.some((t) => /^\d+ of \d+ landed$/.test(t))).toBe(true);
    const roles = (xs: Array<string | null>) => [...new Set(xs)].sort();
    expect(roles([...container.querySelectorAll(".evb-wells-role")].map((r) => r.textContent))).toEqual(roles(data.state.plan.freezes.map((f) => (f.role === "flipped" ? "f" : "c"))));
    expect(container.querySelector('[data-evb-wells] a[href^="/evals/r/"]')).toBeTruthy();
    await unmount();
  });

  it("prints a step's batch as every page names it, linked to that batch on the chart", async () => {
    const data = bisect("b-settle-0927");
    const steps = [...data.steps, { seq: 99, at: data.state.updatedAt, kind: "narrow" as const, sha: null, text: "Recorded batch 2026-10-01T20:52:00.000Z reads class 1 good" }];
    const { container, unmount } = await mount(<BisectView data={data} steps={steps} now={NOW} onStop={() => {}} stopping={false} />);
    const link = [...container.querySelectorAll(".evb-step-text a")].find((a) => a.getAttribute("href")?.includes("2026-10-01T20%3A52%3A00.000Z"))!;
    expect(link.getAttribute("href")).toBe(`/evals/s/settle?batch=${encodeURIComponent("2026-10-01T20:52:00.000Z")}`);
    expect(link.textContent).not.toContain("T20:52");
    await unmount();
  });

  it("flags a bisect that stopped writing steps", async () => {
    const data = bisect("b-anchor-brief-1003");
    expect(data.stalled).toBe(true);
    expect(isStalled({ ...data, stalled: false }, Date.parse(data.state.updatedAt) + 6 * 60_000)).toBe(true);
    const { container, unmount } = await mount(<BisectView data={data} steps={data.steps} now={NOW} onStop={() => {}} stopping={false} />);
    expect(container.querySelector("[data-evb-stalled]")).toBeTruthy();
    await unmount();
  });

  it("shows drift as a plain banner, not a culprit", async () => {
    const data = bisect("b-handoff-0930");
    const { container, unmount } = await mount(<BisectView data={data} steps={data.steps} now={NOW} onStop={() => {}} stopping={false} />);
    expect(container.querySelector('[data-evb-result="drift"]')!.textContent).toContain("Does not reproduce on today's tool and judge: drift, not source.");
    expect(container.querySelector("[data-evb-stop]")).toBeNull();
    await unmount();
  });

  it("reads a finished bisect to its culprit through the page", async () => {
    const { container, unmount } = await mount(<BisectPage view={{ view: "bisect", id: "b-settle-0927" }} />);
    expect(await settle(container, (c) => !!c.querySelector('[data-evb-result="culprit"] [data-evb-commit]:not([data-evb-commit="loading"])'))).toBe(true);
    const result = container.querySelector('[data-evb-result="culprit"]')!;
    expect(result.querySelector('[data-ev-separation="worse"]')).toBeTruthy();
    expect(result.textContent).toContain("Tier 2");
    expect(container.querySelector(".evb-tile--culprit")).toBeTruthy();
    // The trailer shows as the session pill, never as a raw line or link in the body.
    const commitText = result.querySelector("[data-evb-commit]")!.textContent ?? "";
    expect(commitText).not.toContain("Codecast-Session");
    expect(commitText).not.toContain("https://");
    await unmount();
  });

  it("reads a commit's session from its trailer value as git log hands it over", () => {
    const id = "jx747bn5qcccdv5asr8jrk3n9d8fj2j0";
    expect(commitSessionId({ session: `https://codecast.sh/conversation/${id}` })).toBe(id);
    expect(commitSessionId({ session: id })).toBe(id);
    // A short id is a prefix that can collide, so it names nothing, as blame reads it.
    expect(commitSessionId({ session: "jx747bn" })).toBeNull();
    expect(commitSessionId({ session: null })).toBeNull();
  });

  it("reads a range when the replay could not tell commits apart", async () => {
    const data = bisect("b-call-summary-0929");
    const { container, unmount } = await mount(<BisectView data={data} steps={data.steps} now={NOW} onStop={() => {}} stopping={false} />);
    expect(container.querySelector('[data-evb-result="range"] [data-evb-candidates]')).toBeTruthy();
    expect(container.querySelector(".evb-span")).toBeTruthy();
    // Each candidate opens its diff in place: a commit its CommitPanel, the uncommitted edits their patch.
    const row = container.querySelector<HTMLElement>('[data-evb-result="range"] [data-evb-candidate]')!;
    expect(row.getAttribute("aria-expanded")).toBe("false");
    await act(async () => row.click());
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[data-evb-commit], [data-evb-patch]")).toBeTruthy();
    await unmount();
  });

  it("answers an unknown id with a not-found state", async () => {
    const { container, unmount } = await mount(<BisectPage view={{ view: "bisect", id: "b-nope" }} />);
    expect(await settle(container, (c) => (c.textContent ?? "").includes("No bisect with this id"))).toBe(true);
    await unmount();
  });

  it("builds every fixture kind from one plan", () => {
    const plan = (bisect("b-settle-1003").state.plan) as BisectPlan;
    for (const kind of ["running", "stalled", "drift", "culprit", "range"] as const) {
      const b = fixtureBisect(kind, plan, { id: `t-${kind}`, now: NOW, ageMin: 30 });
      expect(b.state.id).toBe(`t-${kind}`);
      expect(b.steps.length).toBeGreaterThan(2);
    }
  });
});

describe("the list", () => {
  it("lists running bisects first, then newest", async () => {
    const list = world.answer("GET /bisects", {}, {}) as BisectListResponse;
    // The world's bisects run on the real clock, as the pages weigh them (buildBisects).
    const { container, unmount } = await mount(<BisectListView bisects={list.bisects} now={Date.now()} />);
    const rows = [...container.querySelectorAll("[data-evb-row]")];
    expect(rows.length).toBe(list.bisects.length);
    expect(rows[0].hasAttribute("data-evb-live")).toBe(true);
    expect(container.textContent).toContain("drift, not source");
    // The stalled bisect says so in the list, not only on its own page.
    expect(container.querySelector('[data-evb-row="b-anchor-brief-1003"] [data-evb-stalled]')).toBeTruthy();
    expect(container.querySelector('[data-evb-row="b-settle-1003"] [data-evb-stalled]')).toBeNull();
    await unmount();
  });

  it("reads the list through the page", async () => {
    const { container, unmount } = await mount(<BisectListPage view={{ view: "bisect-list" }} />);
    expect(await settle(container, (c) => c.querySelectorAll("[data-evb-row]").length > 0)).toBe(true);
    await unmount();
  });
});

