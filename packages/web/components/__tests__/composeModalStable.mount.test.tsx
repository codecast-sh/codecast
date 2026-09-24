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

// The Ctrl+N modal must stay painted while the person types: no keystroke may
// remount the backdrop or the frame (that replays their fade in) or hide the
// composer under a Suspense boundary (React sets display:none on it).

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

test("typing in the compose modal never remounts or hides the modal", async () => {
  useInboxStore.setState({ currentUser: { _id: "user_modal_test", name: "Tester" } as any, drafts: {}, sessions: {}, conversations: {} } as any);
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
  const { loadComposeView } = await import("../../lib/composeViewLoader");
  await loadComposeView();
  const { ComposeHost } = await import("../ComposeHost");

  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(
    <ConvexProvider client={fakeConvex()}>
      <ComposeHost />
    </ConvexProvider>,
  ));
  await act(() => { useInboxStore.getState().openCompose(); });
  await flush(50);

  const textarea = () => container.querySelector("textarea") as HTMLTextAreaElement | null;
  expect(textarea()).toBeTruthy();
  const backdrop = container.querySelector(".fixed.inset-0");
  const frame = container.querySelector("[data-flip-key]");
  expect(backdrop).toBeTruthy();
  expect(frame).toBeTruthy();

  const events: string[] = [];
  const mo = new w.MutationObserver((muts: any[]) => {
    for (const m of muts) {
      if (m.type === "childList") {
        for (const n of m.removedNodes) if (n === backdrop || n === frame || n.contains?.(frame) || n.contains?.(backdrop)) events.push("removed");
      } else if (m.attributeName === "style" && /display:\s*none/.test(m.target.getAttribute("style") ?? "")) {
        events.push(`hidden:${m.target.tagName}.${String(m.target.className).slice(0, 40)}`);
      }
    }
  });
  mo.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });

  let text = "";
  for (const ch of "the quick brown fox jumps over the lazy dog") {
    text += ch;
    await act(() => { typeInto(textarea()!, text); });
    await flush(5);
  }
  await flush(400);
  mo.disconnect();

  expect(events).toEqual([]);
  expect(container.querySelector(".fixed.inset-0")).toBe(backdrop);
  expect(container.querySelector("[data-flip-key]")).toBe(frame);
  expect(textarea()!.value).toBe(text);
  await act(() => root.unmount());
});
