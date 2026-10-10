import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { MAX_TASK_DEPTH } from "@codecast/shared/tasks";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { useInboxStore } from "../../store/inboxStore";
import { SubtasksSection } from "./SubtasksSection";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.sh" });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restore(); });

test("keeps the depth cap correct when a task is reparented", async () => {
  const initial = useInboxStore.getState();
  const tasks = Object.fromEntries(Array.from({ length: MAX_TASK_DEPTH + 1 }, (_, i) => [String(i), {
    _id: String(i), short_id: `ct-${i}`, title: `Task ${i}`, source: "human", status: "open", parent_id: i ? String(i - 1) : undefined,
  }]));
  useInboxStore.setState({ tasks } as any);
  const el = document.createElement("div");
  const root = createRoot(el);
  try {
    await act(async () => root.render(<SubtasksSection task={tasks[String(MAX_TASK_DEPTH)]} onNavigate={() => {}} />));
    expect(el.textContent).toContain("Deepest level");
    expect(el.querySelector("input")).toBeNull();
    await act(async () => useInboxStore.setState({ tasks: { ...tasks, [MAX_TASK_DEPTH]: { ...tasks[String(MAX_TASK_DEPTH)], parent_id: undefined } } } as any));
    expect(el.textContent).not.toContain("Deepest level");
    expect(el.querySelector("input")).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    useInboxStore.setState(initial, true);
  }
});
