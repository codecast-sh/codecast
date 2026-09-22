import assert from "node:assert/strict";

import { closeDomWindow } from "../../test-helpers/domGlobals";

// The role page's template sections (org-hire.md H5 to H8, H11), rendered from
// one mocked instance: the one open ask first, Done on a person's item only,
// what the role may do, routines with what each still needs and Activate on
// the ready paused one only, the scoreboard, the release with its bindings.
async function verifyTemplateSections() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const marked: any[] = []; const activated: string[] = [];
  const now = Date.now();
  const instance = {
    _id: "inst-1", instance_key: "key-1", instance: "acme-growth", template_id: "growth", version: "2.0.0", digest: "6e0c187bacdef8543bba951bbad6cca098545a45be99ef6e47bc3e9b302e5e01", phase: "ready", host: { machine: "mbp", dir: "/src/acme" },
    trust: "understand", handle: "acme-growth-cmo",
    authority: [{ id: "site-write", kind: "write", label: "Ship pages", granted_at: now }, { id: "old", kind: "publish", label: "Expired", granted_at: now, expires_at: now - 1 }],
    setup: [{ id: "search-console", title: "Verify the domain", who: "human", status: "open", unlocks: ["seo-weekly"], price: "unlocks SEO weekly" }, { id: "measurement", title: "See one event", who: "role", status: "open", unlocks: [] }, { id: "bing", title: "Verify in Bing", who: "human", status: "done", unlocks: [] }],
    ask: { id: "search-console", title: "Verify the domain", unlocks: ["seo-weekly"] },
    readiness: { "cmo-weekly": { ready: true, mode: "propose", missing: [] }, "seo-weekly": { ready: false, mode: "propose", missing: ["evidence technical has no pass"] }, "ads-daily": { ready: true, mode: "propose", missing: ["runs as propose: trust is understand"] } },
    routines: [
      { id: "cmo-weekly", title: "CMO weekly", every: "7d", mode: "propose", trigger: { id: "tasks_1", short_id: "tr-1", status: "paused" } },
      { id: "seo-weekly", title: "SEO weekly", every: "7d", mode: "apply", trigger: { id: "tasks_2", short_id: "tr-2", status: "paused" } },
      { id: "ads-daily", title: "Ads daily", every: "1d", mode: "apply", trigger: { id: "tasks_3", short_id: "tr-3", status: "scheduled" } },
    ],
    scoreboard: [{ key: "primary_events_7d", label: "Primary events", value: "7", observed_at: now - 3_600_000, source: "ct-1" }, { key: "cost", label: "Cost per event" }],
    secrets: [{ key: "accounts.ads", label: "Google Ads credentials", bound: false }, { key: "accounts.publora", label: "Publora key", bound: true }],
    template: { name: "CMO", latest_stable: "2.1.0" }, update_available: "2.1.0",
  };
  mock.module("../../hooks/useTemplateHire", () => ({
    useTemplateInstance: () => ({ instance, ready: true }),
    useTemplateCatalog: () => ({ templates: [], ready: true }),
    useTemplateActions: () => ({ propose: async () => ({}), markSetup: async (key: string, id: string, status: string) => { marked.push([key, id, status]); }, activate: async (id: string) => { activated.push(id); } }),
  }));
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { TemplateSections } = await import("./TemplateSections");
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<TemplateSections roleId="role-1" canEdit />));
  const text = document.body.textContent!;
  assert.match(text, /Waiting on you: Verify the domain \(unlocks seo-weekly\)/);
  assert.match(text, /Authority outside codecast: write \(Ship pages\)/);
  assert.doesNotMatch(text, /Expired/);
  assert.match(text, /Update available: 2\.1\.0/);
  assert.match(text, /Google Ads credentials: missing/);
  assert.match(text, /Publora key: bound/);
  assert.match(text, /Primary events7/);
  const states = [...document.querySelectorAll<HTMLElement>("[data-template-routine]")].map((el) => [el.dataset.templateRoutine, el.dataset.state]);
  assert.deepEqual(states, [["cmo-weekly", "paused, ready"], ["seo-weekly", "paused, not ready"], ["ads-daily", "active"]]);
  const buttons = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === label);
  // Done only on the person's open item; Activate only on the ready paused routine.
  assert.equal(buttons("Done").length, 1);
  assert.equal(buttons("Activate").length, 1);
  await act(async () => buttons("Done")[0]!.click());
  assert.deepEqual(marked, [["key-1", "search-console", "done"]]);
  await act(async () => buttons("Activate")[0]!.click());
  assert.deepEqual(activated, ["tasks_1"]);
  await act(async () => root.unmount());
  closeDomWindow(dom);
  console.log("template sections mount: passed");
}

if (import.meta.main) await verifyTemplateSections();
