import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { DaemonHealthHarness, daemonHealthClient, seedDaemonHealth, healthRows, healthProbe } = await import("./daemonHealth");
const { useInboxStore } = await import("../../../store/inboxStore");
const { useStatusNoticeStore } = await import("../../../hooks/useStatusNotice");
const realNow = Date.now;
const realFetch = globalThis.fetch;
const now = realNow();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const client = daemonHealthClient();
const settle = (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const globalText = () => host.querySelector("[data-global]")!.textContent;
const syncLabel = () => host.querySelector('[aria-label^="Sync status:"]')?.getAttribute("aria-label");
const sessionText = (id: string) => host.querySelector(`[data-session="${id}"]`)!.textContent;
const cache = (deviceId = "laptop") => sessionStorage.setItem("cast_term_endpoint", JSON.stringify({ port: 45123, token: "laptop", deviceId, tmux: true }));
const mount = async () => {
  await act(() => root.render(<DaemonHealthHarness client={client} />));
  await act(() => {
    Date.now = () => now + 61_000;
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
  });
};
beforeEach(() => {
  seedDaemonHealth(); localStorage.clear(); sessionStorage.clear();
  globalThis.fetch = healthProbe as typeof fetch;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); globalThis.fetch = realFetch; });
afterAll(() => { Date.now = realNow; dom.window.close(); restore(); });

test("two physical Macs: only the authenticated local daemon affects global notices", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => release = resolve);
  globalThis.fetch = (async (input, init) => { await held; return healthProbe(input, init); }) as typeof fetch;
  await mount();
  expect(globalText()).not.toContain("daemon");
  expect(syncLabel()).toBe("Sync status: Up to date");
  await settle(450);
  await act(async () => { release(); await held; }); await settle();
  expect(globalText()).not.toContain("daemon");
  expect(syncLabel()).toBe("Sync status: Up to date");
  expect(useStatusNoticeStore.getState().notices.size).toBe(0);
  expect(sessionText("mini")).toContain("Mac-mini: daemon quiet");
  expect(sessionText("cloud")).toContain("Cloud Linux: daemon stale");
  expect(sessionText("laptop")).toBe("Session delivery controls");
  expect(sessionText("missing")).toBe("Session delivery controls");
  expect(sessionText("unassigned")).toBe("Session delivery controls");
  await act(() => useInboxStore.getState().setMachineRoster(healthRows(Date.now()).reverse()));
  expect(syncLabel()).toBe("Sync status: Up to date");
});

test("local quiet, offline, overloaded, stalled and draining states surface and recover", async () => {
  cache(); await mount(); await settle();
  const rows = healthRows(Date.now());
  const update = (patch: object) => act(() => useInboxStore.getState().setMachineRoster(rows.map(d => d.device_id === "laptop" ? { ...d, ...patch } : d)));
  await update({ last_seen: Date.now() - 8 * 60_000 });
  expect(globalText()).toContain("MacBook: daemon quiet 8 min");
  expect(syncLabel()).toBe("Sync status: daemon quiet 8 min");
  expect(sessionText("laptop")).toContain("Delivery delayed");
  expect(host.querySelector('[data-session="laptop"] button')?.textContent).toBe("cast status");
  await update({ last_seen: Date.now() - 2 * 3_600_000 });
  expect(globalText()).toContain("CLI on macOS - MacBook offline for 2h.");
  expect(useStatusNoticeStore.getState().notices.size).toBe(1);
  await update({ loop_freeze_ms: 40_000 });
  expect(syncLabel()).toBe("Sync status: daemon under load");
  expect(useStatusNoticeStore.getState().notices.size).toBe(0);
  await update({ pending_sync_count: 27, pending_sync_conversations: 27, oldest_pending_ms: 360_000 });
  expect(syncLabel()).toBe("Sync status: sync stalled · 27 conversations");
  await update({ pending_sync_count: 12, pending_sync_messages: 904, oldest_pending_ms: 540_000, sync_no_progress_ms: 20_000 });
  expect(syncLabel()).toBe("Sync status: syncing · 904 messages");
  await update({});
  expect(globalText()).not.toContain("daemon");
  expect(syncLabel()).toBe("Sync status: Up to date");
});

test("missing identity, missing local row, empty roster and changed viewer never borrow another daemon", async () => {
  globalThis.fetch = (async () => Response.json({}, { status: 401 })) as typeof fetch;
  await mount(); await settle(450);
  expect(globalText()).not.toContain("daemon");
  expect(syncLabel()).toBe("Sync status: Up to date");
  cache(); globalThis.fetch = healthProbe as typeof fetch;
  await act(() => window.dispatchEvent(new dom.window.Event("focus"))); await settle();
  await act(() => useInboxStore.getState().setMachineRoster(healthRows(Date.now()).filter(d => d.device_id !== "laptop")));
  expect(globalText()).not.toContain("daemon");
  expect(syncLabel()).toBe("Sync status: Up to date");
  await act(() => useInboxStore.getState().setMachineRoster([]));
  expect(globalText()).not.toContain("daemon");
  await act(() => {
    localStorage.setItem("CAST_TERM_FORCE_RELAY", "1");
    useInboxStore.setState({ currentUser: { _id: "another-viewer", daemon_last_seen: Date.now() - 3_600_000 } as any, machineRoster: healthRows(Date.now()).map(d => ({ ...d, last_seen: Date.now() - 3_600_000 })) });
  });
  expect(globalText()).not.toContain("daemon");
  expect(useStatusNoticeStore.getState().notices.size).toBe(0);
});
