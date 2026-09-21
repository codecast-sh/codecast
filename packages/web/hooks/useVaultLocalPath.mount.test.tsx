import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../test-helpers/globals";
import { closeDomWindow } from "../test-helpers/domGlobals";
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
const { useVaultStore } = await import("../store/vaultStore");
const { useVaultLocalPath } = await import("./useVaultLocalPath");
const initial = useVaultStore.getState();
const originalFetch = globalThis.fetch;
const roots: ReturnType<typeof createRoot>[] = [];
const known: VaultInfo = { id: "repo", root: "/Users/ada/src/app", name: "app", added_at: 1 };
const located: VaultInfo = { id: "skill", root: "/Users/ada/.agents/skills/improve", name: "improve", added_at: 1 };
const localPath = `${located.root}/SKILL.md`;
const endpoint = { port: 12345, token: "test", deviceId: "local", tmux: true };
let requests: { url: string; resolve: (response: Response) => void }[];

beforeEach(() => {
  requests = [];
  globalThis.fetch = ((input: string | URL | Request) => new Promise<Response>((resolve) => {
    requests.push({ url: String(input), resolve });
  })) as typeof fetch;
  useVaultStore.setState({
    ...initial,
    connection: "cached",
    endpoint: null,
    vaults: [known],
    activeVaultId: known.id,
    scannedAt: 1,
    files: { "README.md": { path: "README.md", mtime: 1, size: 10 } },
    selectVault: async (id) => {
      useVaultStore.setState({ activeVaultId: id, files: {}, scannedAt: null });
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

async function mount(path: string | null = localPath) {
  const routes: string[] = [];
  const router = { replace: (href: string) => { routes.push(href); } };
  function Probe({ path }: { path: string | null }) {
    useVaultLocalPath(path, 23, router);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (next: string | null) => act(() => root.render(<Probe path={next} />));
  await render(path);
  return { routes, render };
}

const update = (state: Parameters<typeof useVaultStore.setState>[0]) => act(() => useVaultStore.setState(state));
const answer = (index: number, body: unknown, status = 200) => act(async () => {
  requests[index].resolve(Response.json(body, { status }));
});

test("cached startup waits for the endpoint, then locates, selects, scans and opens the linked file", async () => {
  const view = await mount();
  expect(requests).toHaveLength(0);
  expect(view.routes).toEqual([]);
  expect(useVaultStore.getState().opError).toBeNull();

  await update({ endpoint });
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0].url).searchParams.get("path")).toBe(localPath);
  await answer(0, { vault: located, rel: "SKILL.md" });
  expect(useVaultStore.getState().activeVaultId).toBe(located.id);
  expect(view.routes).toEqual([]);

  await update({ scannedAt: 2, files: { "SKILL.md": { path: "SKILL.md", mtime: 2, size: 12 } } });
  expect(view.routes).toEqual(["/files?f=SKILL.md&l=23"]);
  expect(useVaultStore.getState().opError).toBeNull();
});

test("connection, vault-list and scan updates do not fail or repeat a pending lookup", async () => {
  await update({ endpoint });
  const view = await mount();
  await update({ connection: "connected", scannedAt: 2, vaults: [{ ...known }] });
  await view.render(localPath);
  expect(requests).toHaveLength(1);
  expect(view.routes).toEqual([]);
  expect(useVaultStore.getState().opError).toBeNull();
  await answer(0, { vault: located, rel: "SKILL.md" });
  expect(useVaultStore.getState().activeVaultId).toBe(located.id);
});

test("leaving a file link ignores a late successful lookup", async () => {
  await update({ endpoint });
  const view = await mount();
  await view.render(null);
  await answer(0, { vault: located, rel: "SKILL.md" });
  expect(useVaultStore.getState().vaults).toEqual([known]);
  expect(useVaultStore.getState().activeVaultId).toBe(known.id);
  expect(view.routes).toEqual([]);
});

test("a stale failure cannot overwrite a newer file link", async () => {
  await update({ endpoint });
  const view = await mount();
  await view.render(`${located.root}/OTHER.md`);
  expect(requests).toHaveLength(2);
  await answer(0, { error: "no such path" }, 404);
  expect(useVaultStore.getState().opError).toBeNull();
  expect(view.routes).toEqual([]);
});

test("reconnecting replaces the lookup and ignores the old endpoint's result", async () => {
  await update({ endpoint });
  const view = await mount();
  await update({ endpoint: { ...endpoint, port: 23456 } });
  expect(requests).toHaveLength(2);
  await answer(0, { error: "forbidden" }, 403);
  expect(useVaultStore.getState().opError).toBeNull();
  await answer(1, { vault: located, rel: "SKILL.md" });
  expect(useVaultStore.getState().activeVaultId).toBe(located.id);
  expect(view.routes).toEqual([]);
});

test("a missing file reports the actual problem without discarding the deep link", async () => {
  await update({ endpoint });
  const view = await mount();
  await answer(0, { error: "no such path" }, 404);
  expect(useVaultStore.getState().opError).toBe(`${localPath} does not exist on this machine.`);
  expect(view.routes).toEqual([]);
});

test("a refused lookup preserves the link and retries when reconnected", async () => {
  await update({ endpoint });
  const view = await mount();
  await answer(0, { error: "forbidden" }, 403);
  expect(useVaultStore.getState().opError).toContain("vault locate: 403");
  expect(view.routes).toEqual([]);
  await update({ endpoint: { ...endpoint, token: "renewed" } });
  expect(useVaultStore.getState().opError).toBeNull();
  expect(requests).toHaveLength(2);
  await answer(1, { vault: located, rel: "SKILL.md" });
  expect(useVaultStore.getState().activeVaultId).toBe(located.id);
});

test("an older daemon asks for an update rather than claiming the file is missing", async () => {
  await update({ endpoint });
  const view = await mount();
  await answer(0, { error: "not found" }, 404);
  expect(useVaultStore.getState().opError).toContain("Update Codecast");
  expect(view.routes).toEqual([]);
});

test("an already cached file opens without waiting for a local connection", async () => {
  const view = await mount(`${known.root}/README.md`);
  expect(requests).toHaveLength(0);
  expect(view.routes).toEqual(["/files?f=README.md&l=23"]);
});
