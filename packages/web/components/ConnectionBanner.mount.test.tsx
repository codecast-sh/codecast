// Mounts ConnectionBanner + StatusNoticeStack against a fake Convex client.
// A dropped socket while the OS is online must not raise the Reconnecting
// card (the header LED carries that). An OS-offline after the grace period
// raises Offline. An OS flag stuck at offline while the socket stays up is
// stale, and the card must clear once the socket has outlived the server
// inactivity threshold.
// Run: bun test components/ConnectionBanner.mount.test.tsx
import { afterEach, describe, expect, jest, test } from "bun:test";

import { closeDomWindow } from "../test-helpers/domGlobals";

async function mountBanner(opts: { online: boolean; wsConnected: boolean }) {
  jest.useFakeTimers();
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  const state = { ...opts };
  Object.defineProperty(dom.window.navigator, "onLine", { configurable: true, get: () => state.online });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  const client = {
    connectionState: () => ({ isWebSocketConnected: state.wsConnected }),
    subscribeToConnectionState: () => () => {},
  };

  const React = await import("react");
  const { ConvexProvider } = await import("convex/react");
  const { createRoot } = await import("react-dom/client");
  const { act } = React;
  const { ConnectionBanner } = await import("./ConnectionBanner");
  const { StatusNoticeStack } = await import("./StatusNoticeStack");
  const { useStatusNoticeStore } = await import("../hooks/useStatusNotice");
  const timing = await import("../hooks/useAppOffline");

  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(ConvexProvider, { client: client as any },
        React.createElement(StatusNoticeStack),
        React.createElement(ConnectionBanner),
      ),
    );
  });

  const advance = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); });
  const setOnline = (online: boolean) => act(async () => {
    state.online = online;
    window.dispatchEvent(new dom.window.Event(online ? "online" : "offline"));
  });
  const unmount = async () => {
    await act(async () => root.unmount());
    useStatusNoticeStore.getState().set("connection", null);
    closeDomWindow(dom);
  };
  return { ...timing, advance, setOnline, unmount, notices: () => useStatusNoticeStore.getState().notices };
}

describe("ConnectionBanner", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("a dropped socket with OS online publishes no card; OS offline does", async () => {
    const t = await mountBanner({ online: true, wsConnected: false });

    expect(document.body.textContent).not.toContain("Reconnecting");
    expect(t.notices().size).toBe(0);

    await t.advance(t.DISCONNECT_GRACE_MS + 50);
    expect(document.body.textContent).not.toContain("Reconnecting");
    expect(t.notices().has("connection")).toBe(false);

    await t.setOnline(false);
    await t.advance(t.DISCONNECT_GRACE_MS + 50);
    expect(document.body.textContent).toContain("Offline");
    expect(document.body.textContent).toMatch(/cached/i);
    expect(document.body.textContent).not.toContain("Reconnecting");

    await t.unmount();
  });

  test("an OS flag stuck at offline yields to a socket that outlives the inactivity threshold", async () => {
    // 2026-09-21: the desktop app relaunched two seconds before en0 had an
    // address; Chromium latched "no network" and never re-read it, while the
    // Convex socket connected and synced. The card said Offline all evening.
    const t = await mountBanner({ online: false, wsConnected: true });

    await t.advance(t.DISCONNECT_GRACE_MS + 50);
    expect(document.body.textContent).toContain("Offline");

    await t.advance(t.STALE_OS_OFFLINE_MS + 50);
    expect(document.body.textContent).not.toContain("Offline");
    expect(t.notices().has("connection")).toBe(false);

    // A real outage later: the OS goes online first (a fresh verdict), then
    // offline for real, and the card returns after the grace.
    await t.setOnline(true);
    await t.setOnline(false);
    await t.advance(t.DISCONNECT_GRACE_MS + 50);
    expect(document.body.textContent).toContain("Offline");

    await t.unmount();
  });
});
