import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";
import type { VaultInfo } from "@codecast/shared/contracts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useVaultStore } = await import("../../../../store/vaultStore");
const { VaultMachineBar } = await import("../VaultMachineBar");
const { subscribeVaultEvents } = await import("../../client");
const routes = await import("../routes");

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send() {}
  close() {
    this.onclose?.();
  }
}

const initial = useVaultStore.getState();
const originalWs = globalThis.WebSocket;
const local = { port: 40001, token: "local", deviceId: "laptop", tmux: true };
const host = { port: 45001, token: "host", deviceId: "cloud", tmux: true };
const reopened = { port: 45002, token: "host", deviceId: "cloud", tmux: true };
const hostVaultId = routes.hostVaultId("h-app", "cloud");
const hostApp: VaultInfo = { id: hostVaultId, root: "/home/ubuntu/work/app", name: "app", added_at: 1 };
let reachable: boolean;
let asked: number;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  routes._resetHostRoutesForTests();
  routes.setLocalEndpoint(local);
  routes.setHostEndpoint("cloud", host);
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  reachable = false;
  asked = 0;
  // The relay as the store's establisher sees it: a forward, or nothing.
  routes.setHostEstablisher(async () => (asked++, reachable ? reopened : null));
  useVaultStore.setState({
    ...initial,
    connection: "connected",
    endpoint: host,
    localEndpoint: local,
    vaults: [hostApp],
    activeVaultId: hostVaultId,
    hostStates: { cloud: "connected" },
    hostFallback: null,
    remoteVaults: [],
    isRemote: false,
    // As the store's own: reopen through the routes, then settle the state.
    connectHost: async (deviceId: string) => {
      const ep = await routes.reestablishHost(deviceId);
      useVaultStore.setState((s) => ({ hostStates: { ...s.hostStates, [deviceId]: ep ? "connected" : "unreachable" } }));
      return ep ? "host" : "unreachable";
    },
  }, true);
});

afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = null;
  useVaultStore.setState(initial, true);
  routes._resetHostRoutesForTests();
  globalThis.WebSocket = originalWs;
});
afterAll(() => {
  restoreGlobals();
  closeDomWindow(dom);
});

async function mountBar() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root!.render(<VaultMachineBar activePath="src/a.ts" onNavigate={() => {}} />));
  return container;
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

test("a live host's segment is a plain label, not a button", async () => {
  const bar = await mountBar();
  expect(bar.querySelector("[data-reconnect-host]")).toBeNull();
  expect(bar.querySelector('[aria-current="true"]')?.tagName).toBe("SPAN");
});

test("an unreachable host's segment is the reconnect button, and pressing it brings the parked socket back", async () => {
  const dispose = subscribeVaultEvents(host, hostVaultId, { onEvent: () => {} });
  expect(FakeSocket.all).toHaveLength(1);
  const bar = await mountBar();
  // The forward drops and the host does not answer: the socket parks.
  await act(async () => {
    FakeSocket.all[0].onclose?.();
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(() => useVaultStore.setState((s) => ({ hostStates: { ...s.hostStates, cloud: "unreachable" } })));
  expect(asked).toBe(1);
  expect(FakeSocket.all).toHaveLength(1);

  const button = bar.querySelector<HTMLButtonElement>("[data-reconnect-host]");
  expect(button).not.toBeNull();
  expect(button!.querySelector('[aria-label="Not reachable"]')).not.toBeNull();

  reachable = true;
  await act(async () => button!.click());
  await flush();
  expect(asked).toBe(2);
  expect(useVaultStore.getState().hostStates.cloud).toBe("connected");
  // The socket followed the new forward without anything else being touched.
  expect(FakeSocket.all).toHaveLength(2);
  expect(FakeSocket.all[1].url).toBe(`ws://127.0.0.1:${reopened.port}/vault/ws`);
  // Live again: back to a label.
  expect(bar.querySelector("[data-reconnect-host]")).toBeNull();
  dispose();
});
