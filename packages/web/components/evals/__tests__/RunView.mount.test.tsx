// One run in full and two runs compared (U9): the page's decisions (which
// tabs a rep has, which tab and row an address names, which run its prompts
// diff against, which reps j/k and c reach), the view painting every tab for
// a call surface and an agent surface, a crashed rep, an unscored rep and
// org-review's extra grade, the compare view, and the connected pages reading
// it all through the fixture transport with the address landing on a gate.
// The view reaches the app only through its host: codecast's anatomy tabs
// come from the host's useRunPanels, and another host's panels replace them.

import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/evals", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  Element: dom.window.Element,
  SVGElement: dom.window.SVGElement,
  Node: dom.window.Node,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  getComputedStyle: dom.window.getComputedStyle,
  CSS: { escape: (s: string) => s.replace(/["\\]/g, "\\$&") },
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, useLocation } = await import("react-router");
const { useEvalsStore } = await import("../../../store/evalsStore");
const { fixtureTransport } = await import("../../../lib/evals/fixtureTransport");
const { runFixture } = await import("../__fixtures__/run");
const { fixtureWorldNow, evalsFixtureWorld } = await import("../__fixtures__/world");
const { RunView } = await import("../RunView");
const { tabOfHash, epochOfBatch, previousEpochRun, seedNeighbours, runCommands, compareCandidates, replyReading } = await import("../runModel");
const { CompareView } = await import("../CompareView");
const { diffWords, compareFooting } = await import("../runModel");
const { orderGates, gateEvidenceWords } = await import("../runModel");
const { anatomyTabs } = await import("../runPanels");
const { guardCounts } = await import("../GuardLog");
const { fileTree } = await import("../RunFiles");
const { codecastEvalsHost, EvalsHostProvider } = await import("../host");
const { RunPage } = await import("../pages/RunPage");
const { ComparePage } = await import("../pages/ComparePage");
const { formatShortcutParts, getShortcutsForAction } = await import("../../../shortcuts");
type RunViewProps = import("../RunView").RunViewProps;
type RunFixtureCase = import("../__fixtures__/run").RunFixtureCase;

// A loaded machine renders a DiffView in seconds, not milliseconds.
setDefaultTimeout(60_000);

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const fx = runFixture();

async function mount(node: React.ReactNode, at = "/evals") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={[at]}>{node}</MemoryRouter>));
  return { container, rerender: (n: React.ReactNode) => act(async () => root.render(<MemoryRouter initialEntries={[at]}>{n}</MemoryRouter>)), unmount: () => act(async () => root.unmount()) };
}

const noop = () => {};
function props(c: RunFixtureCase, over: Partial<RunViewProps> = {}): RunViewProps {
  return {
    run: c.run,
    freeze: c.freeze,
    evalsHome: "/home/you/.local/share/codecast/evals",
    tab: "verdict",
    onTab: noop,
    target: null,
    anchorHref: (a) => `/evals/r/${c.run.row.id}#${a}`,
    onAnchor: noop,
    picking: false,
    onPicking: noop,
    overlayProduction: false,
    onOverlayProduction: noop,
    ...over,
  };
}

const q = (el: ParentNode, sel: string) => el.querySelector(sel);
const qa = (el: ParentNode, sel: string) => [...el.querySelectorAll(sel)];
const text = (el: Element | null) => el?.textContent ?? "";

describe("what the run page decides", () => {
  it("names the judge as the reply's reader only when a score exists", () => {
    expect(replyReading(fx.call.run)).toBe("as the judge read it");
    expect(replyReading({ ...fx.call.run, score: null, row: { ...fx.call.run.row, status: "unscored" } })).toBe("not judged yet");
  });
  it("gives a call rep Calls and no Agent or Guard, and an agent rep both, after the page's own two tabs", async () => {
    expect(anatomyTabs(fx.call.run)).toEqual(["calls", "files"]);
    expect(anatomyTabs(fx.agent.run)).toEqual(["agent", "guard", "files"]);
    const { container, unmount } = await mount(<RunView {...props(fx.agent)} />);
    expect(qa(container, "[data-ev-tab]").map((t) => t.getAttribute("data-ev-tab"))).toEqual(["verdict", "moment", "agent", "guard", "files"]);
    await unmount();
  });

  it("reads a gate or check address as the Verdict tab with that row, and a tab name as the tab", async () => {
    expect(tabOfHash("#gate-no-leak")).toEqual({ tab: "verdict", target: "gate-no-leak" });
    expect(tabOfHash("#check-criteria")).toEqual({ tab: "verdict", target: "check-criteria" });
    expect(tabOfHash("#guard")).toEqual({ tab: "guard", target: null });
    expect(tabOfHash("")).toEqual({ tab: "verdict", target: null });
    // A name the run has no tab for opens Verdict: a call rep has no Guard.
    const { container, unmount } = await mount(<RunView {...props(fx.call, { tab: "guard" })} />);
    expect(q(container, "[role=tabpanel]")!.getAttribute("data-ev-panel")).toBe("verdict");
    expect(q(container, "[data-ev-tab=verdict]")!.getAttribute("aria-current")).toBe("page");
    await unmount();
  });

  it("diffs a rep's prompts against the same freeze in the previous epoch, and says why when there is none", () => {
    const { row } = fx.call.run;
    const { epochs, runs } = fx.call.freeze;
    const e = epochOfBatch(row.batchAt, epochs)!;
    expect(e.n).toBeGreaterThan(1);
    const prev = previousEpochRun(row, runs, epochs);
    const prevRow = runs.find((r) => r.id === prev.id)!;
    expect(prevRow.freezeId).toBe(row.freezeId);
    expect(epochOfBatch(prevRow.batchAt, epochs)!.n).toBe(e.n - 1);
    expect(prev.why).toBe(`e${e.n - 1} against e${e.n}`);
    const first = runs.find((r) => epochOfBatch(r.batchAt, epochs)?.n === 1)!;
    expect(previousEpochRun(first, runs, epochs)).toEqual({ id: null, why: "This rep ran in the first prompt epoch: there is nothing earlier to diff against" });
    expect(previousEpochRun(row, runs, []).id).toBeNull();
  });

  it("walks seeds in order and builds the commands from the row", () => {
    const { row, siblings } = fx.call.run;
    const s = seedNeighbours(row, siblings);
    expect(s.all.map((r) => r.seed)).toEqual([...s.all.map((r) => r.seed)].sort((a, b) => a - b));
    expect(s.all.some((r) => r.id === row.id)).toBe(true);
    if (row.seed === 1) expect(s.prev).toBeNull();
    const cmds = runCommands(row, "/h");
    expect(cmds.path).toBe(`/h/runs/${row.id}`);
    expect(cmds.replay).toBe(`./evals freeze replay ${row.freezeId.slice(0, 8)} --reps 3 --model ${row.model}`);
    expect(cmds.rescore).toBe(`./evals rescore ${row.id}`);
    expect(runCommands(row, null).path.startsWith("$EVALS_HOME/runs/")).toBe(true);
  });

  it("offers this batch's other seeds, the adjacent batches and the freeze's other reps to compare with, never itself", () => {
    const groups = compareCandidates(fx.call.run, fx.call.freeze.runs);
    const ids = groups.flatMap((g) => g.rows.map((r) => r.id));
    expect(ids).not.toContain(fx.call.run.row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(groups[0].group).toBe("This batch, other seeds");
    // A dry neighbour (one batch either side) is never offered.
    const dryRow = fx.dry.run.row;
    const withDry = compareCandidates({ ...fx.call.run, adjacent: { previous: dryRow.id, next: null } }, [...fx.call.freeze.runs, dryRow]);
    expect(withDry.flatMap((g) => g.rows.map((r) => r.id))).not.toContain(dryRow.id);
  });

  it("puts failing gates first and says a vacuous hold had nothing to check", () => {
    const gates = fx.gate.run.score!.gates;
    expect(orderGates(gates)[0].pass).toBe(false);
    const vacuous = gates.find((g) => g.evidence.vacuous)!;
    expect(gateEvidenceWords(vacuous)).toBe("held, nothing to check");
    // A summary states its own count; the scanned number never repeats it.
    const counted = { id: "boundary-clean", pass: true, evidence: { summary: "4 calls caught at the boundary, none blocked", scanned: 4 } } as (typeof gates)[number];
    expect(gateEvidenceWords(counted)).toBe("4 calls caught at the boundary, none blocked");
  });

  it("counts guard marks from the log and groups files under their folders", () => {
    const c = guardCounts(fx.agent.run.guard);
    expect(c.LIVE).toBeGreaterThan(0);
    expect(c.SERVED).toBe(fx.agent.run.guard.filter((g) => g.status === "SERVED").length);
    const tree = fileTree(fx.agent.run.files);
    expect(tree[0].dir).toBe("");
    expect(tree.find((g) => g.dir === "agent1")!.files.map((f) => f.path)).toContain("agent1/then2.md");
  });

  it("the fixture's file tree states each file's size as the open file does", () => {
    const world = evalsFixtureWorld({ now: Date.parse("2026-10-03T12:00:00.000Z") });
    for (const c of [fx.call, fx.agent, fx.crash]) {
      for (const f of c.run.files.filter((x) => x.kind === "file")) {
        const opened = world.answer("GET /run/:id/file", { id: c.run.row.id }, { path: f.path }) as { size: number };
        expect({ path: f.path, size: opened.size }).toEqual({ path: f.path, size: f.size });
      }
    }
  });

  it("reads a compare entry's direction", () => {
    expect(diffWords({ kind: "gate", id: "no-leak", before: true, after: false })).toEqual({ tone: "broke", before: "held", after: "failed" });
    expect(diffWords({ kind: "check", id: "criteria", before: 0.4, after: 0.9 })).toEqual({ tone: "fixed", before: "0.40", after: "0.90" });
    expect(compareFooting(fx.compare.a, fx.compare.a)).toEqual([]);
  });
});

describe("RunView", () => {
  it("paints the header: score against the mark, chips, seed strip, copies and key hints", async () => {
    const { container, unmount } = await mount(<RunView {...props(fx.call)} />);
    const row = fx.call.run.row;
    expect(text(q(container, "[data-ev-score]"))).toBe(row.score!.toFixed(2));
    expect(q(container, "[data-ev-ruler]")).not.toBeNull();
    const chips = text(q(container, "[data-ev-run-chips]"));
    expect(chips).toContain(row.surface);
    expect(chips).toContain(row.model!);
    expect(chips).toContain(row.judgeModel!);
    expect(text(q(container, "[data-ev-run-chips] [title^='Prompt epoch']"))).toMatch(/^e\d+$/);
    expect(q(container, "[data-ev-lock]")).not.toBeNull();
    expect(qa(container, "[data-ev-seed]").length).toBe(fx.call.run.siblings.length + 1);
    expect(q(container, "[data-ev-self]")).not.toBeNull();
    // The hints read the registry, so they show what the bindings are (the registry writes letters as capitals).
    const bound = (["evalsRun.nextSeed", "evalsRun.prevSeed", "evalsRun.prevBatch", "evalsRun.nextBatch", "evalsRun.compare"] as const).flatMap((a) => formatShortcutParts(getShortcutsForAction(a)[0]));
    expect(qa(container, "kbd").map((k) => k.textContent)).toEqual(bound);
    expect(bound).toEqual(["J", "K", "[", "]", "C"]);
    expect(qa(container, "[data-ev-tab]").map((t) => t.getAttribute("data-ev-tab"))).toEqual(["verdict", "moment", "calls", "files"]);
    await unmount();
  });

  it("Verdict: failing gates first with their addresses, judged checks with floors and reasoning, the score history", async () => {
    const { container, unmount } = await mount(<RunView {...props(fx.gate, { target: "gate-no-leak" })} />);
    const gates = qa(container, "[data-ev-gate]");
    expect(gates[0].getAttribute("data-ev-gate-pass")).toBe("false");
    expect(gates[0].id).toBe("gate-no-leak");
    expect(gates[0].getAttribute("data-ev-target")).toBe("true");
    expect(text(q(container, "#gate-shape"))).toContain("held, nothing to check");
    expect(q(container, "#check-criteria .ev-judge")).not.toBeNull();
    expect(q(container, "#check-criteria [data-ev-scorebar]")).not.toBeNull();
    expect(q(container, "[data-ev-score-history]")).not.toBeNull();
    expect(q(container, "[data-ev-judge-call]")).not.toBeNull();
    expect(q(container, "[data-ev-tab=verdict] .ev-tab-flag")).not.toBeNull();
    await unmount();
  });

  it("Moment and reply: the frozen moment with its cut, the sends, and production's reply on the toggle", async () => {
    const { container, rerender, unmount } = await mount(<RunView {...props(fx.call, { tab: "moment" })} />);
    expect(q(container, "[data-ev-moment]")).not.toBeNull();
    expect(q(container, "[data-ev-frozen-cut]")).not.toBeNull();
    expect(qa(container, "[data-ev-send]").length).toBe(fx.call.run.sends.length);
    expect(q(container, "[data-ev-production]")).toBeNull();
    await rerender(<RunView {...props(fx.call, { tab: "moment", overlayProduction: true })} />);
    expect(q(container, "[data-ev-production]")).not.toBeNull();
    await unmount();
  });

  it("Calls: request, system and prompt panes with the epoch diff, the reply, tokens and cost", async () => {
    const { container, unmount } = await mount(<RunView {...props(fx.call, { tab: "calls" })} />);
    const call = q(container, "[data-ev-call='1']")!;
    expect(text(call)).toContain("max_tokens 1,024");
    expect(text(call)).toContain("end_turn");
    expect(q(call, "[data-ev-pane='call1/system.md']")).not.toBeNull();
    expect(q(call, "[data-ev-pane='call1/prompt.md']")).not.toBeNull();
    expect(q(call, "[data-ev-pane='reply']")!.hasAttribute("open")).toBe(true);
    const diffBtn = qa(call, "button").find((b) => b.textContent?.includes("previous epoch")) as HTMLButtonElement;
    expect(diffBtn.disabled).toBe(false);
    expect(text(q(call, "[data-ev-tokens]"))).toContain("cache read");
    await unmount();
  });

  it("Agent and Guard: turns with tool calls and the follow-up, args.json, and every guard mark with LIVE flagged", async () => {
    const { container, rerender, unmount } = await mount(<RunView {...props(fx.agent, { tab: "agent" })} />);
    expect(qa(container, "[data-ev-turn]").length).toBe(fx.agent.run.agents[0].turns.length);
    expect(q(container, "[data-ev-tool='Bash']")).not.toBeNull();
    expect(q(container, ".ev-turn-ask")).not.toBeNull();
    expect(q(container, "[data-ev-pane='agent1/then2.md']")).not.toBeNull();
    expect(text(q(container, "[data-ev-args]"))).toContain("served/");
    expect(q(container, "[data-ev-tab=guard] .ev-tab-flag")).not.toBeNull();
    await rerender(<RunView {...props(fx.agent, { tab: "guard" })} />);
    expect(qa(container, "[data-ev-guard-row]").length).toBe(fx.agent.run.guard.length);
    expect(q(container, "[data-ev-guard-row=LIVE] [data-ev-guard-status=LIVE]")).not.toBeNull();
    expect(text(q(container, "[data-ev-guard-count=LIVE] .ev-num"))).toBe(String(guardCounts(fx.agent.run.guard).LIVE));
    // Filtering by a mark leaves only its rows.
    await act(async () => (q(container, "[data-ev-guard-count=SERVED]") as HTMLButtonElement).click());
    expect(new Set(qa(container, "[data-ev-guard-row]").map((r) => r.getAttribute("data-ev-guard-row")))).toEqual(new Set(["SERVED"]));
    await unmount();
  });

  it("Files: the tree, the open file read-only, and the open file kept while the reader visits another tab", async () => {
    // The panel reads the open file itself (GET /run/:id/file), so it needs the transport's world.
    useEvalsStore.setState({ connection: "connected", transport: await fixtureTransport("on", { latencyMs: 0 }), resources: {} });
    const c = runFixture(fixtureWorldNow()).call;
    const { container, rerender, unmount } = await mount(<RunView {...props(c, { tab: "files" })} />);
    expect(qa(container, "[data-ev-file]").length).toBe(c.run.files.filter((f) => f.kind === "file").length);
    expect(q(container, "[data-ev-tab=files] .ev-tab-count")!.textContent).toBe(String(c.run.files.filter((f) => f.kind === "file").length));
    expect(text(q(container, "[data-ev-file-view]"))).toContain("Pick a file");
    await act(async () => (q(container, "[data-ev-file='run.json']") as HTMLButtonElement).click());
    for (let i = 0; i < 50 && !text(q(container, "[data-ev-file-view]")).includes('"model"'); i++) await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(q(container, "[data-ev-file='run.json']")!.getAttribute("aria-current")).toBe("true");
    expect(text(q(container, "[data-ev-file-view]"))).toContain('"model"');
    await rerender(<RunView {...props(c, { tab: "calls" })} />);
    expect(q(container, "[data-ev-files]")).toBeNull();
    await rerender(<RunView {...props(c, { tab: "files" })} />);
    expect(q(container, "[data-ev-file-view]")!.getAttribute("data-ev-file-view")).toBe("run.json");
    // Another run opens with no file.
    await rerender(<RunView {...props(runFixture(fixtureWorldNow()).gate, { tab: "files" })} />);
    expect(q(container, "[data-ev-file-view]")!.getAttribute("data-ev-file-view")).toBe("");
    await unmount();
  });

  it("draws another host's panels in place of codecast's anatomy, with their counts and flags, and none for a host without", async () => {
    let seen: { run: string; previous: string | null } | null = null;
    const host = {
      ...codecastEvalsHost,
      useRunPanels: (run: typeof fx.agent.run, ctx: { previousEpoch: { id: string | null } }) => {
        seen = { run: run.row.id, previous: ctx.previousEpoch.id };
        return [
          { id: "funnel", label: "Funnel", count: 3, body: <div data-other-panel>the funnel</div> },
          { id: "story", label: "Story", flag: "It stalled", body: <div>the story</div> },
        ];
      },
    };
    const { container, rerender, unmount } = await mount(
      <EvalsHostProvider host={host}>
        <RunView {...props(fx.call, { tab: "funnel" })} />
      </EvalsHostProvider>,
    );
    expect(qa(container, "[data-ev-tab]").map((t) => t.getAttribute("data-ev-tab"))).toEqual(["verdict", "moment", "funnel", "story"]);
    expect(q(container, "[data-other-panel]")).not.toBeNull();
    expect(q(container, "[data-ev-call]")).toBeNull();
    expect(text(q(container, "[data-ev-tab=funnel] .ev-tab-count"))).toBe("3");
    expect(q(container, "[data-ev-tab=story] .ev-tab-flag")!.getAttribute("title")).toBe("It stalled");
    expect(seen).toEqual({ run: fx.call.run.row.id, previous: previousEpochRun(fx.call.run.row, fx.call.freeze.runs, fx.call.freeze.epochs).id });
    const { useRunPanels: _, ...bare } = host;
    await rerender(
      <EvalsHostProvider host={bare}>
        <RunView {...props(fx.call, { tab: "calls" })} />
      </EvalsHostProvider>,
    );
    expect(qa(container, "[data-ev-tab]").map((t) => t.getAttribute("data-ev-tab"))).toEqual(["verdict", "moment"]);
    expect(q(container, "[role=tabpanel]")!.getAttribute("data-ev-panel")).toBe("verdict");
    await unmount();
  });

  it("a crashed rep leads with its log tail; an unscored rep shows the rubric it will be held to", async () => {
    const crash = await mount(<RunView {...props(fx.crash)} />);
    expect(text(q(crash.container, "[data-ev-crash]"))).toContain(fx.crash.run.logTail!.split("\n")[1]);
    expect(text(q(crash.container, "[data-ev-score]"))).toBe("crash");
    expect(text(q(crash.container, "[data-ev-rubric=crash]"))).toContain("never scored");
    await crash.unmount();
    const unscoredCase = { ...fx.call, run: { ...fx.call.run, score: null, scoreVersions: [], judge: null, rubric: { criteria: "Done means verified.", passMark: 0.7 }, row: { ...fx.call.run.row, status: "unscored" as const, score: null } } };
    const unscored = await mount(<RunView {...props(unscoredCase)} />);
    expect(text(q(unscored.container, "[data-ev-rubric=unscored]"))).toContain("Not scored yet. It will be held to this.");
    expect(text(q(unscored.container, "[data-ev-rubric=unscored]"))).toContain("Done means verified.");
    expect(text(q(unscored.container, "[data-ev-verdict-reply]"))).toContain("not judged yet");
    await unscored.unmount();
  });

  it("a dry rep counts toward nothing: no reply, the freeze's rubric, and the tool's grade of the echoed prompt folded away", async () => {
    // Like a real dry folder: a score.json that graded the rendered prompt, so the child sends no rubric.
    expect(fx.dry.run.score).not.toBeNull();
    expect(fx.dry.run.rubric).toBeNull();
    const dry = await mount(<RunView {...props(fx.dry)} />);
    expect(text(q(dry.container, "[data-ev-score]"))).toBe("dry");
    expect(q(dry.container, "[data-ev-verdict-reply]")).toBeNull();
    expect(q(dry.container, "[data-ev-tab=verdict] .ev-tab-flag")).toBeNull();
    expect(text(q(dry.container, "[data-ev-rubric=dry]"))).toContain(fx.dry.freeze.freeze.judge!);
    const fold = q(dry.container, "[data-ev-dry-grade]") as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(text(fold.querySelector("summary"))).toContain("counts toward nothing");
    await dry.rerender(<RunView {...props(fx.dry, { tab: "calls" })} />);
    expect(text(q(dry.container, "[data-ev-call]"))).toContain("dry render, no model called");
    expect(q(dry.container, "[data-ev-pane=reply]")).toBeNull();
    await dry.rerender(<RunView {...props(fx.dry, { tab: "moment" })} />);
    expect(text(q(dry.container, "[data-ev-sends]"))).toContain("sends nothing");
    await dry.unmount();
  });

  it("org-review shows grade-auto.json and hashes.json under the verdict", async () => {
    const { container, unmount } = await mount(<RunView {...props(fx.org)} />);
    expect(q(container, "[data-ev-pane='grade-auto.json']")).not.toBeNull();
    expect(q(container, "[data-ev-pane='hashes.json']")).not.toBeNull();
    await unmount();
  });

  it("the compare picker lists reps to pair with this one", async () => {
    const { container, unmount } = await mount(<RunView {...props(fx.call, { picking: true })} />);
    const picks = qa(container, "[data-ev-pick]");
    expect(picks.length).toBeGreaterThan(0);
    expect(picks[0].getAttribute("href")).toContain(`/evals/compare?a=${encodeURIComponent(fx.call.run.row.id)}`);
    await unmount();
  });
});

describe("CompareView", () => {
  it("shows what moved, both replies and both prompts diffed", async () => {
    const { container, unmount } = await mount(<CompareView data={fx.compare} />);
    expect(qa(container, "[data-ev-cmp-side]").length).toBe(2);
    expect(qa(container, "[data-ev-diff]").length).toBe(fx.compare.diff.length);
    expect(qa(container, "[data-ev-reply]").length).toBe(2);
    expect(qa(container, "[data-ev-prompt-diff]").map((p) => p.getAttribute("data-ev-prompt-diff"))).toEqual(fx.compare.prompts.map((p) => p.file));
    expect(q(container, "[data-ev-swap]")!.getAttribute("href")).toContain(`a=${encodeURIComponent(fx.compare.b.id)}`);
    await unmount();
  });
});

describe("the connected pages", () => {
  // The fixture transport builds its world at the default clock, and run ids carry their stamps.
  const live = runFixture(fixtureWorldNow());
  function Where({ onAt }: { onAt: (s: string) => void }) {
    const l = useLocation();
    onAt(`${l.pathname}${l.hash}`);
    return null;
  }

  it("RunPage reads the run and its freeze, opens the tab and row the address names, and moves the address on a tab click", async () => {
    useEvalsStore.setState({ connection: "connected", transport: await fixtureTransport("on", { latencyMs: 0 }), resources: {} });
    const id = live.gate.run.row.id;
    let at = "";
    const { container, unmount } = await mount(
      <>
        <RunPage view={{ view: "run", runId: id }} />
        <Where onAt={(s) => (at = s)} />
      </>,
      `/evals/r/${id}#gate-no-leak`,
    );
    for (let i = 0; i < 50 && !q(container, "[data-evals-run]"); i++) await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(q(container, "#gate-no-leak")!.getAttribute("data-ev-target")).toBe("true");
    for (let i = 0; i < 50 && !q(container, "[data-ev-moment]"); i++) {
      if (i === 0) await act(async () => (q(container, "[data-ev-tab=moment]") as HTMLButtonElement).click());
      await act(async () => new Promise((r) => setTimeout(r, 20)));
    }
    expect(at).toBe(`/evals/r/${id}#moment`);
    expect(q(container, "[data-ev-moment]")).not.toBeNull();
    await unmount();
  });

  it("RunPage says so for an unknown run, and ComparePage reads both runs", async () => {
    useEvalsStore.setState({ connection: "connected", transport: await fixtureTransport("on", { latencyMs: 0 }), resources: {} });
    const miss = await mount(<RunPage view={{ view: "run", runId: "settle-00000000-seed1-nope" }} />);
    for (let i = 0; i < 50 && !miss.container.textContent?.includes("No run by that id"); i++) await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(miss.container.textContent).toContain("No run by that id");
    await miss.unmount();
    const cmp = await mount(<ComparePage view={{ view: "compare", a: live.compare.a.id, b: live.compare.b.id }} />);
    for (let i = 0; i < 50 && !q(cmp.container, "[data-evals-compare]"); i++) await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(qa(cmp.container, "[data-ev-cmp-side]").length).toBe(2);
    await cmp.unmount();
  });
});
