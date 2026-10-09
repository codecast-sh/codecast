import { expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "./test-helpers/globals";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const realPill = await import("./components/EntityIdPill");
mock.module("./components/EntityIdPill", () => ({ ...realPill, EntityIdPill: ({ shortId, id, type }: any) => <span data-pill={type}>{shortId ?? id}</span> }));
const realDisplay = await import("./lib/entityDisplay");
mock.module("./lib/entityDisplay", () => ({ ...realDisplay, useEntityResolution: () => ({ entity: null, served: true }) }));
const { createRoot } = await import("react-dom/client");
const { TaskRelations } = await import("./components/tasks/TaskRelations");

const task = (n: number, over: any = {}) => ({ _id: `id${n}`, short_id: `ct-${n}`, title: `Task ${n}`, status: "open", workspace: "team:t1", created_at: n, updated_at: n, ...over }) as any;

test("dump", async () => {
  const clear = task(1, { blocked_by: ["ct-3"], blocks: ["ct-5"], waits: [{ id: "w3", kind: "decision", decision: "sd-4", state: "met", created_at: 0, note: "answered: Ship it" }] });
  const tasks = { id1: clear, id3: task(3, { status: "done" }), id5: task(5, { blocked_by: ["ct-1"] }) };
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(<TaskRelations task={clear} tasks={tasks} onAdd={() => {}} />); });
  console.log(container.innerHTML.replace(/></g, ">\n<"));
  expect(1).toBe(1);
  root.unmount();
});
