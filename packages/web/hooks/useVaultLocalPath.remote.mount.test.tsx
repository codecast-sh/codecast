// ct-97960: a file path an agent names from a session on another machine must
// open that machine's mirrored copy (read-only) instead of an error with no
// way forward, whether this machine's daemon is current or older.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../test-helpers/globals";
import { closeDomWindow } from "../test-helpers/domGlobals";
import type { VaultInfo } from "@codecast/shared/contracts";
import type { RemoteVault } from "../lib/vault/remoteMirror";

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
const { useVaultStore } = await import("../store/vaultStore");
const { useVaultLocalPath } = await import("./useVaultLocalPath");
const initial = useVaultStore.getState();
const originalFetch = globalThis.fetch;
const roots: ReturnType<typeof createRoot>[] = [];
const known: VaultInfo = { id: "repo", root: "/Users/ada/src/app", name: "app", added_at: 1 };
const mirror: RemoteVault = {
  id: "codecast-mirror", root: "/home/jason/code/codecast", name: "codecast", added_at: 1,
  device_id: "other-machine", last_synced_at: 1, remote: true,
};
const foreign = `${mirror.root}/docs/plan.md`;
const endpoint = { port: 12345, token: "test", deviceId: "local", tmux: true };
let requests: { url: string; resolve: (response: Response) => void }[];
let opened: string[];

beforeEach(() => {
  requests = [];
  opened = [];
  globalThis.fetch = ((input: string | URL | Request) => new Promise<Response>((resolve) => {
    requests.push({ url: String(input), resolve });
  })) as typeof fetch;
  useVaultStore.setState({
    ...initial,
    connection: "connected",
    endpoint,
    vaults: [known],
    remoteVaults: [mirror],
    activeVaultId: known.id,
    scannedAt: 1,
    files: { "README.md": { path: "README.md", mtime: 1, size: 10 } },
    selectVault: async (id) => { useVaultStore.setState({ activeVaultId: id, files: {}, scannedAt: null }); },
    openRemoteVault: async (id) => {
      opened.push(id);
      useVaultStore.setState({
        activeVaultId: id,
        isRemote: true,
        scannedAt: 2,
        files: { "docs/plan.md": { path: "docs/plan.md", mtime: 1, size: 10 } },
      });
    },
  }, true);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount());
  useVaultStore.setState(initial, true);
  globalThis.fetch = originalFetch;
  document.body.innerHTML = "";
});
afterAll(() => {
  restoreGlobals();
  closeDomWindow(dom);
});

async function mount(path: string) {
  const routes: string[] = [];
  const router = { replace: (href: string) => { routes.push(href); } };
  function Probe() {
    useVaultLocalPath(path, 23, router);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(() => root.render(<Probe />));
  return { routes };
}

const answer = (index: number, body: unknown, status = 404) => act(async () => {
  requests[index].resolve(Response.json(body, { status }));
});

for (const [label, error] of [["a current daemon", "no such path"], ["an older daemon", "not found"]] as const) {
  test(`a path on another machine opens its mirrored copy when ${label} cannot find it`, async () => {
    const view = await mount(foreign);
    expect(requests).toHaveLength(1);
    await answer(0, { error });
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(useVaultStore.getState().opError).toBeNull();
    expect(opened).toEqual([mirror.id]);
    expect(view.routes.some((r) => r.includes("docs%2Fplan.md") || r.includes("docs/plan.md"))).toBe(true);
  });
}

test("a mirror that does not carry the file says so and offers to find it there", async () => {
  const view = await mount(`${mirror.root}/docs/gone.md`);
  await answer(0, { error: "no such path" });
  for (let i = 0; i < 5; i++) await act(async () => {});
  expect(opened).toEqual([mirror.id]);
  expect(view.routes).toEqual([]);
  expect(useVaultStore.getState().opError).toBe(`${mirror.root}/docs/gone.md does not exist on this machine.`);
  expect(useVaultStore.getState().opErrorActions?.file).toBe(`${mirror.root}/docs/gone.md`);
});
