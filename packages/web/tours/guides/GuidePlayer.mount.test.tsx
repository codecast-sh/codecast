// The guide player (tours/guides/GuidePlayer.tsx) mounted in jsdom with a
// two-chapter guide: arrows step through beats and chapters, a beat that asks
// for a press waits for it (an arrow makes the press), the strip jumps, the
// last screen holds the team's switch and flips it through the store, Escape
// closes and records a skip, and finishing records the guide as seen.
// Run: bun tours/guides/GuidePlayer.mount.test.tsx
import assert from "node:assert/strict";
import { closeDomWindow } from "../../test-helpers/domGlobals";

async function run() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, { url: "https://local.codecast.sh/inbox", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  const { mock } = await import("bun:test");
  const pushes: string[] = [];
  mock.module("next/navigation", () => ({
    usePathname: () => "/inbox",
    useRouter: () => ({ push: (href: string) => { pushes.push(href); } }),
    useSearchParams: () => ({ get: () => null }),
  }));
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { useInboxStore } = await import("../../store/inboxStore");
  const { GuidePlayer } = await import("./GuidePlayer");
  const { startTour } = await import("../engine");
  const { tourSeenId } = await import("../seen");

  const Scene = ({ beat, act: press, waiting }: { beat: number; act: () => void; waiting: boolean }) =>
    React.createElement("div", { "data-test-scene": beat }, waiting ? React.createElement("button", { "data-test-press": "", onClick: press }, "press") : null);
  const guide = {
    id: "org-guide", feature: "org" as const, name: "Org", accent: "var(--sol-violet)", home: "/org",
    chapters: [
      { id: "one", title: "One", Scene, beats: [{ say: "First." }, { say: "Press it.", act: "Press it" }, { say: "Pressed." }] },
      { id: "two", title: "Two", Scene, beats: [{ say: "Second chapter." }] },
    ],
    gives: ["A thing a team gets"],
  };

  const store = useInboxStore.getState();
  store.updateClientTips({ completed: [], dismissed: [] });
  useInboxStore.setState({ teams: [{ _id: "t1", name: "Tidepool", role: "admin", features: {} }] as any, clientState: { ...useInboxStore.getState().clientState, ui: { ...(useInboxStore.getState().clientState.ui ?? {}), active_team_id: "t1" } } as any });

  const root = createRoot(document.getElementById("root")!);
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const settle = (ms = 60) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  const key = (k: string) => act(async () => { window.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: k, bubbles: true })); });
  const at = () => `${q("[data-guide]")!.getAttribute("data-guide-chapter")}:${q("[data-guide]")!.getAttribute("data-guide-beat")}`;

  startTour("org-guide", { replay: true });
  await act(async () => root.render(React.createElement(GuidePlayer, { guide })));
  assert.equal(at(), "one:0");
  assert.equal(q("[data-guide-say]")!.textContent, "First.");

  // ── an arrow steps; a beat that asks for a press waits, and the arrow makes it ──
  await key("ArrowRight");
  assert.equal(at(), "one:1");
  assert.ok(q("[data-guide-act]"), "the caption names the press");
  assert.ok(q("[data-test-press]"), "the scene shows its control");
  await act(async () => q<HTMLButtonElement>("[data-test-press]")!.click());
  assert.equal(q("[data-test-press]"), null, "pressed, it stops waiting");
  await settle(1250);
  assert.equal(at(), "one:2", "the press's result holds, then the next beat plays");

  // ── back over a pressed beat does not ask again; the strip jumps ──
  await key("ArrowLeft");
  assert.equal(at(), "one:1");
  assert.equal(q("[data-test-press]"), null, "a press made once stays made");
  await act(async () => q<HTMLButtonElement>('[data-guide-seg="two"]')!.click());
  assert.equal(at(), "two:0");

  // ── the last screen: the team's switch, and Open once it is on ──
  await key("ArrowRight");
  assert.ok(q("[data-guide-finale]"));
  const open = q<HTMLButtonElement>("[data-guide-open]")!;
  assert.equal(open.disabled, true, "Open waits for the feature to be on");
  await act(async () => q<HTMLButtonElement>('[data-guide-switch="t1"] [role="switch"]')!.click());
  assert.equal((useInboxStore.getState().teams as any[])[0].features.org, true, "the switch is the store's own action");
  assert.equal(q<HTMLButtonElement>("[data-guide-open]")!.disabled, false);
  await act(async () => q<HTMLButtonElement>("[data-guide-open]")!.click());
  assert.deepEqual(pushes, ["/org"]);
  assert.ok(useInboxStore.getState().clientState.tips?.completed?.includes(tourSeenId("org-guide")), "finishing records it");

  // ── Escape before the end records a skip ──
  store.updateClientTips({ completed: [], dismissed: [] });
  startTour("org-guide", { replay: true });
  await act(async () => root.render(React.createElement(GuidePlayer, { key: "again", guide })));
  await key("Escape");
  const tips = useInboxStore.getState().clientState.tips!;
  assert.ok(tips.dismissed?.includes(tourSeenId("org-guide")));
  assert.equal(useInboxStore.getState().tour, null);

  await act(async () => root.unmount());
  closeDomWindow(dom);
  console.log("GuidePlayer mount: ok");
}

await run();
