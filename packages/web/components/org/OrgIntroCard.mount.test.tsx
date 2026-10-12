// The introduction anywhere (org-staffing.md S20), mounted in jsdom.
//
// The card: its two actions, the pure gate (phone, a call, a composer with
// text, the prefs, hydration), the DOM read for a composer with text, and
// the mount that raises it on the app's toast once the page settles and
// writes the pref whichever way it is answered.
//
// Run: bun test --timeout 120000 components/org/OrgIntroCard.mount.test.tsx
import { test, expect, beforeAll, afterAll, mock } from "bun:test";

// The real store module, snapshotted before anything substitutes it, and put
// back when this file ends: `mock.module` is process-global and permanent.
const realInboxStore = { ...(await import("../../store/inboxStore")) };
afterAll(() => { mock.module("../../store/inboxStore", () => realInboxStore); });

let React: typeof import("react");
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let intro: typeof import("../../lib/orgIntro");
let card: typeof import("./OrgIntroCard") & typeof import("./OrgIntroAnywhere") & typeof import("../../lib/orgIntroCard");

// The fakes the card's mount reads through: the store, the router, the toast.
type Ui = { org_intro_seen?: boolean; org_upsell_seen?: boolean };
const fake = {
  state: { clientStateInitialized: true, teams: [{ _id: "t1", features: { org: true } }], currentUser: { _id: "u1" } as { _id: string } | null, clientState: { ui: {} as Ui }, call: { phase: "idle" }, updateClientUI(p: Ui) { Object.assign(fake.state.clientState.ui, p); fake.writes.push({ ...p }); } },
  writes: [] as Ui[],
  pathname: "/inbox",
  pushes: [] as string[],
  phone: false,
  toasts: [] as Array<{ id: string; render: (id: string) => React.ReactElement; onDismiss?: () => void }>,
  dismissed: [] as string[],
  reset() { fake.state.clientStateInitialized = true; fake.state.currentUser = { _id: "u1" }; fake.state.clientState.ui = {}; fake.state.call = { phase: "idle" }; fake.writes = []; fake.pathname = "/inbox"; fake.pushes = []; fake.phone = false; fake.toasts = []; fake.dismissed = []; },
};

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div><div id='toast'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLTextAreaElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    const v = (dom.window as any)[key];
    if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
  }
  if (!(globalThis as any).ResizeObserver) (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  act = React.act;
  ({ createRoot } = await import("react-dom/client"));
  // Link the component graph BEFORE substituting the store: replacing a
  // module that a dynamic import is still resolving deadlocks that import,
  // and the substitution mutates the live module object, so modules already
  // linked still read the stub.
  intro = await import("../../lib/orgIntro");
  card = { ...await import("./OrgIntroCard"), ...await import("./OrgIntroAnywhere"), ...await import("../../lib/orgIntroCard") };
  mock.module("../../store/inboxStore", () => ({
    ...realInboxStore,
    // Keep the hook's own methods (subscribe, setState, getInitialState): a
    // bare { getState } stub leaves the module graph waiting on a store that
    // can never answer, and the import never settles.
    useInboxStore: Object.assign(
      (selector: (state: unknown) => unknown) => selector(fake.state),
      realInboxStore.useInboxStore,
      { getState: () => fake.state },
    ),
    useTrackedStore: () => fake.state,
  }));
  mock.module("next/navigation", () => ({ usePathname: () => fake.pathname, useRouter: () => ({ push: (p: string) => fake.pushes.push(p), replace: () => {} }) }));
  mock.module("../../hooks/useIsPhone", () => ({ useIsPhone: () => fake.phone, useMinWidth: () => true }));
  mock.module("sonner", () => ({
    toast: {
      custom: (render: (id: string) => React.ReactElement, opts: { id: string; onDismiss?: () => void }) => { fake.toasts.push({ id: opts.id, render, onDismiss: opts.onDismiss }); return opts.id; },
      dismiss: (id: string) => fake.dismissed.push(id),
    },
  }));
}, 120_000);

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the card's gate

test("the card's gate: settled store, a person, not the org page, not a phone, no call, no draft, unsold", () => {
  const ok: card.OrgIntroCardFacts = { initialized: true, signedIn: true, onOrgPage: false, phone: false, callPhase: "idle", composerHasText: false, introSeen: false, upsellSeen: false };
  expect(card.orgIntroCardMayRise(ok)).toBe(true);
  const closed: Array<Partial<card.OrgIntroCardFacts>> = [
    { initialized: false }, { signedIn: false }, { onOrgPage: true }, { phone: true },
    { callPhase: "connected" }, { callPhase: "ringing_out" }, { callPhase: "connecting" },
    { composerHasText: true }, { introSeen: true }, { upsellSeen: true },
  ];
  for (const c of closed) expect(card.orgIntroCardMayRise({ ...ok, ...c })).toBe(false);

  // A composer with text, read from the page: a textarea, a text input, a rich editor.
  document.body.insertAdjacentHTML("beforeend", "<div id='c'><textarea></textarea><div contenteditable='true'></div></div>");
  expect(card.composerHasText(document)).toBe(false);
  document.querySelector("textarea")!.value = "  half a thought";
  expect(card.composerHasText(document)).toBe(true);
  document.querySelector("textarea")!.value = "";
  document.querySelector<HTMLElement>("[contenteditable]")!.textContent = "typing";
  expect(card.composerHasText(document)).toBe(true);
  document.getElementById("c")!.remove();

  // The card clears a composer on screen so a person can send under it: a
  // composer whose top sits 90px above the window's foot lifts the card
  // above it by that much plus the gap, less the toast's own offset.
  expect(card.composerLift(document, 800)).toBe(0);
  document.body.insertAdjacentHTML("beforeend", "<div id='composer' data-sv-composer></div>");
  const composer = document.getElementById("composer")!;
  composer.getBoundingClientRect = () => ({ top: 710, bottom: 800, height: 90, width: 600, left: 0, right: 600, x: 0, y: 710, toJSON() {} }) as DOMRect;
  expect(card.composerLift(document, 800)).toBe(800 - 32 - (710 - card.ORG_MEET_COMPOSER_GAP));
  composer.getBoundingClientRect = () => ({ top: 0, bottom: 0, height: 0, width: 0, left: 0, right: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  expect(card.composerLift(document, 800)).toBe(0);
  composer.remove();
});

// ---------------------------------------------------------------- the card, mounted

async function mountAnywhere() {
  const root = createRoot(document.getElementById("root")!);
  const render = () => act(async () => root.render(React.createElement(card.OrgIntroAnywhere)));
  await render();
  return { root, render };
}

/** Paint the raised toast's card into the page so its buttons can be pressed. */
async function paintToast(toastRoot: ReturnType<typeof createRoot>) {
  const t = fake.toasts[fake.toasts.length - 1];
  await act(async () => toastRoot.render(t.render(t.id)));
  return t;
}

test("the card rises once the page settles and Not now sells it", async () => {
  fake.reset();
  const { root } = await mountAnywhere();
  expect(fake.toasts.length).toBe(0);
  await sleep(card.ORG_MEET_SETTLE_MS + 150);
  expect(fake.toasts.map((t) => t.id)).toEqual([card.ORG_MEET_TOAST_ID]);
  const toastRoot = createRoot(document.getElementById("toast")!);
  await paintToast(toastRoot);
  expect(q("[data-org-meet] .rise-card-title")!.textContent).toBe(card.ORG_MEET_TITLE);
  expect(qa("[data-org-meet] .rise-card-copy").map((p) => p.textContent)).toEqual([...card.ORG_MEET_LINES]);
  expect(q("[data-org-meet] img")!.getAttribute("data-avatar")).toBe(intro.ORG_INTRO_HEAD_OF_PEOPLE);
  await act(async () => q<HTMLButtonElement>("[data-org-meet] [data-rise-later]")!.click());
  expect(fake.writes).toEqual([{ org_upsell_seen: true }]);
  expect(fake.dismissed).toEqual([card.ORG_MEET_TOAST_ID]);
  expect(fake.pushes).toEqual([]);
  // A swipe away answers the same way, once.
  fake.toasts[0].onDismiss?.();
  expect(fake.writes.length).toBe(1);
  await act(async () => { toastRoot.unmount(); root.unmount(); });
}, 120_000);

test("See it opens the org page and sells it; the gates hold it back", async () => {
  fake.reset();
  const { root } = await mountAnywhere();
  await sleep(card.ORG_MEET_SETTLE_MS + 150);
  const toastRoot = createRoot(document.getElementById("toast")!);
  await paintToast(toastRoot);
  await act(async () => q<HTMLButtonElement>("[data-org-meet] [data-rise-primary]")!.click());
  expect(fake.pushes).toEqual(["/org"]);
  expect(fake.writes).toEqual([{ org_upsell_seen: true }]);
  await act(async () => { toastRoot.unmount(); root.unmount(); });

  // Each gate alone keeps it down: a phone, a call, a draft on the page, the
  // org page itself, a person who has seen or been sold it, an unhydrated store.
  const holds: Array<() => void> = [
    () => { fake.phone = true; },
    () => { fake.state.call = { phase: "connected" }; },
    () => { document.body.insertAdjacentHTML("beforeend", "<textarea id='draft'>a reply in progress</textarea>"); },
    () => { fake.pathname = "/org"; },
    () => { fake.state.clientState.ui = { org_intro_seen: true }; },
    () => { fake.state.clientState.ui = { org_upsell_seen: true }; },
    () => { fake.state.clientStateInitialized = false; },
  ];
  for (const hold of holds) {
    fake.reset();
    hold();
    const m = await mountAnywhere();
    await sleep(card.ORG_MEET_SETTLE_MS + 150);
    expect(fake.toasts.length).toBe(0);
    await act(async () => m.root.unmount());
    document.getElementById("draft")?.remove();
  }
}, 120_000);
