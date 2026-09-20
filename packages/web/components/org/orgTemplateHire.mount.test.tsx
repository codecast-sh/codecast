import assert from "node:assert/strict";

import { closeDomWindow } from "../../test-helpers/domGlobals";
async function verifyHireFlow() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { copied.push(text); } } });
  const { mock } = await import("bun:test");
  const project = { _id: "project-1", title: "Product", workspace: "team:fixture-team", status: "active", task_counts: { total: 0, done: 0, in_progress: 0 }, plan_count: 0, doc_count: 0, active_plan_count: 0, created_at: 1, updated_at: 1 };
  mock.module("../../hooks/useWorkspaceCollection", () => ({ useWorkspaceCollection: (key: string) => key === "projects" ? [project] : [] }));
  mock.module("../../hooks/useScopeQueries", () => ({ useScopeSummary: () => ({ data: undefined }) }));
  // The form's other server read: what the new role would take over (R1).
  mock.module("../../hooks/useTakeoverPreviews", () => ({ useTakeoverPreviews: () => ({ byKey: {}, ready: true }) }));
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { HireRoleDialog } = await import("./HireRoleDialog");
  const { ORG_FIXTURE } = await import("./orgFixture");
  const created: any[] = [];
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<HireRoleDialog open onClose={() => {}} tree={ORG_FIXTURE} meId="fixture-user-me" initialProjects={[project]} projectPath="/src/product" onCreate={(input) => created.push(input)} />));
  const button = (text: string) => {
    const el = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === text);
    assert.ok(el, `Missing button "${text}". Rendered dialog: ${document.querySelector('[role="dialog"]')?.textContent ?? document.body.innerHTML}`);
    return el;
  };
  button("From a folder");
  const change = async (selector: string, value: string) => {
    const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    assert.ok(el, selector);
    await act(async () => {
      Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await change('input[placeholder="Head of Growth"]', "Growth lead");
  await change("textarea", "Keep my custom charter exactly.");
  await change('input[type="number"]', "8");
  await act(async () => button("From a folder").click());
  assert.equal(button("Copy command").disabled, true);
  await change('input[placeholder="/path/to/templates/growth"]', "/src/templates/growth");
  await change('input[name="template-instance"]', "product-growth");
  assert.equal(button("Copy command").disabled, false);
  assert.match(document.body.textContent!, /Understand trust with routines paused/);
  assert.match(document.body.textContent!, /Spending and publishing need separate authorization/);
  await act(async () => button("Copy command").click());
  assert.equal(copied.length, 1);
  assert.match(copied[0], /--project 'project-1'.*--team 'fixture-team'/);
  assert.equal(created.length, 0);
  await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(created.length, 0);
  await act(async () => button("Write a role").click());
  assert.equal(document.querySelector("textarea")!.value, "Keep my custom charter exactly.");
  assert.equal(document.querySelector<HTMLInputElement>('input[placeholder="Head of Growth"]')!.value, "Growth lead");
  assert.equal(button("Create and start").disabled, false);
  await act(async () => button("Create and start").click());
  assert.equal(created.length, 1);
  assert.equal(created[0].charter, "Keep my custom charter exactly.");
  assert.equal(created[0].caps.hands_per_day, 8);
  assert.equal(created[0].handle, "growth-lead");
  assert.equal(created[0].project_path, "/src/product");
  assert.equal(created[0].provision, true);
  assert.equal(created[0].trust_stage, undefined);
  assert.deepEqual(created[0].scope, { project_ids: ["project-1"], plan_ids: [] });
  await act(async () => button("From a folder").click());
  assert.equal(document.querySelector<HTMLInputElement>('input[placeholder="/path/to/templates/growth"]')!.value, "/src/templates/growth");
  assert.equal(document.querySelector<HTMLInputElement>('input[name="template-instance"]')!.value, "product-growth");
  await act(async () => root.unmount());
  closeDomWindow(dom);
  console.log("org template hire mount: passed");
}

if (import.meta.main) await verifyHireFlow();
