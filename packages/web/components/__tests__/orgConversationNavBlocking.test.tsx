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

// Registered before anything imports the app, so no real page module loads.
// The stand-ins import the real compat Link when they render.
const Link = (props: any) => {
  const Real = require("../../src/compat/next-link").default;
  return <Real {...props} />;
};

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
// A tab shows a conversation through the inbox page (conversationTabPath), so
// both modules answer with the conversation stand-in.
const ConversationStandIn = () => (
  <div data-page="conversation">
    <Link href="/org" data-testid="to-org">Org</Link>
  </div>
);
mock.module("@/app/conversation/[id]/page", () => ({ default: ConversationStandIn }));
mock.module("@/app/inbox/page", () => ({ default: ConversationStandIn }));

const { TabContent } = await import("../TabContent");
const { useInboxStore } = await import("../../store/inboxStore");
const { MemoryRouter } = await import("react-router");
const { createRoot } = await import("react-dom/client");

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const page = (name: string) => document.querySelector(`[data-page="${name}"]`);

/** On screen: present and not hidden by a Suspense boundary. */
const shown = (name: string) => {
  const el = page(name) as HTMLElement | null;
  return !!el && !el.style.display.includes("none");
};
const click = (el: Element) =>
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
async function waitFor(name: string) {
  for (let i = 0; i < 100 && !shown(name); i++) await settle(50);
}

/** Click `el` and report whether React committed the move from `from` to
 *  `dest` before the click's task ended: only microtasks run between the click
 *  and the look, never a macrotask, so a page swapped by then was rendered and
 *  committed in the same task as the click. */
async function swappedInsideClick(el: Element, from: string, dest: string): Promise<boolean> {
  click(el);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return shown(dest) || !shown(from);
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
    // The pane's lazy page resolves a few ticks later; wait for it, and for the
    // destination's lazy module too, so the click measures the swap and not a
    // first module load.
    await waitFor("org");
    // One round trip first, unmeasured: it loads both routes' lazy modules, as
    // the replays' repeated moves had, so the measured clicks see the swap
    // itself and not a first module load suspending.
    click(document.querySelector('[data-testid="to-conversation"]')!);
    await waitFor("conversation");
    click(document.querySelector('[data-testid="to-org"]')!);
    await waitFor("org");
  });

  afterAll(async () => {
    root.unmount();
    container.remove();
  });

  test("the chart is on screen with tabs routing the links", async () => {
    expect(shown("org")).toBe(true);
  });

  test("org chart → conversation: the click does not render the conversation inside itself", async () => {
    const link = document.querySelector('[data-testid="to-conversation"]')!;
    expect(link).not.toBeNull();
    const blocked = await swappedInsideClick(link, "org", "conversation");
    await waitFor("conversation");
    // The move still happens.
    expect(shown("conversation")).toBe(true);
    expect(useInboxStore.getState().tabs[0].path).toContain(CONV);
    expect(blocked).toBe(false);
  });

  test("conversation → org chart: the click does not render the chart inside itself", async () => {
    const link = document.querySelector('[data-testid="to-org"]')!;
    expect(link).not.toBeNull();
    const blocked = await swappedInsideClick(link, "conversation", "org");
    await waitFor("org");
    expect(shown("org")).toBe(true);
    expect(useInboxStore.getState().tabs[0].path).toBe("/org");
    expect(blocked).toBe(false);
  });
});
