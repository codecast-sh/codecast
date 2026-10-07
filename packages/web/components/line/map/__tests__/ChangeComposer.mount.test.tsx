// The Change slot of a map panel (line-map.md LX6), mounted in jsdom: the
// person's words file a cause against the node through the store (category
// line, the node as subject), the cause paints at once and links to its trace
// once it has a ref, "Start now" starts the line on it, and a refusal takes
// the painted cause back and says why.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/line?node=prove", pretendToBeVisual: true });
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
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));

const { useInboxStore } = await import("../../../../store/inboxStore");
const { DispatchNotWiredError } = await import("../../../../store/mutativeMiddleware");
const { ChangeComposer } = await import("../ChangeComposer");

// The project's workspace: the composer reads its signals there.
const WS = "team:t1";
const NODE = { id: "prove", kind: "station" as const, label: "Prove" };
let filed: any[] = [];
let started: string[] = [];
let refuse = false;

beforeEach(() => {
  filed = [];
  started = [];
  refuse = false;
  useInboxStore.setState({
    projects: { p1: { _id: "p1", short_id: "pj-1", title: "Web", workspace: WS } },
    tasks: {},
    signals: {},
    fileLineCause: (key: string, projectId: string, fields: any) => {
      filed.push({ key, projectId, fields });
      useInboxStore.setState((s: any) => ({ tasks: { ...s.tasks, [`temp_task_${key}`]: { _id: `temp_task_${key}`, client_key: key, short_id: "ct-…", title: fields.title, status: "open", project_id: projectId, category: "line" } } }));
      return refuse ? Promise.reject(new DispatchNotWiredError("fileLineCause")) : Promise.resolve({ task_id: "t1", task_short_id: "ct-9" });
    },
    removeTaskStub: (key: string) => useInboxStore.setState((s: any) => { const tasks = { ...s.tasks }; delete tasks[`temp_task_${key}`]; return { tasks }; }),
    startLineCause: (taskId: string) => { started.push(taskId); return Promise.resolve({ run_id: "r1", role_handle: "growth" }); },
  } as any);
});

async function mount(projectId: string | null = "p1") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(ChangeComposer, { node: NODE, projectId })); });
  return { host, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}

async function type(host: HTMLElement, text: string) {
  const area = host.querySelector<HTMLTextAreaElement>("[data-change-words]")!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
    set.call(area, text);
    area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

test("files a cause against the node, paints it at once, then links it to its trace and offers Start now", async () => {
  const m = await mount();
  const submit = m.host.querySelector<HTMLButtonElement>("[data-change-submit]")!;
  expect(submit.disabled).toBe(true);
  await type(m.host, "Prove picks moments from last month.\nIt should pick this week's.");
  expect(submit.disabled).toBe(false);
  await act(async () => { submit.click(); });

  expect(filed).toHaveLength(1);
  expect(filed[0].projectId).toBe("p1");
  expect(filed[0].fields).toEqual({ subject: "line:station:prove", title: "Prove picks moments from last month.", detail_md: "Prove picks moments from last month.\nIt should pick this week's." });
  expect(m.host.querySelector<HTMLTextAreaElement>("[data-change-words]")!.value).toBe("");
  const row = () => m.host.querySelector("[data-change-cause]")!;
  expect(row().getAttribute("data-status")).toBe("filing");
  expect(row().querySelector("[data-change-start]")).toBeNull();

  // The server row supersedes the stub (same client key): a ref, a trace link, Start now.
  const key = filed[0].key;
  await act(async () => { useInboxStore.setState({ tasks: { t1: { _id: "t1", client_key: key, short_id: "ct-9", title: "Prove picks moments from last month.", status: "open", project_id: "p1", category: "line" } } } as any); });
  expect(row().querySelector("[data-change-trace]")!.getAttribute("href")).toBe("/line/trace/ct-9");
  await act(async () => { row().querySelector<HTMLButtonElement>("[data-change-start]")!.click(); });
  expect(started).toEqual(["t1"]);

  // Once its run holds it, the cause reads as on the line and Start now goes.
  await act(async () => { useInboxStore.setState({ tasks: { t1: { _id: "t1", client_key: key, short_id: "ct-9", title: "x", status: "in_progress", workflow_run_id: "r1", project_id: "p1" } } } as any); });
  expect(row().getAttribute("data-status")).toBe("in_progress");
  expect(row().querySelector("[data-change-start]")).toBeNull();
  await m.unmount();
});

test("open causes already filed on the node show from the store's signals", async () => {
  useInboxStore.setState({
    tasks: { t5: { _id: "t5", short_id: "ct-5", title: "Prove reads too few moments", status: "open", project_id: "p1" }, t6: { _id: "t6", short_id: "ct-6", title: "Closed one", status: "done", project_id: "p1" }, t7: { _id: "t7", short_id: "ct-7", title: "Elsewhere", status: "open" } },
    signals: {
      s1: { _id: "s1", subject: "line:station:prove", task_id: "t5", workspace: WS },
      s2: { _id: "s2", subject: "line:station:prove", task_id: "t6", workspace: WS },
      s3: { _id: "s3", subject: "line:station:red", task_id: "t5", workspace: WS },
      // Another workspace's signal on the same subject is not this project's.
      s4: { _id: "s4", subject: "line:station:prove", task_id: "t7", workspace: "team:other" },
    },
  } as any);
  const m = await mount();
  const rows = [...m.host.querySelectorAll("[data-change-cause]")];
  expect(rows.map((r) => r.getAttribute("data-change-cause"))).toEqual(["ct-5"]);
  await m.unmount();
});

test("a refusal takes the painted cause back and says why", async () => {
  refuse = true;
  const m = await mount();
  await type(m.host, "Drop the red station.");
  await act(async () => { m.host.querySelector<HTMLButtonElement>("[data-change-submit]")!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(m.host.querySelector("[data-change-cause]")).toBeNull();
  expect(m.host.querySelector("[data-change-error]")).not.toBeNull();
  expect(Object.keys((useInboxStore.getState() as any).tasks)).toEqual([]);
  await m.unmount();
});

test("with no project there is nothing to file into", async () => {
  const m = await mount(null);
  expect(m.host.querySelector<HTMLTextAreaElement>("[data-change-words]")!.disabled).toBe(true);
  expect(m.host.querySelector<HTMLButtonElement>("[data-change-submit]")!.disabled).toBe(true);
  await m.unmount();
});
