import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// ct-97544. Every move between the org chart and a conversation held the main
// thread for 250 to 410 ms. The replays' long-animation-frame attribution puts
// the whole frame inside one script, `DIV#root.onclick` (React's root click
// dispatcher): the destination page is rendered and committed inside the click
// itself, so nothing paints and no input is read until it is done.
//
// With tabs on (the default), an in-app link goes through the compat Link →
// tabNavigate → store.updateTab, and TabContent swaps the pane from that store
// write. A store write in a click is a discrete, synchronous update, so React
// renders the whole destination before the click's task ends — unlike the
// router's own navigation, which React Router runs in a transition.
//
// This test clicks a real Link inside the shell's real TabContent, over the
// real store, and asks whether the destination page rendered before the
// click's task ended (only microtasks drained, no macrotask). While the miss
// exists it did; once the swap no longer blocks the click, it renders later.

import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://app.test/org",
  pretendToBeVisual: true,
});
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  MouseEvent: dom.window.MouseEvent,
  // Real scheduling: the point is which task the render lands in.
  IS_REACT_ACT_ENVIRONMENT: false,
});
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const CONV = "jx7etwcbhgevk98c3dzzm7ytv98gk8m7";

mock.module("../../hooks/useConversationMessages", () => ({
  useConversationMessages: () => {},
}));

const Link = (await import("../../src/compat/next-link")).default;

// The two pages the move goes between. Each is a stand-in that links to the
// other the way the real ones do (OrgPanel's "Open the full conversation", the
// sidebar's Org link).
mock.module("@/app/org/[id]/page", () => ({
  default: () => (
    <div data-page="org">
      <Link href={`/conversation/${CONV}`} data-testid="to-conversation">Open the full conversation</Link>
    </div>
  ),
}));
mock.module("@/app/conversation/[id]/page", () => ({
  default: () => (
    <div data-page="conversation">
      <Link href="/org" data-testid="to-org">Org</Link>
    </div>
  ),
}));

const { TabContent } = await import("../TabContent");
const { useInboxStore } = await import("../../store/inboxStore");
const { MemoryRouter } = await import("react-router");
const { createRoot } = await import("react-dom/client");

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const page = (name: string) => document.querySelector(`[data-page="${name}"]`);

/** Click `el` and report whether `dest` was on screen before the click's task
 *  ended: only microtasks run between the click and the look, never a macrotask,
 *  so anything drawn by then was drawn in the same task as the click. */
async function renderedInsideClick(el: Element, dest: string): Promise<boolean> {
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return !!page(dest);
}

describe("moving between the org chart and a conversation (ct-97544)", () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeAll(async () => {
    useInboxStore.setState({
      tabs: [{ id: "tab_a", path: "/org", title: "Org" }],
      activeTabId: "tab_a",
    } as any);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={["/org"]}>
        <TabContent />
      </MemoryRouter>,
    );
    await settle(100);
  });

  afterAll(async () => {
    root.unmount();
    container.remove();
  });

  test("the chart is on screen with tabs routing the links", async () => {
    expect(page("org")).not.toBeNull();
  });

  test("org chart → conversation: the click does not render the conversation inside itself", async () => {
    const link = document.querySelector('[data-testid="to-conversation"]')!;
    expect(link).not.toBeNull();
    const blocked = await renderedInsideClick(link, "conversation");
    await settle();
    // The move still happens.
    expect(page("conversation")).not.toBeNull();
    expect(useInboxStore.getState().tabs[0].path).toBe(`/conversation/${CONV}`);
    expect(blocked).toBe(false);
  });

  test("conversation → org chart: the click does not render the chart inside itself", async () => {
    const link = document.querySelector('[data-testid="to-org"]')!;
    expect(link).not.toBeNull();
    const blocked = await renderedInsideClick(link, "org");
    await settle();
    expect(page("org")).not.toBeNull();
    expect(useInboxStore.getState().tabs[0].path).toBe("/org");
    expect(blocked).toBe(false);
  });
});
