import assert from "node:assert/strict";
import { afterAll, describe, it, mock } from "bun:test";
import type { OrgUndoPreview } from "@codecast/shared/contracts/orgChange";
import { orgLogFixture } from "./orgLogFixture";
import { mockInboxStore } from "../../__tests__/mockInboxStore";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
const keys = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "Event", "getComputedStyle"];
const prior = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of keys) Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act } = React;
const now = new Date(2026, 8, 20, 15).getTime();
const fixture = orgLogFixture(now);
let entries = fixture.entries;
let ready = false;
let preview: OrgUndoPreview | null | undefined = fixture.previews["b-ask"];
const writes: unknown[] = [];
mock.module("../../../hooks/useCoarseNow", () => ({ useCoarseNow: () => now }));
mock.module("../../../hooks/useWorkspaceCollection", () => ({ useWorkspaceCollection: () => entries }));
mock.module("../../../hooks/useCollectionRows", () => ({ useCollectionRows: (_key: string, opts: { where: (row: unknown) => boolean }) => Object.values(fixture.rows).flat().filter(opts.where) }));
mock.module("../../../hooks/useSyncOrgLog", () => ({
  useSyncOrgLog: () => ({ ready, missing: false }),
  useSyncOrgLogEntry: () => ({ ready: false }),
  useOrgUndoPreview: () => ({ preview }),
}));
mockInboxStore(() => ({
  undoOrgChange: (...args: unknown[]) => writes.push(["undo", ...args]),
  redoOrgChange: (...args: unknown[]) => writes.push(["redo", ...args]),
}));
const { createRoot } = await import("react-dom/client");
const { OrgHistory, OrgHistoryPreview } = await import("./OrgHistory");
let root = createRoot(document.getElementById("root")!);
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const click = async (selector: string) => { await act(async () => q<HTMLButtonElement>(selector)!.click()); };
const mount = async (node: React.ReactNode) => {
  await act(async () => root.unmount());
  root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(node as never));
};
afterAll(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  mock.restore();
  for (const [key, descriptor] of prior) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
  }
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

describe("Org History", () => {
  it("paints the cached entries before the feeder is ready, grouped newest first", async () => {
    await mount(<OrgHistory />);
    assert.equal(q("[data-org-history-skeleton]"), null);
    assert.equal(q("[data-org-history-day]")!.getAttribute("data-org-history-day"), "Today");
    assert.equal(q("[data-org-history-entry]")!.getAttribute("data-org-history-entry"), "b-ask");
    assert.match(q("[data-org-history-line]")!.textContent!, /100 records/);
    assert.match(q("[data-org-history-meta]")!.textContent!, /Ashot Petrosian.*proposal op-7/);
    assert.equal(q('[data-org-history-entry="b-lead"] [data-org-history-act]'), null);
  });

  it("unfolds the rows, then the full hundred, without waiting for the feeder", async () => {
    await mount(<OrgHistory />);
    await click('[data-org-history-entry="b-ask"] [data-org-history-fold]');
    assert.equal(document.querySelectorAll("[data-org-history-row]").length, 12);
    await click("[data-org-history-rows-all]");
    assert.equal(document.querySelectorAll("[data-org-history-row]").length, 100);
    await click('[data-org-history-entry="b-ask"] [data-org-history-fold]');
    assert.equal(q("[data-org-history-rows]"), null);
  });

  it("says all four parts before confirmation and passes dependent batches to the action", async () => {
    preview = { ...fixture.previews["b-ask"], depends: [entries[1]], cannot_take_back: [{ kind: "message_sent", count: 2 }] };
    writes.length = 0;
    await mount(<OrgHistory />);
    await click('[data-org-history-entry="b-ask"] [data-org-history-act]');
    assert.deepEqual([...document.querySelectorAll("[data-undo-part]")].map((e) => e.getAttribute("data-undo-part")), ["will-change", "left-alone", "depends", "cannot"]);
    assert.match(q("[data-undo-left-line]")!.textContent!, /3 of 100/);
    assert.equal(q("[data-undo-confirm]")!.textContent, "Take back all 2");
    assert.deepEqual(writes, []);
    await click("[data-undo-confirm]");
    assert.equal((writes[0] as any[])[0], "undo");
    assert.equal((writes[0] as any[])[1], "b-ask");
    assert.deepEqual((writes[0] as any[])[2].with, ["b-budget"]);
    assert.equal(q("[data-undo-preview]"), null);
  });

  it("keeps the undone entry in place and routes redo through its own store action", async () => {
    preview = fixture.previews["b-hire"];
    writes.length = 0;
    await mount(<OrgHistory />);
    assert.ok(q('[data-org-history-entry="b-hire"][data-undone]'));
    assert.ok(q('[data-org-history-entry="b-hire"] [data-org-history-line]')!.classList.contains("line-through"));
    assert.match(q("[data-org-history-undone-by]")!.textContent!, /Taken back by Ashot/);
    await click('[data-org-history-entry="b-hire"] [data-org-history-act="redo"]');
    assert.equal(q("[data-undo-confirm]")!.textContent, "Apply again");
    await click("[data-undo-confirm]");
    assert.equal((writes[0] as any[])[0], "redo");
    assert.equal((writes[0] as any[])[1], "b-hire");
  });

  it("loading, refusal, missing preview and nothing left to undo cannot write", async () => {
    for (const value of [undefined, null, { ...fixture.previews["b-ask"], refused: "Only a person who can edit this role may undo it." }, { ...fixture.previews["b-ask"], will_change: [] }]) {
      preview = value;
      writes.length = 0;
      await mount(<OrgHistory />);
      await click('[data-org-history-entry="b-ask"] [data-org-history-act]');
      assert.equal(q<HTMLButtonElement>("[data-undo-confirm]")!.disabled, true);
      await click("[data-undo-confirm]");
      assert.deepEqual(writes, []);
      await click("[data-undo-cancel]");
      assert.equal(q("[data-undo-preview]"), null);
    }
  });

  it("filters the role's Scope history and offers earlier changes", async () => {
    let more = 0;
    await mount(<OrgHistory roleId="fixture-role-growth" limit={1} onMore={() => more++} />);
    assert.equal(document.querySelectorAll("[data-org-history-entry]").length, 1);
    assert.equal(q("[data-org-history-entry]")!.getAttribute("data-org-history-entry"), "b-budget");
    await click("[data-org-history-more]");
    assert.equal(more, 1);
  });

  it("a genuinely cold cache shows a skeleton and an empty ready cache shows the empty state", async () => {
    entries = [];
    await mount(<OrgHistory />);
    assert.ok(q("[data-org-history-skeleton]"));
    ready = true;
    await mount(<OrgHistory />);
    assert.equal(q("[data-org-history-skeleton]"), null);
    assert.ok(q('[data-org-history-empty="ready"]'));
    entries = fixture.entries;
    ready = false;
  });

  it("the preview fixture supports undo and redo without a store mutation", async () => {
    writes.length = 0;
    await mount(<OrgHistoryPreview />);
    await click('[data-org-history-entry="b-budget"] [data-org-history-act="undo"]');
    await click("[data-undo-confirm]");
    assert.ok(q('[data-org-history-entry="b-budget"][data-undone]'));
    await click('[data-org-history-entry="b-budget"] [data-org-history-act="redo"]');
    await click("[data-undo-confirm]");
    assert.equal(q('[data-org-history-entry="b-budget"][data-undone]'), null);
    assert.deepEqual(writes, []);
  });
});
