// ct-97017: a message the daemon held with no terminal screen showed "Held:
// <reason>" as plain text beside Cancel, so the person could only discard it.
// The line now offers Send anyway, and the press ends the hold at once.
// Run: bun test components/conversation/__tests__/heldSendAnyway.mount.test.tsx
import { afterAll, expect, test } from "bun:test";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const CONV = "c".repeat(32);
let dom: any;

async function mount() {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { MemoryRouter } = await import("react-router");
  const { ConvexProvider } = await import("convex/react");
  const { heroConvexStub } = await import("../../../app/(marketing)/heroFly/convexStub");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (node: React.ReactNode) => React.act(() => {
    root.render(<ConvexProvider client={heroConvexStub}><MemoryRouter>{node}</MemoryRouter></ConvexProvider>);
  });
  return { React, render, host, unmount: () => React.act(() => root.unmount()) };
}

afterAll(() => { if (dom) closeDomWindow(dom); });

const heldRow = (hold: { hold_screen?: string }) => ({
  _id: CONV, conversation_id: CONV, message_id: "m".repeat(32), client_id: "client-1",
  created_at: Date.now(), status: "pending", content: "do this",
  hold_reason: "terminal input not confirmed: composer never showed the pasted payload", ...hold,
});

test("a hold with no screen offers Send anyway, and the press ends the hold at once", async () => {
  const m = await mount();
  const { useInboxStore } = await import("../../../store/inboxStore");
  const { UserPrompt } = await import("../blocks/turnBlocks");
  useInboxStore.setState({ pendingMessageStatus: { [CONV]: heldRow({}) } } as any);
  const real = useInboxStore.getState().retryPendingMessage;
  const calls: unknown[][] = [];
  useInboxStore.setState({ retryPendingMessage: (...args: Parameters<typeof real>) => { calls.push(args); return real(...args); } } as any);

  await m.render(<UserPrompt content="do this" timestamp={Date.now()} messageId="client-1" conversationId={CONV as any} isPending />);
  expect(m.host.querySelector("[data-testid=pending-message-held]")?.textContent).toContain("Held: terminal input not confirmed");
  const send = m.host.querySelector<HTMLButtonElement>("[data-testid=held-send-anyway]");
  expect(send?.textContent).toBe("Send anyway");

  await m.React.act(async () => { send!.dispatchEvent(new (dom.window as any).MouseEvent("click", { bubbles: true })); });
  expect(calls).toEqual([[CONV, { messageId: "m".repeat(32), clientId: "client-1", force: true }]]);
  expect(m.host.querySelector("[data-testid=pending-message-held]")).toBeNull();
  await m.unmount();
});

test("a hold with a screen keeps its terminal toggle and no inline Send anyway", async () => {
  const m = await mount();
  const { useInboxStore } = await import("../../../store/inboxStore");
  const { UserPrompt } = await import("../blocks/turnBlocks");
  useInboxStore.setState({ pendingMessageStatus: { [CONV]: heldRow({ hold_screen: "❯ 1. Deploy" }) } } as any);
  await m.render(<UserPrompt content="do this" timestamp={Date.now()} messageId="client-1" conversationId={CONV as any} isPending />);
  expect(m.host.querySelector("[data-testid=pending-message-held-screen-toggle]")).not.toBeNull();
  expect(m.host.querySelector("[data-testid=held-send-anyway]")).toBeNull();
  await m.unmount();
});
