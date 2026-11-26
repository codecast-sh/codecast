import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, FocusEvent: dom.window.FocusEvent, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
// The app's own link, forced for the one scenario that drops it; every other
// scenario reads the real hook. This file runs in a process of its own.
const realOffline = { ...(await import("../../../hooks/useAppOffline")) };
let forcedOffline: ReturnType<typeof realOffline.useAppOffline> | null = null;
mock.module("../../../hooks/useAppOffline", () => ({
  ...realOffline,
  useAppOffline: () => { const real = realOffline.useAppOffline(); return forcedOffline ?? real; },
}));
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
// The pill's text is the short state alone; the machine and the full label
// live on its aria-label (and in its hover panel), so scoping is read there.
const pillLabel = (scope: string) => host.querySelector(`${scope} [data-daemon-pill]`)?.getAttribute("aria-label");
const pillShape = (scope: string) => host.querySelector(`${scope} [data-daemon-pill]`)?.getAttribute("data-daemon-pill");
const globalPill = () => pillLabel("[data-global]");
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
afterEach(async () => { await act(() => root.unmount()); host.remove(); globalThis.fetch = realFetch; forcedOffline = null; });
afterAll(() => { Date.now = realNow; dom.window.close(); restore(); });

test("two physical Macs: only the authenticated local daemon affects global notices", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => release = resolve);
  globalThis.fetch = (async (input, init) => { await held; return healthProbe(input, init); }) as typeof fetch;
  await mount();
  expect(globalPill()).toBeUndefined();
  expect(syncLabel()).toBeUndefined();
  await settle(450);
  await act(async () => { release(); await held; }); await settle();
  expect(globalPill()).toBeUndefined();
  expect(syncLabel()).toBeUndefined();
  expect(useStatusNoticeStore.getState().notices.size).toBe(0);
  expect(pillLabel('[data-session="mini"]')).toContain("Mac-mini: daemon quiet");
  expect(sessionText("mini")).toContain("quiet");
  expect(pillLabel('[data-session="cloud"]')).toContain("Cloud Linux: daemon stale");
  expect(sessionText("laptop")).toBe("Session delivery controls");
  expect(sessionText("missing")).toBe("Session delivery controls");
  expect(sessionText("unassigned")).toBe("Session delivery controls");
  await act(() => useInboxStore.getState().setMachineRoster(healthRows(Date.now()).reverse()));
  expect(syncLabel()).toBeUndefined();
});

test("local quiet, offline, overloaded, stalled and draining states surface and recover", async () => {
  cache(); await mount(); await settle();
  const rows = healthRows(Date.now());
  const update = (patch: object) => act(() => useInboxStore.getState().setMachineRoster(rows.map(d => d.device_id === "laptop" ? { ...d, ...patch } : d)));
  await update({ last_seen: Date.now() - 8 * 60_000 });
  expect(globalPill()).toContain("MacBook: daemon quiet 8 min");
  expect(pillShape("[data-global]")).toBe("pill");
  expect(globalText()).toContain("quiet 8 min");
  expect(syncLabel()).toBe("Sync status: daemon quiet 8 min");
  expect(sessionText("laptop")).toContain("Delivery delayed");
  expect(host.querySelector('[data-session="laptop"] button')?.textContent).toBe("cast status");
  await update({ last_seen: Date.now() - 2 * 3_600_000 });
  expect(globalText()).toContain("CLI on macOS - MacBook offline for 2h.");
  expect(useStatusNoticeStore.getState().notices.size).toBe(1);
  await update({ loop_freeze_ms: 40_000 });
  expect(globalPill()).toContain("MacBook: daemon under load");
  expect(pillShape("[data-global]")).toBe("pill");
  expect(syncLabel()).toBe("Sync status: daemon under load");
  expect(useStatusNoticeStore.getState().notices.size).toBe(0);
  // The hour record alone: nothing is late right now, so the header shows a
  // quiet glyph (no pill text) and the sync dot stops pulsing.
  await update({ loop_freeze_1h_ms: 150_000, loop_freeze_max_ms: 40_000 });
  expect(globalText()).not.toContain("load");
  expect(globalPill()).toBe("macOS - MacBook: daemon under load");
  expect(pillShape("[data-global]")).toBe("quiet");
  expect(syncLabel()).toBe("Sync status: daemon under load");
  expect(host.querySelector('[aria-label^="Sync status:"] .animate-ping')).toBeNull();
  await update({ pending_sync_count: 27, pending_sync_conversations: 27, oldest_pending_ms: 360_000 });
  expect(syncLabel()).toBe("Sync status: sync stalled · 27 conversations");
  await update({ pending_sync_count: 12, pending_sync_messages: 904, oldest_pending_ms: 540_000, sync_no_progress_ms: 20_000 });
  expect(syncLabel()).toBe("Sync status: syncing · 904 messages");
  await update({});
  expect(globalPill()).toBeUndefined();
  expect(syncLabel()).toBeUndefined();
});

test("a cut-off app blames its own link for a waiting message, not the daemon", async () => {
  cache(); await mount(); await settle();
  const rows = healthRows(Date.now());
  const quiet = (min: number) => act(() => useInboxStore.getState().setMachineRoster(rows.map(d => d.device_id === "laptop" ? { ...d, last_seen: Date.now() - min * 60_000 } : d)));
  await quiet(7);
  expect(sessionText("laptop")).toContain("Delivery delayed");
  // The link drops: the roster stops moving, so the same daemon reads quieter
  // by the minute while it is beating normally on the far side.
  forcedOffline = { offline: true, online: true };
  await quiet(8);
  expect(sessionText("laptop")).toContain("Server unreachable");
  expect(sessionText("laptop")).toContain("your message is kept");
  expect(sessionText("laptop")).not.toContain("Delivery delayed");
  expect(sessionText("laptop")).not.toContain("daemon");
  expect(host.querySelector('[data-session="laptop"] [data-testid="pending-message-app-offline"]')).not.toBeNull();
  forcedOffline = { offline: true, online: false };
  await quiet(9);
  expect(sessionText("laptop")).toContain("Offline");
  expect(sessionText("laptop")).toContain("no network");
  // Back on the wire: the roster is live again and the daemon is judged on it.
  forcedOffline = null;
  await quiet(0);
  expect(sessionText("laptop")).toBe("Session delivery controls");
});

test("missing identity, missing local row, empty roster and changed viewer never borrow another daemon", async () => {
  globalThis.fetch = (async () => Response.json({}, { status: 401 })) as typeof fetch;
  await mount(); await settle(450);
  expect(globalPill()).toBeUndefined();
  expect(syncLabel()).toBeUndefined();
  cache(); globalThis.fetch = healthProbe as typeof fetch;
  await act(() => window.dispatchEvent(new dom.window.Event("focus"))); await settle();
  await act(() => useInboxStore.getState().setMachineRoster(healthRows(Date.now()).filter(d => d.device_id !== "laptop")));
  expect(globalPill()).toBeUndefined();
  expect(syncLabel()).toBeUndefined();
  await act(() => useInboxStore.getState().setMachineRoster([]));
  expect(globalPill()).toBeUndefined();
  await act(() => {
    localStorage.setItem("CAST_TERM_FORCE_RELAY", "1");
    useInboxStore.setState({ currentUser: { _id: "another-viewer", daemon_last_seen: Date.now() - 3_600_000 } as any, machineRoster: healthRows(Date.now()).map(d => ({ ...d, last_seen: Date.now() - 3_600_000 })) });
  });
  expect(globalPill()).toBeUndefined();
  expect(useStatusNoticeStore.getState().notices.size).toBe(0);
});

test("a cloud host within 30 minutes of its run limit says so beside its session, and not before or after", async () => {
  await mount(); await settle();
  const runLimit = (runEndsAt?: number, patch: object = {}) => act(() => useInboxStore.setState({
    machineRosterLive: true,
    machineRoster: healthRows(Date.now()).map(d => d.device_id === "cloud"
      ? { ...d, is_remote: true, online: true, last_seen: Date.now() - 1_000, host_readiness: { at: Date.now(), ...(runEndsAt ? { run_ends_at: runEndsAt } : {}) }, ...patch }
      : d),
  } as any));
  const chip = () => host.querySelector('[data-session="cloud"] [data-host-run-limit]')?.getAttribute("aria-label");
  const inMinutes = (m: number) => Date.now() + m * 60_000 + 30_000;
  await runLimit(inMinutes(25));
  expect(chip()).toBe("stops in 25 min · run limit");
  expect(sessionText("laptop")).toBe("Session delivery controls");
  await runLimit(inMinutes(5));
  expect(chip()).toBe("stops in 5 min · run limit");
  await runLimit(inMinutes(31));
  expect(chip()).toBeUndefined();
  await runLimit(Date.now() - 60_000);
  expect(chip()).toBeUndefined();
  await runLimit(undefined);
  expect(chip()).toBeUndefined();
  await runLimit(inMinutes(25), { last_seen: Date.now() - 2 * 3_600_000, online: false });
  expect(chip()).toBeUndefined();
  await runLimit(inMinutes(25), { is_remote: false });
  expect(chip()).toBeUndefined();
});

// ct-102051: the offline panel's Copy lands on the clipboard of the machine
// running this browser, so its command row must say which machine the command
// is for: the owner by name, and whether that is this browser's machine only
// when the app actually knows.
describe("offline panel names the machine to run the command on", () => {
  const offline = (deviceId: string) => act(() => useInboxStore.getState().setMachineRoster(
    healthRows(Date.now()).map(d => d.device_id === deviceId ? { ...d, online: false, last_seen: Date.now() - 2 * 3_600_000 } : d),
  ));
  // Opens the pill's hover panel and returns its command row (the button that
  // holds the copyable command) plus the pill's own aria-label.
  const openPanel = async (scope: string) => {
    const pill = host.querySelector(`${scope} [data-daemon-pill]`) as HTMLElement | null;
    expect(pill).not.toBeNull();
    await act(() => { pill!.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })); pill!.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true })); });
    await settle(400);
    const code = [...document.querySelectorAll("code")].find(c => c.textContent === "cast restart");
    expect(code, "the hover panel with the cast restart row should be open").toBeDefined();
    const row = code!.closest("button")!;
    return { row: `${row.textContent ?? ""} ${row.getAttribute("aria-label") ?? ""}`, pill: pill!.getAttribute("aria-label") ?? "" };
  };

  test("session chip, owner known to be another machine: the command row says to run it on the owner, not here", async () => {
    cache(); await mount(); await settle();
    await offline("mini");
    const { row, pill } = await openPanel('[data-session="mini"]');
    expect(row).toContain("Mac-mini");
    expect(row.toLowerCase()).toMatch(/not this (machine|browser)|another machine|different machine|not on this/);
    expect(pill).toContain("Mac-mini");
  });

  test("session chip, this browser's machine unknown: the row names the owner and claims neither here nor elsewhere", async () => {
    globalThis.fetch = (async () => Response.json({}, { status: 401 })) as typeof fetch;
    await mount(); await settle(450);
    await offline("mini");
    const { row } = await openPanel('[data-session="mini"]');
    expect(row).toContain("Mac-mini");
    expect(row.toLowerCase()).not.toContain("this machine");
    expect(row.toLowerCase()).not.toMatch(/another machine|different machine|not this/);
  });

  test("header chip: the command row says the command is for this machine, by name", async () => {
    cache(); await mount(); await settle();
    await offline("laptop");
    const { row } = await openPanel("[data-global]");
    expect(row.toLowerCase()).toContain("this machine");
    expect(row).toContain("MacBook");
    expect(row.toLowerCase()).not.toMatch(/another machine|different machine|not this/);
  });
});
