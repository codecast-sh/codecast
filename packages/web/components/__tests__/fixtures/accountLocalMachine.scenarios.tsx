import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { toast } from "sonner";
import { replaceGlobals } from "../../../test-helpers/globals";
import { useInboxStore } from "../../../store/inboxStore";
import { AccountHarness, createAccountClient, localDevice, otherDevice, seedAccounts } from "./accountLocalMachine";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const realFetch = globalThis.fetch;
const requests: string[] = [];
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let account: ReturnType<typeof createAccountClient>;
const settle = (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const mount = (identityOnly = false) => act(() => root.render(<AccountHarness client={account.client} identityOnly={identityOnly} />));
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text);
const hover = () => act(() => host.firstElementChild!.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })));
const cache = (deviceId = localDevice.device_id) => sessionStorage.setItem("cast_term_endpoint", JSON.stringify({ port: 45123, token: "local-fixture", deviceId, tmux: true }));
const reply = (_input: any, init: any) => {
  const authorization = new Headers(init?.headers).get("Authorization")!;
  requests.push(authorization);
  return Response.json(authorization === "Bearer local-fixture" ? { tmux: true, sessions: [] } : {}, { status: authorization === "Bearer local-fixture" ? 200 : 401 });
};
beforeEach(async () => {
  await act(() => seedAccounts());
  localStorage.clear(); sessionStorage.clear(); requests.length = 0;
  account = createAccountClient();
  globalThis.fetch = (async (input, init) => reply(input, init)) as typeof fetch;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); globalThis.fetch = realFetch; });
afterAll(() => { dom.window.close(); restore(); });

test("two online Macs sharing a port: authenticate local before showing controls, then route sign-in and relaunch locally", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => release = resolve);
  globalThis.fetch = (async (input, init) => { await held; return reply(input, init); }) as typeof fetch;
  await mount();
  expect(host.textContent).toBe("accounts");
  await hover();
  expect(button("sign in again")).toBeUndefined();
  await settle(450);
  await act(async () => { release(); await held; });
  await settle();
  await hover();
  expect(host.textContent).toContain(localDevice.label);
  expect(host.textContent).not.toContain("other@example.com");
  expect(requests).toEqual(["Bearer other-fixture", "Bearer local-fixture"]);
  await act(() => button("sign in again")!.click());
  expect(account.mutations.at(-1)).toEqual({ name: "accountSwitch:requestLoginFlow", args: { device_id: "local-mac", profile: "local" } });
  expect(host.textContent).toContain(`sign-in pending on ${localDevice.label}`);
  const notice = toast.getHistory().at(-1)!;
  expect(notice.title).toBe(`Sign-in requested on ${localDevice.label}`);
  expect(notice.type).not.toBe("success");
  await act(() => seedAccounts([localDevice, otherDevice]));
  await act(() => button("relaunch")!.click());
  expect(account.mutations.at(-1)).toEqual({ name: "accountSwitch:requestLoginFlow", args: { device_id: "local-mac", profile: "local", force: true } });
});

test("account switching and recovery changes use the same local target", async () => {
  cache(); await mount(); await settle(); await hover();
  await act(() => button("switch →")!.click());
  expect(account.mutations.at(-1)).toEqual({ name: "accountSwitch:requestAccountSwitch", args: { device_id: "local-mac", profile: "backup", continue_blocked: false } });
  await act(() => seedAccounts([otherDevice, { ...localDevice, active_email: "backup@example.com" }]));
  await act(() => button("Switch automatically")!.click());
  expect(account.mutations.at(-1)).toEqual({ name: "accountSwitch:setRecoveryMode", args: { device_id: "local-mac", mode: "auto" } });
});

test("offline local inventory stays visible without sign-in, mint or switch controls; reconnect never selects the other Mac", async () => {
  cache(); await mount(); await settle(); await hover();
  await act(() => { account.connect(false); seedAccounts([otherDevice, { ...localDevice, online: false }]); });
  expect(host.textContent).toContain(localDevice.label);
  expect(button("sign in again")).toBeUndefined();
  expect(button("mint token")).toBeUndefined();
  expect(button("switch →")).toBeUndefined();
  await act(() => { account.connect(true); seedAccounts(); });
  await settle();
  expect(host.textContent).toContain(localDevice.label);
  expect(button("sign in again")).toBeDefined();
});

test("failed discovery leaves settings available and focus retries without overlapping probes", async () => {
  globalThis.fetch = (async () => Response.json({}, { status: 401 })) as typeof fetch;
  await mount(); await settle(450);
  expect(host.textContent).toBe("accounts");
  await act(() => button("accounts")!.click());
  expect(useInboxStore.getState().settingsModalSection).toBe("claude-accounts");
  cache();
  let release!: () => void;
  const held = new Promise<void>(resolve => release = resolve);
  let probes = 0;
  globalThis.fetch = (async (input, init) => { probes++; await held; return reply(input, init); }) as typeof fetch;
  await act(() => { window.dispatchEvent(new dom.window.Event("focus")); window.dispatchEvent(new dom.window.Event("online")); });
  expect(probes).toBe(1);
  await act(async () => { release(); await held; }); await settle();
  expect(host.textContent).toBe("local");
});

test("signed-out and changed viewers cannot receive a stale discovery result", async () => {
  seedAccounts([], null); await mount(true);
  expect(host.textContent).toBe("unresolved");
  expect(account.mutations).toHaveLength(0);
  cache();
  let release!: () => void;
  const held = new Promise<void>(resolve => release = resolve);
  globalThis.fetch = (async (input, init) => { await held; return reply(input, init); }) as typeof fetch;
  await act(() => seedAccounts());
  await act(() => { account.connect(false); seedAccounts([otherDevice], "viewer-two"); });
  await act(async () => { release(); await held; }); await settle();
  expect(host.textContent).toBe("unresolved");
});

test("terminal development overrides do not stand in for a real local device", async () => {
  localStorage.setItem("CAST_TERM_ENDPOINT", "45123:fixture");
  await mount(true); await settle();
  expect(host.textContent).toBe("unresolved");
  expect(requests).toHaveLength(0);
});


test("a cold disconnected mount waits for connection before discovering the local machine", async () => {
  account.connect(false); cache();
  await mount(true);
  expect(host.textContent).toBe("unresolved");
  expect(requests).toHaveLength(0);
  await act(() => account.connect(true)); await settle();
  expect(host.textContent).toBe("local-mac");
});

test("inventory arriving after mount is resolved locally and disappearing inventory never falls back", async () => {
  useInboxStore.setState({ settingsData: {} }); cache();
  await mount();
  expect(host.textContent).toBe("accounts");
  expect(requests).toHaveLength(0);
  await act(() => seedAccounts()); await settle();
  expect(host.textContent).toBe("local");
  await act(() => seedAccounts([otherDevice]));
  expect(host.textContent).toBe("accounts");
});

test("an unavailable local daemon is discovered by the scheduled retry without a browser event", async () => {
  const schedule = globalThis.setTimeout;
  let retry: (() => void) | undefined;
  globalThis.setTimeout = ((callback: () => void, delay: number, ...args: any[]) => {
    const timer = schedule(callback, delay, ...args);
    if (delay === 30_000) retry = () => { clearTimeout(timer); callback(); };
    return timer;
  }) as typeof setTimeout;
  try {
    globalThis.fetch = (async () => Response.json({}, { status: 401 })) as typeof fetch;
    await mount(true); await settle(450);
    expect(host.textContent).toBe("unresolved");
    expect(retry).toBeDefined();
    cache();
    globalThis.fetch = (async (input, init) => reply(input, init)) as typeof fetch;
    await act(() => retry!()); await settle();
    expect(host.textContent).toBe("local-mac");
  } finally {
    globalThis.setTimeout = schedule;
  }
});
