import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../../../test-helpers/domGlobals";

// Each Problems row carries a strip over the page's window: its findings as
// bars, its newest fix as a line where it went live, the span since tinted by
// what followed, and findings after a close that did not hold in red. A row's
// state reads off the strip: quiet since the fix, came back, or no fix yet.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/line?view=problems" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { ProblemTable } = await import("../ProblemTable");
const { overviewWindow } = await import("../../../../../../lib/line/problemsOverview");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 12, 15, 30).getTime();
const win = overviewWindow("7d", NOW);

const ship = (runId: string, liveAt: number, deployed: boolean) => ({
  runId, at: liveAt, merge: { at: liveAt - HOUR, sha: "abc1234", branch: "fix", into: "main" }, deploys: deployed ? [{ id: `d-${runId}`, at: liveAt, runId }] : [], liveAt, basis: deployed ? "deploy" : "merge", words: "",
});
const history = (times: number[], extra: Record<string, unknown> = {}) => ({
  occurrences: times.sort((a, b) => a - b).map((at) => ({ at, reopened: false })), attempts: [], ships: [], closes: [], regressions: [], recurrences: [], watches: [], deploys: [],
  coverage: { state: "known" }, regressed: false, cameBack: false, ...extra,
});
const row = (id: string, h: Record<string, unknown>, status = "shipped") => ({
  id, issue: { id, ref: `ct-${id}`, title: `Problem ${id}`, history: h }, stand: { status, phrase: status }, projectId: null,
  findings: (h.occurrences as unknown[]).length, inWindow: (h.occurrences as unknown[]).length, before: null, series: true, seenAt: NOW, lastAt: NOW, dupOf: null, hay: "", aboutSteps: [],
});

const fixAt = NOW - 3 * DAY;
const rows = [
  // Fixed and deployed three days ago, nothing since.
  row("quiet", history([NOW - 5 * DAY, NOW - 4 * DAY], { ships: [ship("r1", fixAt, true)] })),
  // Fixed and deployed, then came back twice.
  row("back", history([NOW - 5 * DAY, NOW - DAY, NOW - 2 * HOUR], {
    ships: [ship("r2", fixAt, true)], regressed: true,
    regressions: [{ afterRunId: "r2", liveAt: fixAt, at: NOW - DAY, until: null, count: 2, words: "came back 2x" }],
  })),
  // Never fixed.
  row("open", history([NOW - 6 * DAY, NOW - 2 * DAY]), "notstarted"),
  // Merged, no deploy carried it.
  row("merged", history([NOW - 5 * DAY], { ships: [ship("r3", fixAt, false)] })),
];

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(
    <ProblemTable sections={[{ status: null, label: "", n: rows.length, rows } as never]} now={NOW} range="7d" win={win} showProject={false}
      projectName={() => ""} href={(id) => `/line?case=${id}`} open={() => {}} onStatus={() => {}} />,
  ));
  return { container, unmount: () => act(() => root.unmount()) };
}

const strip = (c: HTMLElement, id: string) => c.querySelector(`[data-line-issue="${id}"] svg.lwp-strip`) as SVGElement;

test("a row's strip says where it stands against its fix, by its state and the fix's line", async () => {
  const { container, unmount } = await mount();
  expect(strip(container, "quiet").getAttribute("data-state")).toBe("quiet");
  expect(strip(container, "quiet").getAttribute("data-fix")).toBe("production");
  expect(strip(container, "back").getAttribute("data-state")).toBe("back");
  expect(strip(container, "open").getAttribute("data-state")).toBe("nofix");
  expect(strip(container, "open").querySelector(".lwp-strip-fix")).toBeNull();
  expect(strip(container, "merged").getAttribute("data-state")).toBe("unlive");
  // The fix's line sits at the deploy, the span after it tinted; a fix no deploy carried tints nothing.
  const line = strip(container, "quiet").querySelector(".lwp-strip-fix")!;
  const x = Number(line.getAttribute("x1"));
  expect(x).toBeCloseTo(((fixAt - win.d0) / (win.d1 - win.d0)) * 150, 3);
  expect(Number(strip(container, "quiet").querySelector(".lwp-strip-after")!.getAttribute("x"))).toBeCloseTo(x, 3);
  expect(strip(container, "merged").querySelector(".lwp-strip-after")).toBeNull();
  await unmount();
});

test("findings after the fix went live are the red bars; those before are not", async () => {
  const { container, unmount } = await mount();
  const back = strip(container, "back");
  expect(back.querySelectorAll(".lwp-strip-bar[data-back]").length).toBe(2);
  expect(back.querySelectorAll(".lwp-strip-bar:not([data-back])").length).toBe(1);
  expect(strip(container, "quiet").querySelectorAll(".lwp-strip-bar[data-back]").length).toBe(0);
  expect(strip(container, "quiet").querySelectorAll(".lwp-strip-bar").length).toBe(2);
  await unmount();
});

test("the strip's hover line names the window, the fix and what came after it", async () => {
  const { container, unmount } = await mount();
  expect(strip(container, "back").getAttribute("aria-label")).toMatch(/^3 findings in 7d · fix deployed \w+ \d+ · 2 since$/);
  expect(strip(container, "open").getAttribute("aria-label")).toBe("2 findings in 7d · no fix yet");
  await unmount();
});
