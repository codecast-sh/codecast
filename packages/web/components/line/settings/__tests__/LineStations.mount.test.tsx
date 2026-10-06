// Mounts the Stations section of /line/settings in jsdom (plan pl-838): it
// offers to customize only once the server said the project has no copy
// (never while that is unknown), the fork goes as a create, the headline says
// whether any role runs the copy, a station says "saved" only after a save
// from its own panel, and stopping moves the roles back before the copy goes.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/line/settings?project=pr-1", pretendToBeVisual: true });
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
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import("react-dom/client");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

// What the by-slug feeder says: undefined (not yet), null (none), or the row.
let fork: any = undefined;
let roles: any[] = [];
mock.module("../../../../hooks/useSyncWorkflows", () => ({
  useWorkflowBySlug: () => fork,
  useWorkflows: () => ({ workflows: fork ? [fork] : [], ready: true }),
}));
mock.module("../../../../hooks/useSyncOrgTree", () => ({ useSyncOrgTree: () => ({ tree: { roles } }) }));
mock.module("../../../WorkflowGraphView", () => ({
  WorkflowGraphView: ({ nodes, onNodeSelect }: any) => React.createElement("div", { "data-graph": nodes.length },
    nodes.map((n: any) => React.createElement("button", { key: n.id, "data-node": n.id, onClick: () => onNodeSelect(n) }, n.label))),
}));
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));

const { useInboxStore } = await import("../../../../store/inboxStore");
const { SHIPPED_LINE } = await import("../../../../lib/line/shippedLine.generated");
const { forkShippedLine } = await import("../../../../lib/line/lineStations");
const { LineStations } = await import("../LineStations");

const ME = "u1";
const project = { _id: "p1", short_id: "pr-1", title: "Codecast" };
const SLUG = "line-pr-1";
const role = (over: Record<string, unknown> = {}) => ({ _id: "r1", short_id: "rl-1", name: "Builder", handle: "builder", status: "active", host_user_id: ME, scope: { project_ids: ["p1"] }, ...over });

let calls: Array<[string, unknown[]]> = [];
beforeEach(() => {
  calls = [];
  fork = undefined;
  roles = [];
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Me" },
    projects: { p1: project },
    saveLineWorkflow: (...a: unknown[]) => { calls.push(["saveLineWorkflow", a]); },
    removeLineWorkflow: (...a: unknown[]) => { calls.push(["removeLineWorkflow", a]); },
    setRoleLine: (...a: unknown[]) => { calls.push(["setRoleLine", a]); },
  } as any);
});

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = async () => { await act(async () => { root.render(React.createElement(LineStations, { projectId: "p1" })); }); };
  await render();
  return { host, render, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}
const headline = (host: HTMLElement) => host.querySelector("[data-line-stations-headline]")!.textContent;

test("no Customize while the server has not said; once it says none, Customize sends a create", async () => {
  const m = await mount();
  expect(headline(m.host)).toMatch(/Looking for/);
  expect(m.host.querySelector("[data-customize-line]")).toBeNull();

  fork = null;
  await m.render();
  expect(headline(m.host)).toBe("This project runs the shipped line.");
  expect(m.host.textContent).toMatch(/roles keep the shipped line until you switch them/);
  await act(async () => { m.host.querySelector<HTMLButtonElement>("[data-customize-line]")!.click(); });
  expect(calls).toHaveLength(1);
  const [action, [wf, opts]] = calls[0] as [string, [any, any]];
  expect(action).toBe("saveLineWorkflow");
  expect(wf.slug).toBe(SLUG);
  expect(opts).toEqual({ create: true });
  await m.unmount();
});

test("a copy no role runs says so; a role on it is counted; saved is said only after a save", async () => {
  fork = { _id: "w1", ...forkShippedLine(SHIPPED_LINE, project) };
  roles = [role()];
  const m = await mount();
  expect(m.host.querySelector("[data-customize-line]")).toBeNull();
  expect(headline(m.host)).toBe(`Your customized copy, ${SLUG}. No role runs it yet.`);

  // Open a station: before any edit it shows how to edit, never "saved".
  await act(async () => { m.host.querySelector<HTMLButtonElement>('[data-node="ground"]')!.click(); });
  const state = () => m.host.querySelector("[data-station-save-state]")!.textContent!;
  expect(state()).toMatch(/^Edit the prompt/);
  const area = m.host.querySelector<HTMLTextAreaElement>("[data-station-text]")!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
    set.call(area, "Mine.");
    area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => { area.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })); });
  expect(calls.at(-1)?.[0]).toBe("saveLineWorkflow");
  // The store paints the saved graph (saveLineWorkflow); the panel follows it.
  fork = { ...fork, nodes: (calls.at(-1)![1][0] as any).nodes };
  await m.render();
  expect(state()).toBe("Saved to the copy. No role runs it yet, so no run reads it.");

  roles = [role({ line_workflow_slug: SLUG })];
  await m.render();
  expect(headline(m.host)).toBe(`1 role runs this project's customized copy, ${SLUG}.`);
  await m.unmount();
});

test("stop customizing asks once, moves the roles on the copy back, then removes it", async () => {
  fork = { _id: "w1", ...forkShippedLine(SHIPPED_LINE, project) };
  roles = [role({ line_workflow_slug: SLUG }), role({ _id: "r2", host_user_id: "someone-else", line_workflow_slug: SLUG })];
  const m = await mount();
  const byText = (t: string) => [...m.host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === t)!;
  await act(async () => { byText("Stop customizing").click(); });
  expect(calls).toHaveLength(0);
  const armed = byText("Delete the copy and move 1 role back");
  expect(armed).toBeDefined();
  await act(async () => { armed.click(); });
  // The teammate's role runs their own copy of the slug; only the viewer's moves.
  expect(calls).toEqual([["setRoleLine", ["r1", "line"]], ["removeLineWorkflow", [SLUG]]]);
  await m.unmount();
});

test("with no role on the project, the empty state points to where a role's area is set", async () => {
  fork = null;
  const m = await mount();
  const empty = m.host.querySelector("[data-runs-this-line-empty]")!;
  expect(empty.querySelector("a")!.getAttribute("href")).toBe("/org");
  await m.unmount();
});

// line-map.md LX5: a project whose profile a machine published keeps its line
// in its repo; the workflow copy is not offered, and an edit is a station op
// on the profile's edit path, painted at once.
test("a published project edits its repo's line through the profile's edit path", async () => {
  fork = null;
  const sent: any[] = [];
  const published = {
    root: "/src/app", device_id: "dev-1", publisher_user_id: ME, default: true, finders: [], changed_at: 1, published_at: 1,
    commands: { check: "cast ws check", prove: null, eval: null, ship: null }, sources: {}, notes: [], warnings: [], file: ".codecast/line.toml",
  };
  useInboxStore.setState({
    projects: { p1: { ...project, line_profile: published } },
    sessionCommands: {},
    editLineProfile: (requestId: string, projectId: string, edits: unknown[]) => {
      sent.push(edits);
      useInboxStore.setState((s: any) => ({ sessionCommands: { ...s.sessionCommands, [requestId]: { _id: requestId, kind: "line_edit", project_id: projectId, edits, keys: (edits as any[]).map((e) => `stations.${e.station}`), requested_at: Date.now(), executed_at: null, result: null, error: null } } }));
      return Promise.resolve({ command_id: "c1" });
    },
  } as any);
  const m = await mount();
  expect(m.host.querySelector("[data-line-stations]")!.getAttribute("data-line-home")).toBe("repo");
  expect(headline(m.host)).toBe("This project's repo has no line of its own yet, so its runs use their role's line or the shipped one.");
  expect(m.host.querySelector("[data-customize-line]")).toBeNull();

  await act(async () => { m.host.querySelector<HTMLButtonElement>("[data-node='prove']")!.click(); });
  const timeout = m.host.querySelector<HTMLInputElement>("[data-station-timeout]")!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    set.call(timeout, "10");
    timeout.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => { timeout.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })); });
  expect(sent).toEqual([[{ op: "set_station", station: "prove", timeout: 600 }]]);
  expect(calls).toHaveLength(0);
  // Painted ahead of the machine: the station reads as changed from shipped.
  expect(m.host.textContent).toMatch(/edited: timeout/);

  // Once the republish carries the repo's line, the header names its version.
  useInboxStore.setState({ projects: { p1: { ...project, line_profile: { ...published, published_at: 2, line: { file: ".codecast/line/line.cast", graph_hash: "abcdef0123456789", name: "line", source: "", nodes: SHIPPED_LINE.nodes, edges: SHIPPED_LINE.edges, files: {} } } } } as any);
  await m.render();
  expect(headline(m.host)).toBe("This project's line lives in its repo, in .codecast/line, at version abcdef01.");
  await m.unmount();
});
