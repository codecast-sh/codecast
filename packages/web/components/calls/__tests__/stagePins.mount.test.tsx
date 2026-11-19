import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

// A thing pinned on the stage (a board, a doc, a page) holds the stage the way
// a screen share does: the host draws it, the newest takes the stage by
// default, and every share and pin is a tab over it. A host with no pin
// renderer (a guest's page) draws none.

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});
const { createRoot } = await import("react-dom/client");
const { AutoStage, GridStage } = await import("../StageViews");
const { StageHostProvider } = await import("../stageHost");
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const pin = (ref: string, name: string) => ({ kind: "pin" as const, key: `pin:${ref}`, identity: `pin:${ref}`, name, pin: { ref } });
const PinTile = ({ share, small }: { share: { name: string }; small?: boolean }) => (
  <div data-test-pin={share.name} data-small={small ? "1" : "0"}>{share.name}</div>
);

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => root.render(node));
  return { container, root };
}

test("the first share or pin holds the stage, and every one of them is a tab", async () => {
  const { container, root } = await mount(
    <StageHostProvider value={{ getRoom: () => null, PinTile }}>
      <AutoStage roster={[]} cameras={[]} screens={[pin("doc:b", "Call board"), pin("a/r", "Funnel")]} speaking={new Set()} phase="connected" />
    </StageHostProvider>,
  );
  expect([...container.querySelectorAll("[data-test-pin]")].map((e) => e.getAttribute("data-test-pin"))).toEqual(["Call board"]);
  const tabs = [...container.querySelectorAll("[role=tab]")];
  expect(tabs.map((t) => t.textContent)).toEqual(["Call board", "Funnel"]);
  await act(() => (tabs[1] as HTMLButtonElement).click());
  expect(container.querySelector("[data-test-pin]")?.getAttribute("data-test-pin")).toBe("Funnel");
  await act(() => root.unmount());
});

test("a pin in the grid is a whole cell; with no pin renderer it draws nothing", async () => {
  const withHost = await mount(
    <StageHostProvider value={{ getRoom: () => null, PinTile }}>
      <GridStage roster={[]} cameras={[]} screens={[pin("doc:b", "Call board")]} speaking={new Set()} />
    </StageHostProvider>,
  );
  expect(withHost.container.querySelector("[data-test-pin]")?.getAttribute("data-small")).toBe("0");
  await act(() => withHost.root.unmount());
  const guest = await mount(
    <StageHostProvider value={{ getRoom: () => null }}>
      <GridStage roster={[]} cameras={[]} screens={[pin("doc:b", "Call board")]} speaking={new Set()} />
    </StageHostProvider>,
  );
  expect(guest.container.querySelector("[data-test-pin]")).toBeNull();
  await act(() => guest.root.unmount());
});
