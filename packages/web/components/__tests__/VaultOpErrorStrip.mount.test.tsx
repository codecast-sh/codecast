// ct-97960: the Files pane's error strip is never a dead end. A file it cannot
// open can be found by name or have its path copied, and a failed folder scan
// says so and offers the scan again.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import type { VaultInfo } from "@codecast/shared/contracts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
const copied: string[] = [];
Object.defineProperty(dom.window.navigator, "clipboard", {
  value: { writeText: async (text: string) => { copied.push(text); } },
});
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
const { useVaultStore } = await import("../../store/vaultStore");
const { VaultOpErrorStrip } = await import("../vault/VaultOpErrorStrip");
const initial = useVaultStore.getState();
const originalFetch = globalThis.fetch;
const roots: ReturnType<typeof createRoot>[] = [];
const vault: VaultInfo = { id: "repo", root: "/Users/ada/src/app", name: "app", added_at: 1 };
const endpoint = { port: 12345, token: "test", deviceId: "local", tmux: true };
const missing = "/home/jason/code/codecast/docs/plan.md";
let scans: string[];

beforeEach(() => {
  copied.length = 0;
  scans = [];
  // Every scan times out the way AbortSignal.timeout(60 s) does; nothing else answers.
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/vault/scan")) {
      scans.push(url);
      return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
    }
    return Promise.reject(new TypeError("offline"));
  }) as typeof fetch;
  useVaultStore.setState({
    ...initial,
    connection: "connected",
    endpoint,
    vaults: [vault],
    activeVaultId: vault.id,
    scannedAt: 1,
    files: { "README.md": { path: "README.md", mtime: 1, size: 10 } },
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

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(() => root.render(<VaultOpErrorStrip />));
  return container;
}
const button = (container: HTMLElement, label: string) => {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label) || b.getAttribute("aria-label") === label);
  if (!found) throw new Error(`no "${label}" button in: ${container.innerHTML}`);
  return found;
};
const press = (el: HTMLElement) => act(async () => { el.click(); });

test("a file nobody holds can be found by name or have its path copied from the strip", async () => {
  await act(async () => useVaultStore.getState().reportOpError(`${missing} does not exist on this machine.`, { file: missing }));
  const strip = await mount();
  expect(strip.textContent).toContain("does not exist on this machine");
  expect(useVaultStore.getState().quickSwitchOpen).toBe(false);

  await press(button(strip, "Find plan.md"));
  expect(useVaultStore.getState().quickSwitchOpen).toBe(true);
  expect(useVaultStore.getState().quickSwitchSeed).toBe("plan.md");

  await press(button(strip, "Copy path"));
  expect(copied).toEqual([missing]);

  await press(button(strip, "Dismiss"));
  expect(useVaultStore.getState().opError).toBeNull();
  expect(strip.textContent).toBe("");
});

test("a plain error written after an actionable one carries none of its actions", async () => {
  await act(async () => useVaultStore.getState().reportOpError("gone", { file: missing }));
  await act(async () => useVaultStore.setState({ opError: "Couldn't rename a.md: busy" }));
  const strip = await mount();
  expect(strip.textContent).toContain("Couldn't rename");
  expect([...strip.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Dismiss"]);
});

test("a scan that times out says so in the strip, and Retry scans again", async () => {
  const strip = await mount();
  await act(() => useVaultStore.getState().selectVault(vault.id));
  expect(scans).toHaveLength(1);
  expect(useVaultStore.getState().opError).toBe("Couldn't list app: the daemon took over 60 s to answer.");
  expect(strip.textContent).toContain("Couldn't list app");

  await press(button(strip, "Retry"));
  for (let i = 0; i < 5; i++) await act(async () => {});
  expect(scans).toHaveLength(2);
  expect(useVaultStore.getState().opError).toBe("Couldn't list app: the daemon took over 60 s to answer.");
});
