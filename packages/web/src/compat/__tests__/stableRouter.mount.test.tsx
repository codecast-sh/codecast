import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, useLocation } = await import("react-router");
const { useRouter } = await import("../next-navigation");
const { useTabActive } = await import("../../../hooks/usePagePresence");
const { TabPaneCtx, TabParamsCtx, useTabPane } = await import("../../../lib/tabParams");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { root, rerender: (next: React.ReactNode) => act(() => root.render(next)) };
}

// A session switch changes the URL. useRouter() consumers (every linked pill,
// the rail, the card list) re-rendered on each one while useNavigate read the
// location; they hold still now and keep one router.
test("a useRouter() consumer neither re-renders nor gets a new router when the location changes", () => {
  const routers: unknown[] = [];
  let renders = 0;
  let push: (path: string) => void = () => {};
  let path = "";
  const Consumer = () => {
    renders++;
    const router = useRouter();
    routers.push(router);
    push = router.push;
    return null;
  };
  const Where = () => {
    const loc = useLocation();
    path = loc.pathname + loc.search;
    return null;
  };
  const { root } = mount(<MemoryRouter initialEntries={["/conversation/a"]}><Consumer /><Where /></MemoryRouter>);
  expect(renders).toBe(1);

  act(() => push("/conversation/b"));
  expect(path).toBe("/conversation/b");
  act(() => push("?q=1"));
  expect(path).toBe("/conversation/b?q=1");
  expect(renders).toBe(1);
  expect(new Set(routers).size).toBe(1);
  act(() => root.unmount());
});

test("a pane's identity readers hold still while the pane's location moves", () => {
  let renders = 0;
  const Reader = () => {
    renders++;
    useRouter();
    useTabActive();
    return null;
  };
  const pane = { tabId: "t", isActive: true, isVisible: true };
  const scope = (pathname: string) => ({ ...pane, pathname, params: {}, searchParams: new URLSearchParams() });
  const tree = (pathname: string, child: React.ReactNode) => (
    <MemoryRouter>
      <TabPaneCtx.Provider value={pane}>
        <TabParamsCtx.Provider value={scope(pathname)}>{child}</TabParamsCtx.Provider>
      </TabPaneCtx.Provider>
    </MemoryRouter>
  );
  const reader = <Reader />;
  const { root, rerender } = mount(tree("/conversation/a", reader));
  rerender(tree("/conversation/b", reader));
  expect(renders).toBe(1);
  act(() => root.unmount());
});

test("useTabPane answers from TabParamsCtx where a pane provides only that", () => {
  let seen: ReturnType<typeof useTabPane> = null;
  const Probe = () => { seen = useTabPane(); return null; };
  const { root } = mount(
    <TabParamsCtx.Provider value={{ tabId: "legacy", pathname: "/x", params: {}, searchParams: new URLSearchParams(), isActive: false }}>
      <Probe />
    </TabParamsCtx.Provider>,
  );
  expect(seen).toMatchObject({ tabId: "legacy", isActive: false });
  act(() => root.unmount());
  const outside = mount(<Probe />);
  expect(seen).toBeNull();
  act(() => outside.root.unmount());
});
