// The spotlight (tours/TourLayer.tsx) mounted in jsdom against a page of
// anchors: a step opens the panel it points at, an optional step with no
// target is skipped and left out of the count, the keys move and close, the
// "do it now" button clicks its control, finishing and dismissing write the
// seen record, and a tour started off its page goes there first.
// Run: bun tours/TourLayer.mount.test.tsx
import assert from "node:assert/strict";
import { closeDomWindow } from "../test-helpers/domGlobals";

const pushes: string[] = [];
let pathname = "/org";

async function run() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(`<!doctype html><html><body>
    <div data-org-node="me">me</div>
    <button data-org-health-open aria-pressed="false">Health</button>
    <button data-org-hire-gallery>Hire</button>
    <div id="root"></div></body></html>`, { url: "https://local.codecast.sh/org", pretendToBeVisual: true });
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

  // Health opens its panel when clicked: the page's own behaviour, stubbed.
  const health = document.querySelector<HTMLButtonElement>("[data-org-health-open]")!;
  health.addEventListener("click", () => {
    health.setAttribute("aria-pressed", "true");
    const page = document.createElement("div");
    page.setAttribute("data-health-page", "desktop");
    page.innerHTML = '<section data-needs-you="empty">needs you</section><div data-health-map><span data-week-signal>stuck</span></div><div data-head-column="open">head</div>';
    document.body.appendChild(page);
  });

  const root = createRoot(document.getElementById("root")!);
  const render = () => act(async () => root.render(React.createElement(TourLayer)));
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const settle = (ms = 150) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  const key = (k: string) => act(async () => { window.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: k, bubbles: true })); });
  const store = useInboxStore.getState();
  store.updateClientTips({ completed: [], dismissed: [] });

  await render();
  assert.equal(q("[data-tour-open]"), null, "nothing runs until started");

  // ── the org page tour: head and role are absent, so they are skipped and
  //    left out of the count; the proposals step falls back to Health ──
  assert.equal(startTour("org-page", { replay: true }), true);
  assert.equal(startTour("nope"), false);
  await render(); await settle();
  assert.equal(q("[data-tour-open]")!.getAttribute("data-tour-open"), "org-page");
  assert.equal(q("[data-tour-step]")!.getAttribute("data-tour-step"), "chart");
  assert.equal(q("[data-tour-count]")!.textContent, "1 of 4");
  assert.ok(q("[data-tour-ring]"), "the target has a ring");
  assert.equal(q("[data-tour-back]"), null, "no Back on the first step");
  await key("ArrowRight");
  await settle(1100);
  assert.equal(q("[data-tour-step]")!.getAttribute("data-tour-step"), "proposals", "head and role were skipped");
  assert.equal(q("[data-tour-count]")!.textContent, "2 of 4");
  assert.equal(q("[data-tour-action]"), null, "the proposals step has no button of its own");
  await key("ArrowLeft");
  await settle(1100);
  assert.equal(q("[data-tour-step]")!.getAttribute("data-tour-step"), "chart", "back skips them too");
  await key("ArrowRight"); await settle(1100);
  await key("ArrowRight"); await settle();
  assert.equal(q("[data-tour-step]")!.getAttribute("data-tour-step"), "health");
  // The step's own button clicks the control and moves on.
  const action = q<HTMLButtonElement>("[data-tour-action]")!;
  assert.equal(action.textContent, "Open Health");
  await act(async () => action.click());
  await settle();
  assert.equal(health.getAttribute("aria-pressed"), "true", "Health was opened");
  assert.equal(q("[data-tour-step]")!.getAttribute("data-tour-step"), "hire");
  assert.equal(q("[data-tour-next]")!.textContent, "Done", "the last step says Done");
  await act(async () => q<HTMLButtonElement>("[data-tour-next]")!.click());
  await settle();
  assert.equal(q("[data-tour-open]"), null, "Done closes");
  assert.ok(useInboxStore.getState().clientState.tips?.completed?.includes(tourSeenId("org-page")), "finished is recorded");
  assert.ok(isTourSeen(tourById("org-page")!, useInboxStore.getState().clientState));

  // ── the health tour: its first step opens the panel itself ──
  document.querySelector("[data-health-page]")?.remove();
  health.setAttribute("aria-pressed", "false");
  startTour("org-health", { replay: true });
  await render(); await settle(300);
  assert.equal(q("[data-tour-step]")!.getAttribute("data-tour-step"), "needs-you");
  assert.ok(document.querySelector("[data-health-page]"), "prepare clicked Health");
  assert.equal(q("[data-tour-count]")!.textContent, "1 of 4");
  // Escape dismisses and records a skip; a later finish upgrades it.
  await key("Escape");
  await settle();
  assert.equal(q("[data-tour-open]"), null);
  const tips = useInboxStore.getState().clientState.tips!;
  assert.ok(tips.dismissed?.includes(tourSeenId("org-health")));
  assert.ok(!tips.completed?.includes(tourSeenId("org-health")));

  // ── a step whose target never comes and is not optional: the card still
  //    shows, centred, and says so ──
  // (The page shows one of the tour's controls, so the page gate opens.)
  const ask = document.createElement("div");
  ask.setAttribute("data-scope-conversation", "c1");
  document.body.appendChild(ask);
  startTour("org-role", { replay: true });
  pathname = "/org/or-1";
  await render(); await settle(2200);
  assert.equal(q("[data-tour-step]")!.getAttribute("data-tour-step"), "card");
  assert.ok(q("[data-tour-missing]"), "says the control is not on this screen");
  assert.equal(q("[data-tour-ring]"), null);
  endTour("skipped");
  ask.remove();
  await render();

  // ── a tour started off its page goes there first ──
  pathname = "/inbox";
  startTour("org-hire", { replay: true });
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
