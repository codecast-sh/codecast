// Mounts ConnectionBanner + StatusNoticeStack against a disconnected Convex
// client. A dropped socket while the OS is online must not raise the
// Reconnecting card (the header LED carries that). An OS-offline after the
// grace period still raises Offline.
// Run: bun test components/ConnectionBanner.mount.test.tsx
import { afterEach, describe, expect, jest, test } from "bun:test";

describe("ConnectionBanner", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("a dropped socket with OS online publishes no card; OS offline does", async () => {
    jest.useFakeTimers();
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
    for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
      Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
    }
    Object.defineProperty(dom.window.navigator, "onLine", { configurable: true, get: () => online });
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

    let online = true;
    const client = {
      connectionState: () => ({ isWebSocketConnected: false }),
      subscribeToConnectionState: () => () => {},
    };

    const React = await import("react");
    const { ConvexProvider } = await import("convex/react");
    const { createRoot } = await import("react-dom/client");
    const { act } = React;
    const { ConnectionBanner } = await import("./ConnectionBanner");
    const { StatusNoticeStack } = await import("./StatusNoticeStack");
    const { useStatusNoticeStore } = await import("../hooks/useStatusNotice");
    const { DISCONNECT_GRACE_MS } = await import("../hooks/useAppOffline");

    const root = createRoot(document.getElementById("root")!);
    await act(async () => {
      root.render(
        React.createElement(ConvexProvider, { client: client as any },
          React.createElement(StatusNoticeStack),
          React.createElement(ConnectionBanner),
        ),
      );
    });

    expect(document.body.textContent).not.toContain("Reconnecting");
    expect(useStatusNoticeStore.getState().notices.size).toBe(0);

    await act(async () => {
      jest.advanceTimersByTime(DISCONNECT_GRACE_MS + 50);
    });
    expect(document.body.textContent).not.toContain("Reconnecting");
    expect(useStatusNoticeStore.getState().notices.has("connection")).toBe(false);

    online = false;
    await act(async () => {
      window.dispatchEvent(new dom.window.Event("offline"));
      jest.advanceTimersByTime(DISCONNECT_GRACE_MS + 50);
    });
    expect(document.body.textContent).toContain("Offline");
    expect(document.body.textContent).toMatch(/cached/i);
    expect(document.body.textContent).not.toContain("Reconnecting");

    await act(async () => root.unmount());
    useStatusNoticeStore.getState().set("connection", null);
    dom.window.close();
  });
});
