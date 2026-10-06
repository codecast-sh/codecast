import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { useInboxStore, useTrackedStore } from "../inboxStore";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.sh" });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restore(); });

test("reads selectors once per snapshot and refreshes on props and state", async () => {
  const initial = useInboxStore.getState();
  useInboxStore.setState({ tasks: { a: { _id: "a", title: "first" }, b: { _id: "b", title: "second" } } } as any);
  let reads = 0;
  function Probe({ id }: { id: string }) {
    const s = useTrackedStore([(state) => { reads++; return state.tasks[id]?.title; }]);
    return <span>{s.tasks[id]?.title}</span>;
  }
  const el = document.createElement("div");
  const root = createRoot(el);
  try {
    await act(async () => root.render(<Probe id="a" />));
    expect(el.textContent).toBe("first");
    expect(reads).toBe(1);
    await act(async () => root.render(<Probe id="b" />));
    expect(el.textContent).toBe("second");
    await act(async () => useInboxStore.setState({ tasks: { ...useInboxStore.getState().tasks, b: { _id: "b", title: "changed" } } } as any));
    expect(el.textContent).toBe("changed");
  } finally {
    await act(async () => root.unmount());
    useInboxStore.setState(initial, true);
  }
});
