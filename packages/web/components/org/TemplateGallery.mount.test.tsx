import assert from "node:assert/strict";

import { closeDomWindow } from "../../test-helpers/domGlobals";

// The hire gallery (org-hire.md H3, org-staffing.md S6, S30): the built-in
// Head of People and Executive Assistant lead the grid ahead of every
// template, each hires through its own path when picked, the search finds
// them, and an empty catalog still offers them.
async function verifyGallery() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { TemplateGallery } = await import("./TemplateGallery");
  const { HEAD_OF_PEOPLE_HIRE, EXECUTIVE_ASSISTANT_HIRE } = await import("./templateCatalog");
  const manifest = { schemaVersion: 2, id: "growth", version: "2.0.0", name: "CMO", description: "d", role: { name: "CMO", handle: "x", charter: "c.md", caps: { hands_per_day: 1, wakes_per_day: 1, tokens_per_day: 1 } }, routines: [{ id: "weekly", title: "Weekly", every: "7d", prompt: "w.md" }] } as any;
  const template = { template_id: "growth", workspace: "codecast", name: "CMO", description: "One project CMO", latest: { version: "2.0.0", digest: "a".repeat(64) }, latest_status: "stable" as const, installable: true, asks: { inputs: 0, secrets: 0, authority: 0, setup: 0, routines: 1 }, manifest };
  const picked: string[] = [];
  const pickedBuiltin: string[] = [];
  const root = createRoot(document.getElementById("root")!);
  const render = (props: Partial<Parameters<typeof TemplateGallery>[0]>) => act(async () => root.render(<TemplateGallery templates={[template]} ready projectCount={1} onPick={(id) => picked.push(id)} builtins={[HEAD_OF_PEOPLE_HIRE, EXECUTIVE_ASSISTANT_HIRE]} onPickBuiltin={(id) => pickedBuiltin.push(id)} {...props} />));
  const cards = () => [...document.querySelectorAll<HTMLElement>("[data-template-card]")].map((el) => el.dataset.templateCard);

  await render({});
  assert.deepEqual(cards(), ["head-of-people", "executive-assistant", "growth"], "built-ins lead the grid");
  const hire = document.querySelector<HTMLButtonElement>("[data-builtin-hire='executive-assistant'] [data-template-card-hire]");
  assert.ok(hire, "the assistant card offers the hire");
  await act(async () => hire!.click());
  assert.deepEqual(pickedBuiltin, ["executive-assistant"]);
  assert.deepEqual(picked, [], "a built-in never reads as a template pick");

  // Once one stands the caller leaves it out, and the grid shows the rest.
  await render({ builtins: [HEAD_OF_PEOPLE_HIRE] });
  assert.deepEqual(cards(), ["head-of-people", "growth"]);

  // An empty catalog still offers the built-ins, with the catalog note under them.
  await render({ templates: [] });
  assert.deepEqual(cards(), ["head-of-people", "executive-assistant"]);
  assert.ok(document.querySelector("[data-template-gallery-empty]")?.textContent?.includes("No templates to hire yet"));

  // The search reaches them: four or more cards show the field.
  await render({ templates: [template, { ...template, template_id: "t2", name: "Two" }, { ...template, template_id: "t3", name: "Three" }] });
  const field = document.querySelector<HTMLInputElement>("input[placeholder='Find a role']");
  assert.ok(field, "the search field shows with four cards");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field!, "right hand");
    field!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.deepEqual(cards(), ["executive-assistant"], "the search finds a built-in by its description");

  await act(async () => root.unmount());
  closeDomWindow(dom.window);
}

await verifyGallery();
