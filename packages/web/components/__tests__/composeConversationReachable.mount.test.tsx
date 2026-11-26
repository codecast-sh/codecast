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
import { ConvexProvider } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

// ct-102058: a person writing a new session about something in the
// conversation behind the composer must be able to reach that conversation
// (copy a message's link, read it) without losing their place in the draft.
// Before the fix the center composer sat over a 95%-opaque full-screen
// backdrop, and a click on the conversation landed on it and asked Keep or
// Discard: to paste one link the person had to keep the draft, copy the link
// and reopen the draft.

const { loadComposeView } = await import("../../lib/composeViewLoader");
await loadComposeView();
const { ComposeHost } = await import("../ComposeHost");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const flush = async (ms = 20) => { await act(async () => { await tick(ms); }); };

function fakeConvex() {
  const client = offlineConvexClient("https://happy-otter-123.convex.cloud");
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

// The DOM here has no layout, so hit-testing is modeled: a full-viewport layer
// the compose host draws (fixed inset-0) that takes pointer events sits above
// the conversation and receives a click aimed at it.
function coveringLayers(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("*")].filter((el) => {
    const cls = typeof el.className === "string" ? el.className : "";
    return /\bfixed\b/.test(cls) && /\binset-0\b/.test(cls) && !/\bpointer-events-none\b/.test(cls);
  });
}
const opaque = (el: HTMLElement) => {
  const m = String(el.className).match(/\bbg-[\w-]+\/(\d+)\b/);
  return m ? Number(m[1]) >= 50 : /\bbg-sol-bg\b/.test(String(el.className));
};

test("with a draft typed, the conversation behind the composer stays reachable without a Keep/Discard prompt", async () => {
  useInboxStore.setState({ currentUser: { _id: "user_reach_test", name: "Tester" } as any, drafts: {}, sessions: {}, conversations: {}, composes: [] } as any);
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);

  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  let copied = 0;
  await act(() => root.render(
    <ConvexProvider client={fakeConvex()}>
      <main data-testid="conversation">
        <button type="button" onClick={() => { copied++; }}>Copy link to this message</button>
      </main>
      <div data-testid="compose-host"><ComposeHost /></div>
    </ConvexProvider>,
  ));
  await act(() => { useInboxStore.getState().openCompose(); });
  await flush(50);

  const host = container.querySelector<HTMLElement>("[data-testid=compose-host]")!;
  const textarea = () => host.querySelector("textarea") as HTMLTextAreaElement | null;
  expect(textarea()).toBeTruthy();
  const draft = "the agent's reply here is wrong:";
  await act(() => { typeInto(textarea()!, draft); });
  await flush(50);

  const copyLink = container.querySelector<HTMLButtonElement>("[data-testid=conversation] button")!;
  // The conversation must be visible: no opaque full-screen layer over it.
  expect(coveringLayers(host).filter(opaque).map((el) => String(el.className))).toEqual([]);

  // Click where the message's "copy link" button is, at most twice (one click
  // may move the composer aside, e.g. dock it, before the conversation is hit).
  for (let i = 0; i < 2 && copied === 0; i++) {
    const target = coveringLayers(host).at(-1) ?? copyLink;
    await act(() => { target.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); });
    await flush(20);
    expect(host.querySelector("[role=alertdialog]")?.textContent ?? null).toBeNull();
  }
  expect(copied).toBe(1);

  // The same composer is still open with the draft intact.
  expect(useInboxStore.getState().composes.length).toBe(1);
  expect(textarea()?.value).toBe(draft);
  await act(() => root.unmount());
  container.remove();
}, 60_000);
