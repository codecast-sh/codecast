// The spotlight (tours/TourLayer.tsx) mounted in jsdom against a page of
// anchors: a step shows over its target, an optional step with no target is
// skipped and left out of the count, the keys move and close, the "do it
// now" button clicks its control, finishing and dismissing write the seen
// record, and a tour started off its page goes there first.
// Run: bun tours/TourLayer.mount.test.tsx
import assert from "node:assert/strict";
import { closeDomWindow } from "../test-helpers/domGlobals";

const pushes: string[] = [];
let pathname = "/org/or-1";

async function run() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(`<!doctype html><html><body>
    <div data-scope-head>card</div>
    <button data-scope-tab="triggers">Triggers</button>
    <div data-scope-actions>pause</div>
    <div data-scope-conversation="c1">ask</div>
    <div id="root"></div></body></html>`, { url: "https://local.codecast.sh/org/or-1", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  // Boxes: jsdom lays nothing out, so every anchor reports a box of its own.
  const { Element: El } = dom.window as any;
  El.prototype.getBoundingClientRect = function () {
    const i = [...document.querySelectorAll("*")].indexOf(this);
    return { left: 20, top: 40 + i * 50, right: 220, bottom: 70 + i * 50, width: 200, height: 30, x: 20, y: 40 + i * 50, toJSON() {} };
  };
  El.prototype.scrollIntoView = function () {};

  const { mock } = await import("bun:test");
  mock.module("next/navigation", () => ({
    usePathname: () => pathname,
    useRouter: () => ({ push: (href: string) => { pushes.push(href); pathname = href; } }),
    useSearchParams: () => ({ get: () => null }),
  }));
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { useInboxStore } = await import("../store/inboxStore");
  const { TourLayer } = await import("./TourLayer");
  const { startTour, endTour } = await import("./engine");
  const { isTourSeen, tourSeenId } = await import("./seen");
  const { tourById } = await import("./registry");

  // The triggers tab opens its panel when clicked: the page's own behaviour, stubbed.
  const tab = document.querySelector<HTMLButtonElement>('[data-scope-tab="triggers"]')!;
  tab.addEventListener("click", () => tab.setAttribute("aria-selected", "true"));

  const root = createRoot(document.getElementById("root")!);
  const render = () => act(async () => root.render(React.createElement(TourLayer)));
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const settle = (ms = 150) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  const key = (k: string) => act(async () => { window.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: k, bubbles: true })); });
  const store = useInboxStore.getState();
  store.updateClientTips({ completed: [], dismissed: [] });

  await render();
  assert.equal(q("[data-tour-open]"), null, "nothing runs until started");

  // ── the role page tour: reports-to is absent, so it is skipped and left
  //    out of the count; the triggers step's button clicks the tab ──
  assert.equal(startTour("org-role", { replay: true }), true);
  assert.equal(startTour("nope"), false);
  await render(); await settle();
  assert.equal(q("[data-tour-open]")!.getAttribute("data-tour-open"), "org-role");
  assert.equal(q("[data-tour-step]")!.getAttribute("data-tour-step"), "card");
  assert.equal(q("[data-tour-count]")!.textContent, "1 of 4");
  assert.ok(q("[data-tour-ring]"), "the target has a ring");
  assert.equal(q("[data-tour-back]"), null, "no Back on the first step");
  await key("ArrowRight");
  await settle(1100);
  assert.equal(q("[data-tour-step]")!.getAttribute("data-tour-step"), "triggers", "reports-to was skipped");
  assert.equal(q("[data-tour-count]")!.textContent, "2 of 4");
  await key("ArrowLeft");
  await settle(1100);
  assert.equal(q("[data-tour-step]")!.getAttribute("data-tour-step"), "card", "back skips it too");
  await key("ArrowRight"); await settle(1100);
  // The step's own button clicks the control and moves on.
  const action = q<HTMLButtonElement>("[data-tour-action]")!;
  assert.equal(action.textContent, "Open Triggers");
  await act(async () => action.click());
  await settle();
  assert.equal(tab.getAttribute("aria-selected"), "true", "the tab was opened");
  assert.equal(q("[data-tour-step]")!.getAttribute("data-tour-step"), "pause");
  assert.equal(q("[data-tour-action]"), null, "the pause step has no button of its own");
  await key("ArrowRight"); await settle();
  assert.equal(q("[data-tour-step]")!.getAttribute("data-tour-step"), "ask");
  assert.equal(q("[data-tour-next]")!.textContent, "Done", "the last step says Done");
  await act(async () => q<HTMLButtonElement>("[data-tour-next]")!.click());
  await settle();
  assert.equal(q("[data-tour-open]"), null, "Done closes");
  assert.ok(useInboxStore.getState().clientState.tips?.completed?.includes(tourSeenId("org-role")), "finished is recorded");
  assert.ok(isTourSeen(tourById("org-role")!, useInboxStore.getState().clientState));

  // ── Escape dismisses and records a skip; a later finish upgrades it ──
  store.updateClientTips({ completed: [], dismissed: [] });
  startTour("org-role", { replay: true });
  await render(); await settle(300);
  assert.equal(q("[data-tour-step]")!.getAttribute("data-tour-step"), "card");
  await key("Escape");
  await settle();
  assert.equal(q("[data-tour-open]"), null);
  const tips = useInboxStore.getState().clientState.tips!;
  assert.ok(tips.dismissed?.includes(tourSeenId("org-role")));
  assert.ok(!tips.completed?.includes(tourSeenId("org-role")));

  // ── a step whose target never comes and is not optional: the card still
  //    shows, centred, and says so ──
  // (The page shows one of the tour's controls, so the page gate opens.)
  const head = document.querySelector("[data-scope-head]")!;
  head.remove();
  startTour("org-role", { replay: true });
  await render(); await settle(2200);
  assert.equal(q("[data-tour-step]")!.getAttribute("data-tour-step"), "card");
  assert.ok(q("[data-tour-missing]"), "says the control is not on this screen");
  assert.equal(q("[data-tour-ring]"), null);
  endTour("skipped");
  document.body.prepend(head);
  await render();

  // ── a tour started off its page goes there first ──
  pathname = "/inbox";
  startTour("org-role", { replay: true });
  await render(); await settle();
  assert.deepEqual(pushes, ["/org"]);
  endTour("skipped");
  await render();

  // ── the modal tour draws nothing here (its own screens run it) ──
  pathname = "/inbox";
  startTour("inbox", { replay: true });
  await render(); await settle();
  assert.equal(q("[data-tour-open]"), null);
  endTour("finished");
  assert.ok(useInboxStore.getState().clientState.tips?.completed?.includes(tourSeenId("inbox")));

  await act(async () => root.unmount());
  closeDomWindow(dom);
  console.log("TourLayer mount: ok");
}

await run();
