import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, expect, mock, test } from "bun:test";

mock.module("sonner", () => ({
  toast: Object.assign(() => 1, { error: () => 1, info: () => 1, success: () => 1, warning: () => 1, dismiss: () => {}, loading: () => 1, custom: () => 1, promise: (p: any) => p }),
  Toaster: () => null,
}));
import * as navigation from "next/navigation";
mock.module("next/navigation", () => ({
  ...navigation,
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {}, back: () => {} }),
  usePathname: () => "/inbox",
  useSearchParams: () => new URLSearchParams(),
}));
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// Every character typed into a new-session composer belongs to the draft the
// instant it is typed. The composer's store write is debounced, so a dismissal
// right after the last keystroke used to read an empty draft, skip the keep
// prompt and prune the session with the text in it. In the app a dismissal
// over a draft asks keep or discard; the desktop palette window closes without
// asking, reopens onto the kept draft, and drops it only through Clear.

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const flush = async (ms = 20) => { await act(async () => { await tick(ms); }); };

function fakeConvex() {
  const client = new ConvexReactClient("https://happy-otter-123.convex.cloud", { skipConvexDeploymentUrlCheck: true } as any);
  (client as any).sync?.webSocketManager?.terminate?.();
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, value);
  const propsKey = Object.keys(el).find((k) => k.startsWith("__reactProps"));
  (el as any)[propsKey!]?.onChange?.({ target: el, currentTarget: el, nativeEvent: new w.Event("input") });
}


let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

function resetStore() {
  useInboxStore.setState({ currentUser: { _id: "user_draft_test", name: "Tester" } as any, drafts: {}, sessions: {}, conversations: {}, composes: [] } as any);
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
}

async function render(node: React.ReactNode) {
  container = w.document.createElement("div");
  w.document.body.appendChild(container);
  root = createRoot(container);
  await act(() => root!.render(<ConvexProvider client={fakeConvex()}>{node}</ConvexProvider>));
  await flush(50);
}

async function unmount() {
  await act(() => root!.unmount());
  container!.remove();
}

const textarea = () => container!.querySelector("textarea") as HTMLTextAreaElement;
const pressEscape = () => act(() => { w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });

async function mountAppCompose() {
  resetStore();
  const { loadComposeView } = await import("../../lib/composeViewLoader");
  await loadComposeView();
  const { ComposeHost } = await import("../ComposeHost");
  await render(<ComposeHost />);
  await act(() => { useInboxStore.getState().openCompose(); });
  await flush(50);
  expect(textarea()).toBeTruthy();
  return (useInboxStore.getState() as any).composes[0].stubId as string;
}

// The palette window's face: ComposeView with no onClose host.
async function mountPaletteCompose() {
  const { ComposeView } = await import("../ComposeView");
  await render(<ComposeView />);
  expect(textarea()).toBeTruthy();
}

const paletteStubId = () => Object.keys(useInboxStore.getState().sessions)[0];

test("app: Escape right after typing asks to keep the draft instead of dropping it", async () => {
  const stubId = await mountAppCompose();
  await act(() => { typeInto(textarea(), "half a thought"); });
  await pressEscape();
  await flush(5);

  expect(container!.querySelector("[role=alertdialog]")?.textContent).toContain("Keep this draft?");
  expect(useInboxStore.getState().drafts[stubId]?.draft_message).toBe("half a thought");
  await unmount();
}, 60_000);

test("app: closing the modal right after typing keeps the draft and its session", async () => {
  const stubId = await mountAppCompose();
  await act(() => { typeInto(textarea(), "do not lose me"); });
  await act(() => { useInboxStore.getState().closeCompose(); });
  await flush(5);

  const s = useInboxStore.getState();
  expect(s.drafts[stubId]?.draft_message).toBe("do not lose me");
  expect((s.sessions[stubId] as any)?._hasDraft).toBe(true);
  await unmount();
}, 60_000);

test("palette: Escape closes without asking, reopening restores the draft, Clear drops it", async () => {
  resetStore();
  await mountPaletteCompose();
  const stubId = paletteStubId();
  await act(() => { typeInto(textarea(), "half a thought"); });
  await pressEscape();
  await flush(5);
  expect(container!.querySelector("[role=alertdialog]")).toBeNull();
  await unmount();

  let s = useInboxStore.getState();
  expect(s.drafts[stubId]?.draft_message).toBe("half a thought");
  expect((s.sessions[stubId] as any)?._hasDraft).toBe(true);

  await mountPaletteCompose();
  expect(textarea().value).toBe("half a thought");
  expect(container!.textContent).toContain("draft restored");
  expect(Object.keys(useInboxStore.getState().sessions)).toEqual([stubId]);

  const clear = [...container!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "clear") as HTMLButtonElement;
  expect(clear).toBeTruthy();
  await act(() => { clear.click(); });
  await flush(5);
  expect(textarea().value).toBe("");
  expect(useInboxStore.getState().drafts[stubId]).toBeUndefined();
  await unmount();

  await mountPaletteCompose();
  expect(textarea().value).toBe("");
  expect(container!.textContent).not.toContain("draft restored");
  await unmount();
}, 60_000);
