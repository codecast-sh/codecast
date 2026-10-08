// The project Timeline draws each post the store holds as its card, which
// carries the post's comment thread, so the server's comment rows for those
// posts are not drawn again on the rail. A comment on a post the store does
// not hold yet still reads as its one line.
// Run: bun test components/ProjectTimeline.mount.test.tsx
import { test } from "bun:test";
import assert from "node:assert/strict";
import { restoreInboxStoreAfterAll } from "./__tests__/mockInboxStore";
import { closeDomWindow } from "../test-helpers/domGlobals";

restoreInboxStoreAfterAll();

test("a held post's comments ride its card, not the rail", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  const h = React.createElement;
  const now = Date.now();
  const post = { _id: "upd_held", project_id: "proj", title: "Week 1", body: "Shipped", kind: "update", author: "Ashot", author_kind: "user", created_at: now - 60_000, updated_at: now - 60_000 };
  const events = [
    { ts: now - 60_000, type: "update_posted", actor: "Ashot", update: { id: "upd_held", title: "Week 1", kind: "update", body: "Shipped" } },
    { ts: now - 30_000, type: "update_comment", actor: "Sam", text: "Nice work", update: { id: "upd_held", title: "Week 1", kind: "update", body: "" } },
    { ts: now - 20_000, type: "update_comment", actor: "Sam", text: "And this one", update: { id: "upd_elsewhere", title: "Week 0", kind: "update", body: "" } },
  ];
  const realQuery = { ...(await import("../hooks/useQueryNoThrow")) };
  mock.module("../hooks/useQueryNoThrow", () => ({ ...realQuery, useQueryNoThrow: () => ({ data: events, error: undefined, retry: () => {} }) }));
  const realUpdates = { ...(await import("../hooks/useProjectUpdates")) };
  mock.module("../hooks/useProjectUpdates", () => ({ ...realUpdates, useProjectUpdates: () => ({ ready: true, refused: false, retry: () => {}, updates: [post] }) }));
  const realExternal = { ...(await import("../hooks/useSyncExternalEvents")) };
  mock.module("../hooks/useSyncExternalEvents", () => ({ ...realExternal, useSyncProjectExternalEvents: () => {}, useExternalEvents: () => [] }));
  const realCards = { ...(await import("./ProjectUpdates")) };
  mock.module("./ProjectUpdates", () => ({ ...realCards, UpdateCard: ({ update }: any) => h("div", { "data-card": update._id }), UpdateComposer: () => h("div", { "data-composer": true }) }));

  const { createRoot } = await import("react-dom/client");
  const { ProjectTimeline } = await import("./ProjectTimeline");
  const root = createRoot(document.getElementById("root")!);
  await React.act(async () => root.render(h(ProjectTimeline, { projectId: "proj", composer: false })));
  const text = document.getElementById("root")!.textContent!;
  assert.deepEqual([...document.querySelectorAll("[data-card]")].map((c) => c.getAttribute("data-card")), ["upd_held"], "the post is its card");
  assert.doesNotMatch(text, /Nice work/, "its comment is on the card, not repeated on the rail");
  assert.match(text, /commented on.*Week 0.*And this one/, "a comment on a post the store lacks still reads");
  assert.equal(document.querySelector("[data-composer]"), null, "composer={false} draws none");
  await React.act(async () => root.unmount());
  closeDomWindow(dom);
});
