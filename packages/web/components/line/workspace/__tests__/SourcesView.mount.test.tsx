// Mounts the Sources view (line-workspace.md LW1) in jsdom: a row per source
// with a product's judges under it, the busiest selected when the URL names
// none, its findings in their own words with the problem each opened or
// joined, and the keys that walk sources and open a finding's problem.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

setDefaultTimeout(60_000);

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/line?view=sources", pretendToBeVisual: true });
const matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400, matchMedia }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  Event: dom.window.Event,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  matchMedia,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const { SourcesView } = await import("../views/SourcesView");
const { readLineSelection } = await import("../../../../lib/line/lineWorkspaceUrl");

const NOW = 1_791_500_000_000;
const H = 3_600_000;
const sig = (id: string, source: string, ago: number, extra: Record<string, unknown> = {}) => ({ _id: id, source, kind: "prompt_miss", title: `${source} finding ${id}`, created_at: NOW - ago, observed_at: NOW - ago, task_id: "t1", project_id: "p1", ...extra });
const signals = [
  sig("s1", "agentwatch", H, { judge: "comms", attach: "new", detail_md: "**Personas pitched twice** (severity 8/10, execution_quality)\n\nQuinn and Jordan each sent it.", evidence_url: "https://admin.example.com/aw?c=1" }),
  sig("s2", "agentwatch", 2 * H, { judge: "match", attach: "judge" }),
  sig("s3", "person", 30 * H, { task_id: "t2", attach: "new" }),
];
const project = { _id: "p1", short_id: "pj-aq", title: "Agent Quality", line_profile: { finders: [{ id: "clusters", source: "agentwatch", kind: ["prompt_miss"], fingerprint: "union:cluster:<id>", runs: "backend job project-line-signal" }], changed_at: 0 } };
const workspace = {
  project, projects: [project], now: NOW,
  rows: {
    signals,
    tasks: [{ _id: "t1", short_id: "ct-1", title: "Senders repeat a pitch", status: "open" }, { _id: "t2", short_id: "ct-2", title: "A person's report", status: "open" }],
    runs: [{ _id: "r1", task_id: "t1", status: "completed", workflow_slug: "agentwatch", created_at: NOW - H, updated_at: NOW - H }],
    decisions: [],
  },
};

const selects: any[] = [];
const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);
async function render(search: string) {
  const selection = readLineSelection(new URLSearchParams(search));
  await act(async () => root.render(React.createElement(SourcesView, { model: {} as any, workspace: workspace as any, selection, select: (p: any) => selects.push(p), href: () => "#" })));
}
const q = (s: string) => host.querySelector(s);
const qa = (s: string) => [...host.querySelectorAll(s)];

test("a row per source, a product's judges under it, the busiest open", async () => {
  await render("view=sources");
  expect(qa("[data-line-source]").map((e) => e.getAttribute("data-line-source"))).toEqual(["agentwatch", "agentwatch/comms", "agentwatch/match", "person"]);
  expect(q("[data-line-source-detail]")?.getAttribute("data-line-source-detail")).toBe("agentwatch");
  expect(q("[data-line-source-finders]")?.textContent).toContain("union:cluster:<id>");
  expect(q("[data-line-source-process='agentwatch']")?.textContent).toContain("AgentWatch");
});

test("a finding in its own words, its severity, and the problem it opened", async () => {
  await render("view=sources&source=agentwatch/comms");
  const items = qa("[data-line-finding]");
  expect(items).toHaveLength(1);
  const text = items[0].textContent ?? "";
  expect(text).toContain("8");
  expect(text).toContain("Quinn and Jordan each sent it.");
  expect(text).toContain("opened");
  expect(text).toContain("ct-1");
  expect(text).toContain("admin.example.com");
  await act(async () => (q("[data-line-finding-problem]") as HTMLElement).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 })));
  expect(selects.at(-1)).toEqual({ view: "problems", case: "t1", run: null });
});

test("j walks to the next source, Enter opens the selected finding's problem", async () => {
  await render("view=sources&source=agentwatch");
  await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "j", bubbles: true })); });
  expect(selects.at(-1)).toEqual({ source: "agentwatch/comms" });
  await render("view=sources&source=person&finding=s3");
  await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(selects.at(-1)).toEqual({ view: "problems", case: "t2", run: null });
});
