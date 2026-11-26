// The color themes introduction (ThemeIntroAnywhere), mounted in jsdom.
//
// The card waits for an empty composer before it rises. It must also step
// aside once the person starts composing while it is already up (ct-101513):
// typing into a composer takes it down within a second, without answering it
// (theme_intro_seen stays unset, so it may rise again later).
//
// Run: bun test --timeout 120000 components/theme/ThemeIntroAnywhere.mount.test.tsx
import { test, expect, beforeAll, afterAll, mock } from "bun:test";

const realInboxStore = { ...(await import("../../store/inboxStore")) };
afterAll(() => { mock.module("../../store/inboxStore", () => realInboxStore); });

let React: typeof import("react");
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let mod: typeof import("./ThemeIntroAnywhere");
let ORG_MEET_SETTLE_MS: number;

type Ui = { theme_intro_seen?: boolean };
const fake = {
  state: { clientStateInitialized: true, currentUser: { _id: "u1", cli_last_seen: Date.now() } as any, clientState: { ui: {} as Ui }, call: { phase: "idle" }, tour: null, updateClientUI(p: Ui) { Object.assign(fake.state.clientState.ui, p); fake.writes.push({ ...p }); } },
  writes: [] as Ui[],
  toasts: [] as Array<{ id: string; render: (id: string) => React.ReactElement; onDismiss?: () => void }>,
  dismissed: [] as string[],
};

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLTextAreaElement", "HTMLInputElement", "Element", "Node", "Event", "InputEvent", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    const v = (dom.window as any)[key];
    if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
  }
  if (!(globalThis as any).ResizeObserver) (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  act = React.act;
  ({ createRoot } = await import("react-dom/client"));
  mod = await import("./ThemeIntroAnywhere");
  ({ ORG_MEET_SETTLE_MS } = await import("../../lib/orgIntroCard"));
  mock.module("../../store/inboxStore", () => ({
    ...realInboxStore,
    useInboxStore: Object.assign(
      (selector: (state: unknown) => unknown) => selector(fake.state),
      realInboxStore.useInboxStore,
      { getState: () => fake.state },
    ),
    useTrackedStore: () => fake.state,
  }));
  mock.module("next/navigation", () => ({ usePathname: () => "/inbox", useRouter: () => ({ push: () => {}, replace: () => {} }) }));
  mock.module("../../hooks/useIsPhone", () => ({ useIsPhone: () => false, useMinWidth: () => true }));
  mock.module("../../lib/cliConnected", () => ({ cliNeverConnected: () => false }));
  mock.module("sonner", () => ({
    toast: {
      custom: (render: (id: string) => React.ReactElement, opts: { id: string; onDismiss?: () => void }) => { fake.toasts.push({ id: opts.id, render, onDismiss: opts.onDismiss }); return opts.id; },
      dismiss: (id: string) => { fake.dismissed.push(id); fake.toasts = fake.toasts.filter((t) => t.id !== id); },
      getToasts: () => fake.toasts.map((t) => ({ id: t.id })),
    },
  }));
}, 120_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a card already up goes down once the person starts composing, without being answered", async () => {
  const root = createRoot(document.getElementById("root")!);
  const { MemoryRouter } = await import("react-router");
  await act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(mod.ThemeIntroAnywhere))));

  // The page settles and the card rises over an empty composer.
  await sleep(ORG_MEET_SETTLE_MS + 1200 + 150);
  expect(fake.toasts.map((t) => t.id)).toEqual(["theme-intro"]);

  // The person starts composing.
  document.body.insertAdjacentHTML("beforeend", "<textarea id='composer'></textarea>");
  const ta = document.getElementById("composer") as HTMLTextAreaElement;
  ta.value = "half a thought";
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  await act(async () => { await sleep(1100); });

  // Within a second the card has stepped aside, and nothing marked it seen.
  expect(fake.dismissed).toContain("theme-intro");
  expect(fake.writes.filter((w) => "theme_intro_seen" in w)).toEqual([]);

  await act(async () => root.unmount());
  ta.remove();
}, 120_000);
