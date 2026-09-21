import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restore = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
afterAll(() => { dom.window.close(); restore(); });

const evidence = {
  A: ["a1", "a2", "a3"],
  B: ["b1"],
};
mock.module("../../../hooks/useSyncTaskEvidence", () => ({
  useSyncTaskEvidence: () => {},
  useTaskEvidence: (id: keyof typeof evidence) => ({
    images: evidence[id].map((name) => ({ url: `https://images.example/${name}.png`, message_id: `message-${id}` })),
  }),
}));
mock.module("../../../lib/taskStatuses", () => ({ useTeamTaskStatusList: () => [], boardOrderedStatuses: () => [] }));
mock.module("../../../lib/stage", () => ({ openBrowserPane: () => {} }));
mock.module("../../tasks/StationStrip", () => ({ ReviewVerdictChip: () => null }));
mock.module("../../TaskStatusBadge", () => ({ TaskStatusBadge: () => null }));
mock.module("next/link", () => ({ default: () => null }));

const { createRoot } = await import("react-dom/client");
const { TaskEvidence } = await import("../../tasks/TaskEvidence");

test("thumbnail clicks open their full task list, navigate, close, and reset on task changes", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (id: string) => act(() => root.render(<TaskEvidence task={{ _id: id }} />));
  const click = (selector: string) => act(() => { document.querySelector<HTMLButtonElement>(selector)!.click(); });
  const press = (key: string) => act(() => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })); });
  const current = () => document.querySelector<HTMLImageElement>('img[alt="Gallery image"]');
  const pageKeys: string[] = [];
  const onPageKey = (e: KeyboardEvent) => { pageKeys.push(e.key); };
  window.addEventListener("keydown", onPageKey);
  try {
    await render("A");
    expect(host.querySelectorAll("a")).toHaveLength(0);
    await click('[aria-label="Open evidence image 2 of 3"]');
    expect(current()?.src).toBe("https://images.example/a2.png");
    expect(document.body.textContent).toContain("2 / 3");
    expect(document.querySelector('[role="dialog"][aria-modal="true"][aria-label="Image gallery"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Copy link to image"]')).not.toBeNull();
    await press("ArrowRight");
    expect(current()?.src).toBe("https://images.example/a3.png");
    await click('button[title="Image 1"]');
    expect(current()?.src).toBe("https://images.example/a1.png");
    await click('button[title="Next"]');
    await click('button[title="Previous"]');
    expect(current()?.src).toBe("https://images.example/a1.png");
    await press("Escape");
    expect(current()).toBeNull();
    expect(pageKeys).toEqual([]);
    await press("Escape");
    expect(pageKeys).toEqual(["Escape"]);
    await click('[aria-label="Open evidence image 3 of 3"]');
    await render("B");
    expect(current()).toBeNull();
    await click('[aria-label="Open evidence image 1 of 1"]');
    expect(current()?.src).toBe("https://images.example/b1.png");
    expect(document.querySelector('button[title="Next"]')).toBeNull();
    expect(document.querySelector('img[src="https://images.example/a1.png"]')).toBeNull();
    await click('button[title="Close (Esc)"]');
    expect(current()).toBeNull();
  } finally {
    window.removeEventListener("keydown", onPageKey);
    await act(() => root.unmount());
    host.remove();
  }
});
