// A visible way to start a session. Modern's rail had only a small plus on a
// folded heading, and zen hides the rail and the top bar together, so the
// inbox list carries its own button in Modern. Classic and Minimal keep their
// list head as it was.
// Run: cd packages/web && bun test --isolate components/inbox/NewSessionButton.mount.test.tsx
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import type { VisualStyle } from "../ThemeProvider";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/inbox" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { ThemeContext } = await import("../ThemeProvider");
const { useInboxStore } = await import("../../store/inboxStore");
const { ListHeadNewSession, NewSessionButton } = await import("./NewSessionButton");

const host = document.createElement("div");
document.body.append(host);
let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = null;
});
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

async function mount(style: VisualStyle, node: ReactNode) {
  root = createRoot(host);
  await act(() => root!.render(
    <ThemeContext.Provider value={{ theme: "light", toggleTheme: () => {}, visualStyle: style, setVisualStyle: () => {} }}>
      {node}
    </ThemeContext.Provider>,
  ));
}

describe("the New session button", () => {
  test("heads the inbox list in Modern and opens the composer", async () => {
    const before = useInboxStore.getState().openCompose;
    let opened = 0;
    useInboxStore.setState({ openCompose: (() => { opened++; }) as typeof before });
    try {
      await mount("modern", <ListHeadNewSession />);
      const button = host.querySelector<HTMLButtonElement>('button[data-new-session="icon"]')!;
      expect(button.getAttribute("aria-label")).toBe("New session");
      await act(() => button.click());
      expect(opened).toBe(1);
    } finally {
      useInboxStore.setState({ openCompose: before });
    }
  });

  test("Classic and Minimal keep their list head as it was", async () => {
    for (const style of ["classic", "minimal"] as const) {
      await mount(style, <ListHeadNewSession />);
      expect(host.querySelector("[data-new-session]")).toBeNull();
      await act(() => root!.unmount());
      root = null;
    }
  });

  test("the rail's row says what it does in words", async () => {
    await mount("modern", <NewSessionButton variant="row" />);
    const button = host.querySelector<HTMLButtonElement>('button[data-new-session="row"]')!;
    expect(button.textContent).toBe("New session");
  });
});
