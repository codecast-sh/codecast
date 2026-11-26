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

// Start on a milestone opens the new-session composer on its brief: plain
// text in the box for the person to edit (never the quoted block a
// notification reply's prefill draws), and the session it creates carries the
// priority, the milestone and the plan, so it is linked when it is created.

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const BRIEF = "pri-57, milestone: Deploy drops the eval job\nPlan: pl-1075\nRun `cast priorities show pri-57` for current detail.";
const START = { priority: "pri-57", priority_step: "s2", plan: "pl-1075" };

const flush = async (ms = 20) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

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

test("Start's brief is editable text in the composer, and the create links the milestone and plan", async () => {
  const calls: Array<{ action: string; args: any[] }> = [];
  useInboxStore.setState({ currentUser: { _id: "user_start_test", name: "Tester" } as any, drafts: {}, sessions: {}, conversations: {}, composes: [] } as any);
  (useInboxStore.getState() as any)._setDispatch(async (action: string, args: any[]) => {
    calls.push({ action, args });
    return undefined;
  });
  const { loadComposeView } = await import("../../lib/composeViewLoader");
  await loadComposeView();
  const { ComposeHost } = await import("../ComposeHost");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<ConvexProvider client={fakeConvex()}><ComposeHost /></ConvexProvider>));
  await act(() => { useInboxStore.getState().openCompose(BRIEF, { start: START }); });
  await flush(50);

  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.value).toBe(BRIEF);
  expect(container.querySelector("blockquote")).toBeNull();
  // The person edits it like anything they typed: the box holds the edit
  // through a render, so the draft is the composer's own state.
  await act(() => { typeInto(textarea, `${BRIEF}\nStart with the deploy script.`); });
  await flush(50);
  expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(`${BRIEF}\nStart with the deploy script.`);

  const stubId = (useInboxStore.getState() as any).composes[0].stubId as string;
  expect((useInboxStore.getState().sessions[stubId] as any)._start).toEqual(START);
  await act(async () => { await useInboxStore.getState().createSessionFromStub(stubId); });
  const create = calls.find((c) => c.action === "createSession");
  expect(create?.args[0]).toMatchObject({ session_id: stubId, ...START });

  await act(() => root.unmount());
  container.remove();
}, 60_000);
