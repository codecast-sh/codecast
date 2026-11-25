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
const { useVaultLocalPath } = await import("../../../../hooks/useVaultLocalPath");
const routes = await import("../routes");

const initial = useVaultStore.getState();
const originalFetch = globalThis.fetch;
const roots: ReturnType<typeof createRoot>[] = [];
const local = { port: 40001, token: "local", deviceId: "laptop", tmux: true };
const host = { port: 45001, token: "host", deviceId: "cloud", tmux: true };
const localApp: VaultInfo = { id: "l-app", root: "/Users/ada/src/app", name: "app", added_at: 1 };
const hostApp: VaultInfo = { id: "h-app", root: "/home/ubuntu/work/app", name: "app", added_at: 1 };
const hostPath = "/home/ubuntu/work/app/src/retry.ts";
let requests: { url: string; resolve: (r: Response) => void }[];
let selected: string[];
let mirrorsOpened: string[];
let reachable: boolean;

beforeEach(() => {
  routes._resetHostRoutesForTests();
  routes.setLocalEndpoint(local);
  requests = [];
  selected = [];
  mirrorsOpened = [];
  reachable = true;
  globalThis.fetch = ((input: string | URL | Request) => new Promise<Response>((resolve) => {
    requests.push({ url: String(input), resolve });
  })) as typeof fetch;
  useVaultStore.setState({
    ...initial,
    connection: "connected",
    endpoint: local,
    localEndpoint: local,
    vaults: [localApp],
    activeVaultId: localApp.id,
    scannedAt: 1,
    files: {},
    hostStates: {},
    hostFallback: null,
    remoteVaults: [],
    // The real connectHost asks the relay; here the forward opens at once.
    connectHost: async (deviceId: string) => {
      routes.setHostEndpoint(deviceId, reachable ? host : null);
      useVaultStore.setState((s) => ({ hostStates: { ...s.hostStates, [deviceId]: reachable ? "connected" : "unreachable" } }));
      return reachable ? "host" : "unreachable";
    },
    selectVault: async (id: string) => {
      selected.push(id);
      useVaultStore.setState({ activeVaultId: id, files: {}, scannedAt: null });
    },
    openRemoteVault: async (id: string) => {
      mirrorsOpened.push(id);
      useVaultStore.setState({ activeVaultId: id, isRemote: true });
    },
  }, true);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount());
  useVaultStore.setState(initial, true);
  routes._resetHostRoutesForTests();
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  restoreGlobals();
  closeDomWindow(dom);
});

async function mount(path: string, device: string | null) {
  const hrefs: string[] = [];
  const router = { replace: (href: string) => { hrefs.push(href); } };
  function Probe() {
    useVaultLocalPath(path, 12, router, device);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(() => root.render(<Probe />));
  return hrefs;
}

const answer = (i: number, body: unknown, status = 200) => act(async () => {
  requests[i].resolve(Response.json(body, { status }));
});
const port = (i: number) => Number(new URL(requests[i].url).port);
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

test("a path from a cloud host session opens the host's file through the forward, not the local checkout", async () => {
  const hrefs = await mount(hostPath, "cloud");
  await flush();
  expect(useVaultStore.getState().hostStates.cloud).toBe("connected");
  expect(requests).toHaveLength(1);
  expect(port(0)).toBe(host.port);
  expect(new URL(requests[0].url).searchParams.get("path")).toBe(hostPath);
  await answer(0, { vault: hostApp, rel: "src/retry.ts", entry: { path: "src/retry.ts", mtime: 1, size: 5 } });
  expect(routes.hostOfVault("h-app")).toBe("cloud");
  const adopted = useVaultStore.getState().vaults.find((v) => v.id === "h-app")!;
  expect(adopted.name.startsWith("app · ")).toBe(true);
  expect(selected).toEqual(["h-app"]);
  await act(() => useVaultStore.setState({ scannedAt: 2, files: { "src/retry.ts": { path: "src/retry.ts", mtime: 1, size: 5 } } }));
  expect(hrefs).toEqual(["/files?f=src%2Fretry.ts&l=12"]);
  expect(useVaultStore.getState().hostFallback).toBeNull();
});

test("a link from this machine's own session is the local flow, unchanged", async () => {
  await mount("/Users/ada/src/app/README.md", "laptop");
  await flush();
  expect(useVaultStore.getState().hostStates).toEqual({});
  expect(requests).toHaveLength(1);
  expect(port(0)).toBe(local.port);
});

test("a host out of reach falls back to its notes mirror, read-only", async () => {
  reachable = false;
  useVaultStore.setState({
    remoteVaults: [{ ...hostApp, id: "m-app", device_id: "cloud", last_synced_at: 1, remote: true }],
  });
  const hrefs = await mount("/home/ubuntu/work/app/docs/plan.md", "cloud");
  await flush();
  await flush();
  expect(mirrorsOpened).toEqual(["m-app"]);
  expect(hrefs).toEqual(["/files?f=docs%2Fplan.md&l=12"]);
  expect(requests).toHaveLength(0);
});

test("a host out of reach with no mirror opens this machine's checkout and remembers the host for the header", async () => {
  reachable = false;
  const hrefs = await mount(hostPath, "cloud");
  await flush();
  expect(requests).toHaveLength(1);
  expect(port(0)).toBe(local.port);
  await answer(0, { error: "no such path" }, 404);
  await flush();
  expect(requests).toHaveLength(2);
  await answer(1, { vault: localApp, rel: "src/retry.ts" });
  await flush();
  // The link keeps its machine, so the next render is still a fallback.
  expect(hrefs).toEqual(["/files?path=%2FUsers%2Fada%2Fsrc%2Fapp%2Fsrc%2Fretry.ts&d=cloud&l=12"]);
});

test("the checkout that stood in for a host is marked as the fallback once it opens", async () => {
  reachable = false;
  await mount("/Users/ada/src/app/src/retry.ts", "cloud");
  await flush();
  await answer(0, { vault: localApp, rel: "src/retry.ts", entry: { path: "src/retry.ts", mtime: 1, size: 5 } });
  await flush();
  expect(useVaultStore.getState().hostFallback).toEqual({ deviceId: "cloud", localVaultId: "l-app" });
});
