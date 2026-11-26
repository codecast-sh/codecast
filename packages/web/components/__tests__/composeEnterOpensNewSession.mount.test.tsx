import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, expect, mock, test } from "bun:test";

const toasts: string[] = [];
const toastActions: Array<{ label: string; onClick: () => void }> = [];
const record = (kind: string) => (msg: any, opts?: any) => { toasts.push(`${kind}:${String(msg)}`); if (opts?.action) toastActions.push(opts.action); return 1; };
mock.module("sonner", () => ({
  toast: Object.assign(record("toast"), { error: record("error"), info: record("info"), success: record("success"), warning: record("warning"), dismiss: () => {}, loading: record("loading"), custom: record("custom"), promise: (p: any) => p }),
  Toaster: () => null,
}));
const pushes: string[] = [];
import * as navigation from "next/navigation";
mock.module("next/navigation", () => ({
  ...navigation,
  useRouter: () => ({ push: (h: string) => { pushes.push(h); }, replace: (h: string) => { pushes.push(h); }, prefetch: () => {}, back: () => {} }),
  usePathname: () => "/inbox",
  useSearchParams: () => new URLSearchParams(),
}));
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

const { loadComposeView } = await import("../../lib/composeViewLoader");
await loadComposeView();
const { ComposeHost } = await import("../ComposeHost");

// ct-101512: a person on /inbox opens the in-app "New session" popup, types
// their first message and presses plain Enter. The popup closes, and the new
// session must then be put in front of them (the main view moves onto the new
// conversation once its real id exists). Before the fix the popup closed and
// nothing else happened: the session was only a small row in the list, and the
// person spent minutes hunting for it.

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const REAL_ID = "jx70000000000000000000000newsess"; // 32 chars => isConvexId
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

async function sendFromPopup(mods: KeyboardEventInit, opts: { createDelayMs?: number; afterEnter?: () => void } = {}) {
  w.history.replaceState({}, "", "/inbox");
  useInboxStore.setState({
    currentUser: { _id: "user_enter_test", name: "Tester" } as any,
    drafts: {}, sessions: {}, conversations: {}, pendingMessages: {}, pendingSessionCreates: {}, composes: [],
    currentSessionId: null,
    recentProjects: [{ path: "/Users/me/proj" }],
  } as any);
  const calls: string[] = [];
  (useInboxStore.getState() as any)._setDispatch(async (action: string) => {
    calls.push(action);
    if (action === "createSession") {
      if (opts.createDelayMs) await tick(opts.createDelayMs);
      return REAL_ID;
    }
    return undefined;
  });

  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<ConvexProvider client={fakeConvex()}><ComposeHost /></ConvexProvider>));
  await act(() => { useInboxStore.getState().openCompose(); });
  await flush(50);
  const stubId = (useInboxStore.getState() as any).composes[0].stubId as string;
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea).toBeTruthy();

  await act(() => { typeInto(textarea, "start building sharing"); });
  await flush(20);
  await act(() => {
    textarea.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...mods }));
  });
  opts.afterEnter?.();
  // Wait for the send to commit and the create to resolve the real id.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !(calls.includes("createSession") && useInboxStore.getState().getConvexId?.(stubId))) await flush(20);
  await flush(200);

  // The send happened and the popup closed: this is the moment under test.
  expect(calls).toContain("createSession");
  expect(container.querySelector("textarea")).toBeNull();

  // The new session is in front of them: routed onto its conversation, or set
  // as the visible conversation in the store.
  const s = useInboxStore.getState() as any;
  const shown = pushes.some((h) => h.includes(REAL_ID) || h.includes(stubId))
    || [REAL_ID, stubId].includes(s.currentSessionId)
    || [REAL_ID, stubId].includes(s.pendingNavigateId);
  if (!shown) console.log(JSON.stringify(mods)); if (!shown) console.log("pushes", JSON.stringify(pushes), "currentSessionId", s.currentSessionId, "pendingNavigateId", s.pendingNavigateId, "toasts", JSON.stringify(toasts));
  await act(() => root.unmount());
  container.remove();
  return shown;
}

const reset = () => { pushes.length = 0; toasts.length = 0; toastActions.length = 0; };

test("plain Enter in the in-app new-session popup puts the new session in front of the person", async () => {
  reset();
  expect(await sendFromPopup({})).toBe(true);
  expect(pushes).toEqual([`/conversation/${REAL_ID}`]);
}, 60_000);

// Enter lands while the server create is still in flight: the popup closes at
// once, and the view moves onto the conversation when its real id arrives.
test("plain Enter with the create still in flight opens the session once its id resolves", async () => {
  reset();
  expect(await sendFromPopup({}, { createDelayMs: 300 })).toBe(true);
  expect(pushes).toEqual([`/conversation/${REAL_ID}`]);
}, 60_000);

// Cmd/Ctrl+Enter keeps the person where they were, and is never silent: a
// toast names the session and opens it.
test("Cmd/Ctrl+Enter keeps the person in place and names the session with an Open action", async () => {
  reset();
  expect(await sendFromPopup({ metaKey: true, ctrlKey: true })).toBe(false);
  expect(pushes).toEqual([]);
  expect(toasts).toContain("success:Started “start building sharing”");
  expect(toastActions.map((a) => a.label)).toEqual(["Open"]);
  toastActions[0]!.onClick();
  expect(pushes).toEqual([`/conversation/${REAL_ID}`]);
}, 60_000);

// The person moves to another view after Enter, before the id resolves: they
// are not pulled away, and get the same toast instead.
test("plain Enter, then moving elsewhere before the id resolves, toasts instead of pulling the person back", async () => {
  reset();
  expect(await sendFromPopup({}, { createDelayMs: 300, afterEnter: () => w.history.pushState({}, "", "/tasks") })).toBe(false);
  expect(pushes).toEqual([]);
  expect(toasts).toContain("success:Started “start building sharing”");
  toastActions[0]!.onClick();
  expect(pushes).toEqual([`/conversation/${REAL_ID}`]);
}, 60_000);
