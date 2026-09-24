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
  // The template reads and writes (org-hire.md H3): one catalog entry, and a post that records the spec.
  const proposed: any[] = [];
  const manifest = { schemaVersion: 2, id: "growth", version: "2.0.0", name: "CMO", description: "One project CMO", role: { name: "CMO", handle: "{{instance}}-cmo", charter: "c.md", caps: { hands_per_day: 4, wakes_per_day: 12, tokens_per_day: 200000 } }, inputs: [{ key: "product.domain", label: "Apex domain", kind: "string", required: true }, { key: "accounts.ads", label: "Ads credentials", kind: "secret" }], authority: [{ id: "site-write", kind: "write", label: "Ship pages" }], setup: [{ id: "sc", title: "Verify the domain", who: "human" }], routines: [{ id: "weekly", title: "Weekly", every: "7d", prompt: "w.md" }] };
  mock.module("../../hooks/useTemplateHire", () => ({
    useTemplateCatalog: () => ({ templates: [{ template_id: "growth", workspace: "codecast", name: "CMO", description: "One project CMO", latest: { version: "2.0.0", digest: "a".repeat(64) }, asks: { inputs: 2, secrets: 1, authority: 1, setup: 1, routines: 1 }, manifest }], ready: true }),
    useTemplateInstance: () => ({ instance: null, ready: true }),
    useTemplateActions: () => ({ propose: async (spec: any) => { proposed.push(spec); return { short_id: "op-9", link: "/org?proposal=op-9" }; }, markSetup: async () => {}, activate: async () => {} }),
  }));
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
  button("From a template");
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
  await act(async () => button("From a template").click());
  // The folder path for authors stays behind its fold: a command, copied, never run.
  assert.equal(button("Copy command").disabled, true);
  await change('input[placeholder="/path/to/templates/growth"]', "/src/templates/growth");
  await change('input[name="folder-instance"]', "product-growth");
  assert.equal(button("Copy command").disabled, false);
  assert.match(document.body.textContent!, /creates the role with its routines paused/);
  assert.match(document.body.textContent!, /Spending and publishing need separate authorization/);
  await act(async () => button("Copy command").click());
  assert.equal(copied.length, 1);
  assert.match(copied[0], /--project 'project-1'.*--team 'fixture-team'/);
  assert.equal(created.length, 0);
  // The catalog form: choose the template, answer its input, and the preview names the one proposal.
  const select = async (selector: string, value: string) => {
    const el = document.querySelector<HTMLSelectElement>(selector)!;
    assert.ok(el, selector);
    await act(async () => { el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); });
  };
  const selects = () => [...document.querySelectorAll<HTMLSelectElement>("[data-template-form] select")];
  assert.equal(button("Propose the hire").disabled, true);
  await select(`[data-template-form] select:nth-of-type(1)`, "growth");
  await act(async () => { const s = selects()[0]; s.value = "growth"; s.dispatchEvent(new Event("change", { bubbles: true })); });
  assert.match(document.body.textContent!, /Bound on the host, never typed here/);
  assert.match(document.body.textContent!, /Ads credentials/);
  await change('input[name="input:product.domain"]', "product.example");
  assert.equal(document.querySelector<HTMLInputElement>('input[name="template-instance"]')!.value, "product-growth");
  assert.match(document.body.textContent!, /A new role CMO @product-growth-cmo, reporting to me, that starts work on its own/);
  assert.match(document.body.textContent!, /Authority outside codecast: write \(Ship pages\)/);
  assert.equal(button("Propose the hire").disabled, false);
  await act(async () => document.querySelector("[data-template-form]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(created.length, 0, "a template hire never calls the manual create");
  assert.equal(proposed.length, 1);
  assert.deepEqual(proposed[0].changes.map((c: any) => c.kind), ["role", "authority", "hire"]);
  assert.equal(proposed[0].team_id, "fixture-team");
  assert.match(document.body.textContent!, /Proposed\. Nothing has changed yet\./);
  assert.match(document.body.textContent!, /cast org template bind product-growth/);
  assert.ok(document.querySelector("[data-template-posted='op-9']"));
  await act(async () => button("Write a role").click());
  assert.equal(document.querySelector("textarea")!.value, "Keep my custom charter exactly.");
  assert.equal(document.querySelector<HTMLInputElement>('input[placeholder="Head of Growth"]')!.value, "Growth lead");
  assert.equal(button("Create and start").disabled, false);
  await act(async () => button("Create and start").click());
  assert.equal(created.length, 1);
  assert.equal(created[0].charter, "Keep my custom charter exactly.");
  assert.equal(created[0].caps, undefined);
  assert.equal(created[0].handle, "growth-lead");
  assert.equal(created[0].project_path, "/src/product");
  assert.equal(created[0].provision, true);
  assert.equal(created[0].trust_stage, undefined);
  assert.deepEqual(created[0].scope, { project_ids: ["project-1"], plan_ids: [] });
  await act(async () => button("From a template").click());
  // Back on the template tab, the posted state stands: the hire was proposed once and is not offered again.
  assert.ok(document.querySelector("[data-template-posted='op-9']"));
  assert.equal(document.querySelector("[data-template-form]"), null);
  await act(async () => root.unmount());
  closeDomWindow(dom);
  console.log("org template hire mount: passed");
}

if (import.meta.main) await verifyHireFlow();
