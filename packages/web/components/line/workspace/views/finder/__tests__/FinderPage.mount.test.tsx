// Mounts a finder's page and the Find table (line-journeys.md LJ8.5, LJ8.6) in
// jsdom on findings shaped like the real store's: a product judge whose
// findings were filed and one a person marked wrong, and Escalation, whose
// findings no person can mark. The table's numbers are the page's rows; a
// judge's open finding offers "Judge is wrong", Escalation's offers only its
// link; unfiled findings carry no count.
import { afterAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../../../test-helpers/domGlobals";

setDefaultTimeout(60_000);

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/line?view=line", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  Event: dom.window.Event,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

// MomentView frames Union's screen; its own test covers it.
const realMoment = await import("../../../../widgets/MomentView");
mock.module("../../../../widgets/MomentView", () => ({ ...realMoment, MomentView: ({ moment }: any) => React.createElement("div", { "data-stub-moment": moment }) }));

// A finding's whole detail is a per-view query; the feed's words stand in here.
const noThrow = await import("../../../../../../hooks/useQueryNoThrow");
mock.module("../../../../../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined }) }));

const { useInboxStore } = await import("../../../../../../store/inboxStore");
const { FinderPage } = await import("../FinderPage");
const { FindTable } = await import("../FindTable");
const { readLineSelection } = await import("../../../../../../lib/line/lineWorkspaceUrl");

const now = 1_790_000_000_000;
const sg = (id: string, o: Record<string, unknown>) => ({ _id: id, short_id: `sg-${id}`, source: "agentwatch", kind: "prompt_miss", title: `Finding ${id}`, detail_md: `What ${id} saw.`, created_at: now - 3600_000, ...o });
const signals = [
  sg("a", { judge: "comms", task_id: "t1", evidence_url: "https://admin.unionmatching.com/agent-watch?cluster=1&finding=a" }),
  sg("b", { judge: "comms", task_id: "t1" }),
  sg("c", { judge: "comms" }),
  sg("d", { judge: "match", task_id: "t1" }),
  sg("e", { source: "union.escalation", kind: "request", evidence_url: "https://admin.unionmatching.com/agent-runs?run=9" }),
  sg("f", { source: "union.escalation", kind: "request", task_id: "t3" }),
];
const tasks = [{ _id: "t1", short_id: "ct-57845", title: "Search-status updates recite our counters", status: "open" }, { _id: "t3", short_id: "ct-59001", title: "Brokers keep asking a person to deliver", status: "open" }];
useInboxStore.setState({ currentUser: { _id: "u1", name: "Me" }, lineLabels: { l1: { _id: "l1", key: "k", run_id: "b", node_id: "x", verdict: "wrong", by: "u2", at: now } } } as any);
const workspace = {
  rows: { signals, runs: [], tasks }, project: null, projects: [], now, graphKey: null, ready: true, heldFrom: null, problems: [],
  process: { task: () => "agentwatch", project: () => "agentwatch" },
} as any;

const selects: any[] = [];
let root: ReturnType<typeof createRoot>;
const host = document.createElement("div");
document.body.appendChild(host);
async function render(el: React.ReactElement) { await act(async () => { (root ??= createRoot(host)).render(el); }); }
const q = (s: string) => host.querySelector(s) as HTMLElement | null;
const page = (search: string) => React.createElement(FinderPage, { model: {} as any, workspace, selection: readLineSelection(new URLSearchParams(search)), select: (p: any, c?: any, o?: any) => selects.push({ ...p, ...o }), href: () => "#" });

test("the Find table names each finder with its source, its findings, how many reached no problem, and a judge's wrong rate from marks", async () => {
  await render(React.createElement(FindTable, { workspace, select: (p: any) => selects.push(p), href: () => "#" }));
  const rows = [...host.querySelectorAll<HTMLElement>("[data-line-finder]")];
  const comms = rows.find((r) => r.dataset.lineFinder === "agentwatch/comms")!;
  // A product's judge reads with its product, so two sources' "Comms" are never one name twice.
  expect(comms.querySelector("th")?.textContent).toBe("AgentWatch comms");
  expect([...comms.querySelectorAll("td")].map((c) => c.textContent)).toEqual(["3", "1", "33% (1 of 3)"]);
  const esc = rows.find((r) => r.dataset.lineFinder === "union.escalation")!;
  expect([...esc.querySelectorAll("td")].map((c) => c.textContent)).toEqual(["2", "1", "0"]);
  await act(async () => { comms.click(); });
  expect(selects.at(-1)).toMatchObject({ view: "line", source: "agentwatch/comms" });
});

test("a judge's page groups its findings, opens the newest filed one in place, and offers Judge is wrong", async () => {
  await render(page("view=line&source=agentwatch%2Fcomms"));
  expect([...host.querySelectorAll<HTMLElement>("[data-line-finder-group]")].map((g) => g.dataset.lineFinderGroup)).toEqual(["filed", "wrong", "unfiled"]);
  expect(q("[data-line-finder-wrong-rate]")?.textContent).toContain("33% (1 of 3)");
  expect(q("[data-line-finding-open]")).not.toBeNull();
  expect(q("[data-line-judge-wrong]")).not.toBeNull();
  expect(q("[data-line-finding-problem]")?.textContent).toContain("ct-57845");
  // Every group heading carries its count, the Find table's Not filed included.
  expect(q('[data-line-finder-group="unfiled"] .fp-h-n')?.textContent).toBe("1");
  // One figure per label: the filed count is its group's heading, the Find table's number; the head does not repeat it.
  expect(q('[data-line-finder-group="filed"] .fp-h-n')?.textContent).toBe("1");
  expect([...host.querySelectorAll(".fp-figures dt")].map((d) => d.textContent)).toEqual(["Findings this week", "Wrong rate"]);
});

test("Escalation's findings cannot be marked; one nothing filed leads with Open in Union, then Make this a problem", async () => {
  const made: string[] = [];
  useInboxStore.setState({ makeProblemOfFinding: async (id: string) => { made.push(id); return { task_id: "t9", task_short_id: "ct-60001", created: true }; } } as any);
  await render(page("view=line&source=union.escalation&finding=sg-e"));
  expect(q("[data-line-finder-wrong-rate]")).toBeNull();
  expect(q("[data-line-judge-wrong]")).toBeNull();
  const acts = [...host.querySelectorAll<HTMLElement>(".fr-acts > *")];
  expect(acts.map((a) => a.textContent)).toEqual(["Open the agent run in Union", "Make this a problem"]);
  await act(async () => { acts[1].click(); });
  expect(made).toEqual(["e"]);
  expect(q("[data-line-finding-made]")?.textContent).toBe("Filed to ct-60001");
});

test("a finder nobody filed under says so instead of a blank page", async () => {
  await render(page("view=line&source=nobody"));
  expect(q("[data-line-finder-missing]")?.dataset.lineFinderMissing).toBe("nobody");
});

test("a named finder is not called missing while the floor's findings are still loading", async () => {
  await render(React.createElement(FinderPage, { model: {} as any, workspace: { ...workspace, ready: false }, selection: readLineSelection(new URLSearchParams("view=line&source=nobody")), select: () => {}, href: () => "#" }));
  expect(q("[data-line-finder-missing]")).toBeNull();
  expect(q('[data-line-view="finder"][aria-busy]')).not.toBeNull();
});
