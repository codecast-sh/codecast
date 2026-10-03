// The Evals foundation (U6): the fixture world answers every route in the
// contract with contract-shaped values, the store turns each way the evals can
// be out of reach into the right connection state, the shell paints the right
// screen for each, and the chart parts draw what they say they draw.

import { afterAll, describe, expect, it } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { EVALS_ROUTE_KEYS, matchEvalsRoute, runRowProblems, type EvalsRouteKey } from "@codecast/shared/contracts/evalsApi";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { evalsFixtureWorld } from "../__fixtures__/world";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/evals", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { useEvalsStore, classifyEvalsFailure, evalsCacheKey } = await import("../../../store/evalsStore");
const { EvalsRequestError, evalsRequest } = await import("../../../lib/evals/client");
const { fixtureTransport, readEvalsFixtureMode } = await import("../../../lib/evals/fixtureTransport");
const { EvalsShell } = await import("../EvalsShell");
const { ScoreStrip } = await import("../charts/ScoreStrip");
const { Well } = await import("../charts/Well");
const { VerdictGlyph, SeparationMark, ScoreBar, ProvenanceChips } = await import("../parts");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const world = evalsFixtureWorld({ now: NOW });

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={["/evals"]}>{node}</MemoryRouter>));
  return { container, unmount: () => act(async () => root.unmount()) };
}

describe("the fixture world", () => {
  const settle = world.rows.filter((r) => r.surface === "settle");
  const batches = [...new Set(settle.map((r) => r.batch!))];
  const agentRun = world.rows.find((r) => r.surface === "role-wake" && r.status === "pass")!;
  const callRun = settle.find((r) => r.status === "pass")!;
  const ARGS: Record<EvalsRouteKey, { params?: Record<string, string>; query?: Record<string, string>; body?: unknown }> = {
    "GET /health": {},
    "GET /overview": { query: { cadence: "nightly" } },
    "GET /surface/:id": { params: { id: "settle" } },
    "GET /freeze/:id": { params: { id: callRun.freezeId } },
    "GET /run/:id": { params: { id: agentRun.id } },
    "GET /run/:id/file": { params: { id: callRun.id }, query: { path: "call1/system.md" } },
    "GET /compare": { query: { a: settle[0].id, b: callRun.id } },
    "GET /batches": { query: { surface: "settle", a: batches[batches.length - 6], b: batches[batches.length - 1] } },
    "GET /epoch": { query: { surface: "settle", n: "2" } },
    "GET /attribution": { query: { surface: "settle", good: batches[batches.length - 6], b: "", bad: batches[batches.length - 1] } },
    "GET /commit/:sha": { params: { sha: settle[0].gitHead!.slice(0, 9) } },
    "GET /patch/:sha": { params: { sha: settle.find((r) => r.treePatch)!.treePatch! } },
    "GET /changes": { query: { since: "0" } },
    "POST /bisect/plan": { body: { surface: "settle", good: batches[batches.length - 6], bad: batches[batches.length - 1] } },
    "POST /bisect": { body: { surface: "settle", good: batches[0], bad: batches[1] } },
    "GET /bisects": {},
    "GET /bisect/:id": { params: { id: "b-settle-1003" } },
    "POST /bisect/:id/stop": { params: { id: "b-settle-1003" } },
    "GET /sim/catalog": {},
    "GET /sim/sessions": {},
    "GET /sim/run/:session/:run": { params: {} },
    "POST /sim/shrink": { body: { session: "x", run: "y" } },
    "POST /sim/sweep": { body: { seeds: 4 } },
  };
  const sessions = world.answer("GET /sim/sessions", {}, {}) as { sessions: Array<{ id: string; failed: number; unsessioned?: boolean }> };
  const failing = sessions.sessions.find((s) => s.failed && !s.unsessioned)!;
  ARGS["GET /sim/run/:session/:run"].params = { session: failing.id, run: "memberRemovedMidTurn-interleave-3" };

  it("answers every route in the contract", () => {
    for (const key of EVALS_ROUTE_KEYS) {
      const a = ARGS[key];
      expect(() => world.answer(key, a.params ?? {}, a.query ?? {}, a.body), key).not.toThrow();
      expect(world.answer(key, a.params ?? {}, a.query ?? {}, a.body), key).toBeTruthy();
    }
  });

  it("holds every row to the RunRow contract and covers all 13 surfaces", () => {
    const bad = world.rows.flatMap((r) => runRowProblems(r).map((p) => `${r.id}: ${p}`));
    expect(bad).toEqual([]);
    expect(new Set(world.rows.map((r) => r.surface)).size).toBe(13);
  });

  it("tells the stories the views exist for", () => {
    const overview = world.answer("GET /overview", {}, { cadence: "nightly" }) as import("@codecast/shared/contracts/evalsApi").OverviewResponse;
    const settleRow = overview.surfaces.find((s) => s.id === "settle")!;
    expect(settleRow.latest?.separation.kind).toBe("worse");
    expect(overview.surfaces.find((s) => s.id === "insight")!.footing.some((m) => m.kind === "model")).toBe(true);
    expect(overview.surfaces.find((s) => s.id === "title")!.footing.some((m) => m.kind === "judge")).toBe(true);
    expect(world.rows.some((r) => r.surface === "role-wake" && r.liveReads > 0)).toBe(true);
    const attr = world.answer("GET /attribution", {}, ARGS["GET /attribution"].query!) as import("@codecast/shared/contracts/evalsApi").Attribution;
    expect(attr.answer.kind).toBe("source");
    expect(attr.flipped.length).toBeGreaterThan(0);
  });

  it("answers an unknown id as a 404 through the transport, and a route it lacks as a 404", async () => {
    const t = await fixtureTransport("on", { latencyMs: 0 });
    expect((await t.send(evalsRequest("GET /run/:id", { params: { id: "nope" } }))).status).toBe(404);
    expect((await t.send({ id: 1, method: "GET", path: "/nowhere", query: {} })).status).toBe(404);
    const health = await t.send(evalsRequest("GET /health", {}));
    expect(health.status).toBe(200);
  });

  it("builds bridge requests the contract's matcher reads back", () => {
    const req = evalsRequest("GET /sim/run/:session/:run", { params: { session: "2026-10-02T11-06-14-581Z", run: "a b/c" } });
    expect(matchEvalsRoute(req.method, req.path)).toEqual({ key: "GET /sim/run/:session/:run", params: { session: "2026-10-02T11-06-14-581Z", run: "a b/c" } });
    expect(evalsRequest("GET /commit/:sha", { params: { sha: "abc1234" }, query: { whole: true } }).query).toEqual({ whole: "1" });
    expect(evalsCacheKey("GET /surface/:id", { params: { id: "settle" }, query: { model: "m", cadence: "all" } })).toBe("GET /surface/settle?cadence=all&model=m");
  });
});

describe("the store", () => {
  it("reads the fixture flag only for its known values", () => {
    expect(readEvalsFixtureMode("1")).toBe("on");
    expect(readEvalsFixtureMode("child-crashed")).toBe("child-crashed");
    expect(readEvalsFixtureMode("0")).toBe("off");
    expect(readEvalsFixtureMode(null)).toBe("off");
  });

  it("turns each area-wide failure into its connection state, and leaves a missing id to its page", () => {
    expect(classifyEvalsFailure(new EvalsRequestError(502, { error: "exit 1", reason: "child-crashed", stderr: ["boom"] }))).toMatchObject({ connection: "child-crashed", stderr: ["boom"] });
    expect(classifyEvalsFailure(new EvalsRequestError(503, { error: "x", reason: "checkout-not-toplevel" }))).toMatchObject({ connection: "no-checkout" });
    expect(classifyEvalsFailure(new EvalsRequestError(503, { error: "x", reason: "no-bun" }))?.unreachableDetail).toMatch(/bun/);
    expect(classifyEvalsFailure(new EvalsRequestError(404, { error: "not found" }))).toMatchObject({ connection: "no-daemon", unreachableReason: "old-daemon" });
    expect(classifyEvalsFailure(new EvalsRequestError(403, { error: "forbidden" }))).toMatchObject({ unreachableReason: "refused" });
    expect(classifyEvalsFailure(new EvalsRequestError(404, { error: "no run", reason: "not-found" }))).toBeNull();
    expect(classifyEvalsFailure(new TypeError("Failed to fetch"))).toMatchObject({ connection: "no-daemon", unreachableReason: "error" });
  });

  it("caches an answer by its request and moves the area when the child crashes mid-session", async () => {
    useEvalsStore.setState({ connection: "connected", transport: await fixtureTransport("on", { latencyMs: 0 }), resources: {} });
    await useEvalsStore.getState().load("GET /surface/:id", { params: { id: "settle" } });
    const res = useEvalsStore.getState().resources["GET /surface/settle"];
    expect(res.loading).toBe(false);
    expect((res.data as { surface: { id: string } }).surface.id).toBe("settle");
    useEvalsStore.setState({ transport: await fixtureTransport("child-crashed", { latencyMs: 0 }) });
    await useEvalsStore.getState().load("GET /overview", {});
    expect(useEvalsStore.getState().connection).toBe("child-crashed");
    expect(useEvalsStore.getState().stderr?.length).toBeGreaterThan(0);
  });
});

describe("the shell", () => {
  const states = [
    { connection: "no-daemon" as const, unreachableReason: "no-devices" as const, text: "Can't reach the local daemon" },
    { connection: "no-checkout" as const, unreachableReason: "none" as const, text: "No codecast checkout has run ./evals on this machine" },
    { connection: "child-crashed" as const, unreachableReason: "none" as const, text: "The evals process crashed" },
  ];
  for (const s of states) {
    it(`paints the ${s.connection} screen`, async () => {
      useEvalsStore.setState({ connection: s.connection, unreachableReason: s.unreachableReason, unreachableDetail: "detail line", stderr: s.connection === "child-crashed" ? ["error: Cannot find module"] : null, health: null });
      const { container, unmount } = await mount(<EvalsShell view={{ view: "home", cadence: null }}><div data-child>child</div></EvalsShell>);
      expect(container.textContent).toContain(s.text);
      expect(container.querySelector("[data-child]")).toBeNull();
      expect(container.querySelector("[data-evals-nav]")).not.toBeNull();
      expect(container.querySelector("[data-unreachable-stderr]")?.textContent ?? null).toBe(s.connection === "child-crashed" ? "error: Cannot find module" : null);
      await unmount();
    });
  }

  it("paints the view under the nav once connected, with the fixture marked", async () => {
    const transport = await fixtureTransport("on", { latencyMs: 0 });
    useEvalsStore.setState({ connection: "connected", transport, health: world.answer("GET /health", {}, {}) as never, ...{ unreachableReason: "none", unreachableDetail: null, stderr: null } });
    const { container, unmount } = await mount(<EvalsShell view={{ view: "sim" }}><div data-child>child</div></EvalsShell>);
    expect(container.querySelector("[data-child]")).not.toBeNull();
    expect(container.querySelector('[data-evals-section="sim"]')?.getAttribute("aria-current")).toBe("page");
    expect(container.querySelector('[data-evals-section="surfaces"]')?.getAttribute("aria-current")).toBeNull();
    expect(container.querySelector("[data-evals-status]")?.textContent).toContain("fixture");
    await unmount();
  });
});

describe("the chart parts", () => {
  const overview = world.answer("GET /overview", {}, { cadence: "nightly" }) as import("@codecast/shared/contracts/evalsApi").OverviewResponse;
  const title = overview.surfaces.find((s) => s.id === "title")!;

  it("draws the strip's median, pass mark, epoch notches and footing glyphs", async () => {
    const { container, unmount } = await mount(<ScoreStrip strip={title.strip} dots={title.dots} epochs={title.epochs} footing={title.footing} from={NOW - 30 * 86_400_000} to={NOW} width={480} />);
    expect(container.querySelector(".ev-strip-median")?.getAttribute("d")).toMatch(/^M[\d.]+,[\d.]+H/);
    expect(container.querySelector(".ev-strip-mark")).not.toBeNull();
    expect(container.querySelectorAll("[data-ev-epoch]").length).toBe(title.epochs.length - 1);
    expect(container.querySelectorAll('[data-ev-footing="judge"]').length).toBe(1);
    await unmount();
  });

  it("tells a well's verdict by its ring, and a flip by its notch", async () => {
    const { container, unmount } = await mount(
      <>
        <Well cell={{ reps: 2, mean: 0.9, majority: true, flip: null }} />
        <Well cell={{ reps: 2, mean: 0.3, majority: false, flip: "broke" }} />
        <Well cell={null} />
      </>,
    );
    const wells = [...container.querySelectorAll("[data-ev-well]")];
    expect(wells.map((w) => w.getAttribute("data-ev-well"))).toEqual(["pass", "fail", "none"]);
    expect(wells[1].querySelector(".ev-well-ring")?.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(wells[1].getAttribute("data-ev-flip")).toBe("broke");
    await unmount();
  });

  it("draws each verdict, separation and provenance state", async () => {
    const dirty = world.rows.find((r) => r.dirty && r.treePatch)!;
    const live = world.rows.find((r) => r.liveReads > 0)!;
    const { container, unmount } = await mount(
      <>
        {(["pass", "fail", "crash", "mixed", "dry", "unscored"] as const).map((s) => <VerdictGlyph key={s} state={s} />)}
        <SeparationMark result={{ kind: "worse", p: 0.004 }} showWord />
        <ScoreBar score={0.62} floor={0.4} />
        <ProvenanceChips row={dirty} epoch={2} />
        <ProvenanceChips row={live} />
      </>,
    );
    expect([...container.querySelectorAll("[data-ev-verdict]")].map((g) => g.getAttribute("data-ev-verdict"))).toEqual(["pass", "fail", "crash", "mixed", "dry", "unscored"]);
    expect(container.textContent).toContain("worse, p 0.004");
    expect(container.querySelector("[data-ev-scorebar]")?.getAttribute("data-ev-scorebar")).toBe("fail");
    expect(container.querySelector(".ev-chip--dirty")?.textContent).toContain("patch");
    expect(container.querySelector(".ev-chip--live")?.textContent).toContain("not reproducible");
    await unmount();
  });
});
