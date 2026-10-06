// The Evals foundation (U6): the fixture world answers every route in the
// contract with contract-shaped values, the store turns each way the evals can
// be out of reach into the right connection state, the shell paints the right
// screen for each, and the chart parts draw what they say they draw. The
// shell reads the app only through its host (host.tsx), which the last block
// holds: another host's router and screens take over, and the shell's sources
// carry no import of the app, no utility class and no --sol-* token.

import { afterAll, describe, expect, it } from "bun:test";
import { act } from "react";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { formatUsd } from "@codecast/shared/render/changeCardHtml";
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
const { VerdictGlyph, SeparationMark, ScoreBar, ProvenanceChips, EvalsLink } = await import("../parts");
const { codecastEvalsHost, EvalsHostProvider } = await import("../host");
const { usd } = await import("../format");

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
    "GET /search": { query: { q: callRun.freezeId.slice(0, 6) } },
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
    expect(classifyEvalsFailure(new EvalsRequestError(503, { error: "", reason: "no-bun" }))?.unreachableDetail).toMatch(/bun/);
    expect(
      classifyEvalsFailure(new EvalsRequestError(503, { error: "/tmp/rv last ran ./evals, and its eval tool predates the api command", reason: "checkout-no-entry" }))?.unreachableDetail,
    ).toBe("/tmp/rv last ran ./evals, and its eval tool predates the api command.");
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

  it("draws a batch the model was never asked about as a crash cross on the axis, off the median line and without dots", async () => {
    const last = title.strip[title.strip.length - 1]!;
    const unasked = { ...last, batch: "2026-10-02T10:49:25.950Z~line-branch", batchAt: new Date(Date.parse(last.batchAt) + 3_600_000).toISOString(), median: 0, mean: 0, passed: 0, unasked: true };
    const dots = [...title.dots, { batch: unasked.batch, at: unasked.batchAt, score: 0, status: "fail" as const }];
    const plain = await mount(<ScoreStrip strip={title.strip} dots={title.dots} from={NOW - 30 * 86_400_000} to={NOW + 7_200_000} width={480} />);
    const median = plain.container.querySelector(".ev-strip-median")?.getAttribute("d");
    const dotCount = plain.container.querySelectorAll("circle").length;
    await plain.unmount();
    const { container, unmount } = await mount(<ScoreStrip strip={[...title.strip, unasked]} dots={dots} from={NOW - 30 * 86_400_000} to={NOW + 7_200_000} width={480} />);
    expect(container.querySelector(`[data-ev-strip-unasked="${unasked.batch}"]`)).not.toBeNull();
    expect(container.querySelector(".ev-strip-median")?.getAttribute("d")).toBe(median);
    expect(container.querySelectorAll("circle").length).toBe(dotCount);
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

describe("the host seam", () => {
  it("renders through the host a provider hands it: its screens and its router", async () => {
    useEvalsStore.setState({ connection: "no-daemon", unreachableReason: "no-devices", unreachableDetail: null, stderr: null, health: null });
    const went: string[] = [];
    const host = {
      ...codecastEvalsHost,
      useConnection: () => ({ state: "elsewhere", screen: <div data-other-screen>another app's screen</div> }),
      useNavigate: () => (href: string) => void went.push(href),
    };
    const { container, unmount } = await mount(
      <EvalsHostProvider host={host}>
        <EvalsShell view={{ view: "home", cadence: null }}>
          <div data-child>child</div>
        </EvalsShell>
        <EvalsLink href="/evals/bisect" data-other-link>bisects</EvalsLink>
      </EvalsHostProvider>,
    );
    expect(container.querySelector("[data-evals-shell]")?.getAttribute("data-evals-connection")).toBe("elsewhere");
    expect(container.querySelector("[data-other-screen]")).not.toBeNull();
    expect(container.querySelector("[data-child]")).toBeNull();
    expect(container.textContent).not.toContain("Can't reach the local daemon");
    await act(async () => container.querySelector<HTMLAnchorElement>("[data-other-link]")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(went).toEqual(["/evals/bisect"]);
    await unmount();
  });

  const EVALS = resolve(import.meta.dir, "..");
  const WEB = resolve(EVALS, "../..");
  const SHELL = ["EvalsShell.tsx", "EvalsNav.tsx", "parts.tsx", "format.ts", ...readdirSync(join(EVALS, "pages")).map((f) => `pages/${f}`)];
  /** Each view group the shell's rules already hold, with its stylesheet. */
  const BISECT_GROUP = ["AttributionView.tsx", "CommitPanel.tsx", "BisectRuler.tsx", "BisectView.tsx", "BisectListView.tsx", "BisectPlanPanel.tsx", "bisectModel.ts"];
  const FREEZE_GROUP = ["FreezeView.tsx", "FreezeLedger.tsx", "freezeModel.ts", "CompareView.tsx", "ComparePanel.tsx", "EpochDiffSheet.tsx"];
  const RUN_GROUP = ["RunView.tsx", "GateList.tsx", "JudgeChecks.tsx", "CostTrack.tsx", "runModel.ts"];
  const SURFACE_GROUP = ["SurfaceView.tsx", "SurfaceWallView.tsx", "WhatMoved.tsx", "Seismograph.tsx", "seismographModel.ts", "surfaceModel.ts", "wallModel.ts", "verdictModel.ts", ...readdirSync(join(EVALS, "charts")).map((f) => `charts/${f}`)];
  const SOURCES = [...SHELL, ...BISECT_GROUP, ...FREEZE_GROUP, ...RUN_GROUP, ...SURFACE_GROUP];
  const STYLESHEETS = ["evals.css", "bisect.css", "freeze.css", "run.css", "runPanels.css", "surface.css", "wall.css"];
  /** Codecast's run anatomy: the host renders it under a run (useRunPanels), so no shared view imports it. */
  const ANATOMY = new Set(["CallPane", "AgentTranscript", "GuardLog", "RunFiles", "runPanels"].map((f) => `components/evals/${f}`));
  /** Codecast's Multiplayer sim stays in codecast: the wall reaches it through the host's wall slot, so no shared view imports it. */
  const SIM = new Set(["simModel", "simJobState", "simLanes", "SimCatalogView", "SimRunView", "DeliveryTimeline", "OrderStrip", "wallSim"].map((f) => `components/evals/${f}`));
  /** What a shell file may import from outside the area: react, icons, the contract and the area's own hooks. */
  const OUTSIDE = new Set(["react", "lucide-react", "@codecast/shared/contracts/evalsApi", "lib/evals/hooks"]);

  /** The literal class text of every className in a source: the strings and template runs inside each attribute's value. */
  function classTokens(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/className=/g)) {
      let i = m.index! + m[0].length;
      let value: string;
      if (text[i] === '"') value = text.slice(i, text.indexOf('"', i + 1) + 1);
      else {
        let depth = 0;
        const from = i;
        do depth += text[i] === "{" ? 1 : text[i] === "}" ? -1 : 0;
        while (++i < text.length && depth > 0);
        value = text.slice(from, i);
      }
      // A compared string (`x === "culprit" ?`) is not class text. Template holes are code, and each run between them
      // continues the token before it (`ev-chip--${tone}`).
      const literals = [...value.replace(/[!=]==?\s*"[^"]*"/g, "").replace(/\$\{[^}]*\}/g, "\u0000").matchAll(/"([^"]*)"|`([^`]*)`/g)].map((l) => l[1] ?? l[2]);
      for (const lit of literals) out.push(...lit.split(/\s+/).filter((t) => t && !t.startsWith("\u0000")).map((t) => t.replaceAll("\u0000", "")));
    }
    return out;
  }

  it("keeps the shell's sources free of the app: no import of its own, no utility class, no CSS import", () => {
    const problems: string[] = [];
    for (const file of SOURCES) {
      const text = readFileSync(join(EVALS, file), "utf8");
      for (const m of text.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"|^import\s+"([^"]+)"/gm)) {
        const spec = m[1] ?? m[2];
        if (spec.endsWith(".css")) problems.push(`${file}: imports ${spec}; the mount root imports the stylesheets once`);
        const inWeb = spec.startsWith(".") ? relative(WEB, resolve(dirname(join(EVALS, file)), spec)) : spec;
        if (!OUTSIDE.has(inWeb) && !inWeb.startsWith("components/evals/")) problems.push(`${file}: imports ${spec}; the app is reached through useEvalsHost()`);
        if (ANATOMY.has(inWeb)) problems.push(`${file}: imports ${spec}; codecast's run anatomy reaches a run through useRunPanels`);
        // The sim pages (pages/Sim*) are codecast's own and stay beside the sim views.
        if (SIM.has(inWeb) && !file.startsWith("pages/Sim")) problems.push(`${file}: imports ${spec}; codecast's Multiplayer sim reaches the wall through the host's wall slot`);
      }
      for (const token of classTokens(text)) if (!token.startsWith("ev-")) problems.push(`${file}: class "${token}" is not an ev-* rule`);
      if (text.includes("--sol-")) problems.push(`${file}: reads a --sol-* token; the views read --ev-*`);
    }
    expect(problems).toEqual([]);
  });

  it("reads colour and type only through --ev-* tokens, each of which tokens.css declares", () => {
    const tokens = readFileSync(join(EVALS, "tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const declared = new Set([...tokens.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    expect([...declared].filter((t) => !t.startsWith("--ev-"))).toEqual([]);
    // A view's own inline variable (an animation delay, the ruler's geometry) is set where it is read, not a theme token.
    const inline = new Set(SOURCES.concat(readdirSync(EVALS).filter((f) => f.endsWith(".tsx")), readdirSync(join(EVALS, "charts")).map((f) => `charts/${f}`)).flatMap((f) => [...readFileSync(join(EVALS, f), "utf8").matchAll(/["'](--ev-[\w-]+)["']/g)].map((m) => m[1])));
    for (const sheet of STYLESHEETS) {
      const css = readFileSync(join(EVALS, sheet), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect({ sheet, foreign: css.match(/--(?:sol|font)-[\w-]+/g) ?? [] }).toEqual({ sheet, foreign: [] });
      // A sheet's own variable (the wall's column template) is declared where it is read, and only under --ev-*.
      const own = new Set([...css.matchAll(/[{;]\s*(--[\w-]+)\s*:/g)].map((m) => m[1]));
      expect({ sheet, declares: [...own].filter((t) => !t.startsWith("--ev-")) }).toEqual({ sheet, declares: [] });
      const read = new Set([...css.matchAll(/var\((--ev-[\w-]+)/g)].map((m) => m[1]));
      expect({ sheet, undeclared: [...read].filter((t) => !declared.has(t) && !inline.has(t) && !own.has(t)) }).toEqual({ sheet, undeclared: [] });
    }
  });

  it("writes dollars the way the change cards do, from a dime up", () => {
    for (const v of [0.1, 0.5, 2.96, 9.994, 9.996, 10, 39.4, 1234.5]) expect(usd(v)).toBe(formatUsd(v));
    expect(usd(0.004)).toBe("$0.004");
    expect(usd(0)).toBe("$0");
  });
});
