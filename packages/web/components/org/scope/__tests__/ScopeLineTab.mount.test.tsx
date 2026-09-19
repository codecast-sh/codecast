// Mounts the Line tab in jsdom (docs/architecture/the-line.md L10) with two
// tasks at different stations: one column per station in order, each task in
// its column with its run's live node and hand state, a held marker on the
// task a pending blocking decision holds, and the evidence count. The hold
// and run rules are lib/taskLine.ts, the same the task page strip uses.
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";

import { closeDomWindow } from "../../../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/org/or-1?tab=line", pretendToBeVisual: true });
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
// react-dom/client decides at load whether a DOM exists, so it is loaded
// here — after the globals above — not as a static import.
const {createRoot} = await import("react-dom/client");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

// The feeders are live Convex subscriptions; the tab paints from the store,
// so the generic feeder is a no-op here and the store is seeded directly.
mock.module("../../../../hooks/useSyncCollection", () => ({ useSyncCollection: () => ({ ready: true }), keyRowsBy: (rows: any[]) => rows ?? [] }));
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
mock.module("../../../tasks/TaskCommentStream", () => ({ Avatar: ({ name }: { name: string }) => React.createElement("span", { "data-avatar": name }) }));

const { useInboxStore } = await import("../../../../store/inboxStore");
const { ScopeLineTab } = await import("../ScopeLineTab");

const ME = "u1";
const WS = `user:${ME}`;
beforeAll(() => {
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Me" },
    clientStateInitialized: true,
    clientState: { ...(useInboxStore.getState() as any).clientState, ui: {} },
    teams: [],
    teamMembers: [{ _id: "u2", name: "Sam Reviewer" }],
    sessions: {
      hand1: { _id: "hand1", agent_status: "working", is_connected: true, is_idle: false, updated_at: Date.now() },
    },
    tasks: {
      ta: { _id: "ta", short_id: "ct-1", title: "Rotate the prod key", status: "in_progress", workspace: WS, project_id: "p1", assignee: "u2", workflow_run_id: "r1", files_changed: ["a.ts", "b.ts"], updated_at: 2, created_at: 1 },
      tb: { _id: "tb", short_id: "ct-2", title: "Write the release note", status: "in_review", workspace: WS, project_id: "p1", updated_at: 3, created_at: 1 },
      tc: { _id: "tc", short_id: "ct-3", title: "Out of scope", status: "open", workspace: WS, project_id: "p9", updated_at: 1, created_at: 1 },
    },
    workflowRuns: {
      r1: { _id: "r1", task_id: "ta", status: "running", workspace: WS, current_node_id: "implement", current_node_label: "Implement", primary_conversation_id: "hand1", created_at: 1, updated_at: 2 },
    },
    sessionDecisions: {
      d1: { _id: "d1", short_id: "sd-9", status: "pending", blocking: true, task_id: "tb", station: "in_review", question: "Ship it?", options: [], conversation_id: "x", session_id: "x", created_at: 1 },
    },
  } as any);
});

const root = createRoot(document.getElementById("root")!);

test("two tasks at different stations paint in their columns with node, hand state, hold and evidence", async () => {
  await act(async () => root.render(React.createElement(ScopeLineTab, { ids: { projectIds: ["p1"], planIds: [], whole: false } })));
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];

  // Every default station, in pipeline order.
  expect(qa("[data-line-column]").map((c) => c.getAttribute("data-line-column"))).toEqual(["backlog", "open", "in_progress", "in_review", "done", "dropped"]);
  // Only the two tasks in scope, each in its own column.
  expect(qa("[data-line-card]").map((c) => c.getAttribute("data-line-card"))).toEqual(["ct-1", "ct-2"]);
  expect(qa('[data-line-column="in_progress"] [data-line-card]').map((c) => c.getAttribute("data-line-card"))).toEqual(["ct-1"]);
  expect(qa('[data-line-column="in_review"] [data-line-card]').map((c) => c.getAttribute("data-line-card"))).toEqual(["ct-2"]);
  expect(qa('[data-line-column="open"] [data-line-card]')).toEqual([]);
  expect(document.querySelector('[data-line-column="open"]')!.textContent).toMatch(/Nothing at this station/);

  // ct-1: its run's live node with the hand's state, the assignee, the evidence count.
  const a = document.querySelector('[data-line-card="ct-1"]')!;
  expect(a.querySelector("[data-line-node]")!.textContent).toMatch(/Implement/);
  expect(a.querySelector("[data-line-node]")!.textContent).toMatch(/working/);
  expect(a.querySelector("[data-avatar]")!.getAttribute("data-avatar")).toBe("Sam Reviewer");
  // Pages join the count once artifacts.listForWeb carries task_id; today
  // the card counts the handoff's files.
  expect(a.textContent).toMatch(/2 files/);
  expect(a.textContent).not.toMatch(/page/);
  expect(a.querySelector("[data-line-held]")).toBeNull();
  expect(a.querySelector("a")!.getAttribute("href")).toBe("/tasks/ct-1");

  // ct-2: held at in_review by sd-9, linking the decision; no run, no node.
  const b = document.querySelector('[data-line-card="ct-2"]')!;
  const held = b.querySelector("[data-line-held]")!;
  expect(held.textContent).toMatch(/held · sd-9/);
  expect(held.getAttribute("href")).toBe("/decisions/sd-9");
  expect(b.querySelector("[data-line-node]")).toBeNull();
});

test("an empty scope says so instead of drawing columns", async () => {
  await act(async () => root.render(React.createElement(ScopeLineTab, { ids: { projectIds: ["none"], planIds: [], whole: false } })));
  expect(document.body.textContent).toMatch(/No tasks on the line/);
  expect(document.querySelector("[data-line-column]")).toBeNull();
  await act(async () => root.unmount());
});
