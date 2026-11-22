import { beforeEach, expect, test } from "bun:test";
import { installStaleChunkReload, MAX_AUTO_RELOADS, RELOAD_COUNT_KEY } from "../chunkReloadGuard";
import { namedExportLoader } from "../lazyNamed";

// ct-91263: production reported "Cannot read properties of undefined (reading
// 'SettingsModal')" from DashboardLayout. Its lazy loader is
//   import("./settings/SettingsModal").then((m) => ({ default: m.SettingsModal }))
// and a built dynamic import goes through Vite's preload helper, which on a
// failed chunk dispatches `vite:preloadError` and, when that event is
// cancelled, RESOLVES the import with undefined instead of rejecting it.

// Vite 6.4.2's __vitePreload tail (node_modules/vite/dist/node/chunks/dep-*.js,
// handlePreloadError), reproduced so the test drives the same semantics.
let lastEvent: Event | null = null;
function vitePreload<T>(baseModule: () => Promise<T>): Promise<T> {
  function handlePreloadError(err: unknown): undefined {
    const e = new Event("vite:preloadError", { cancelable: true }) as Event & { payload?: unknown };
    e.payload = err;
    window.dispatchEvent(e);
    lastEvent = e;
    if (!e.defaultPrevented) throw err;
    return undefined;
  }
  return Promise.resolve().then(() => baseModule().catch(handlePreloadError)) as Promise<T>;
}

let reloads = 0;

beforeEach(() => {
  reloads = 0;
  lastEvent = null;
  const store: Record<string, string> = {};
  (globalThis as any).sessionStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
  const target = new EventTarget();
  (globalThis as any).window = Object.assign(target, {
    location: { reload: () => { reloads++; } },
    navigator: {},
  });
});

test("a stale SettingsModal chunk never reaches the lazy loader as undefined", async () => {
  installStaleChunkReload();

  const staleChunk = () =>
    Promise.reject(
      new TypeError("Failed to fetch dynamically imported module: https://codecast.sh/assets/SettingsModal-abc123.js"),
    );
  // DashboardLayout's SettingsModal loader: lazyNamed(() => import(...), "SettingsModal").
  const loader = namedExportLoader(
    () => vitePreload(staleChunk) as Promise<{ SettingsModal: () => null }>,
    "SettingsModal",
  );

  const PENDING = Symbol("pending");
  const outcome = await Promise.race([
    loader().then(
      (value) => ({ settled: "resolved" as const, value }),
      (error: unknown) => ({ settled: "rejected" as const, error }),
    ),
    new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), 50)),
  ]);

  expect(reloads).toBe(1); // the guard did start the stale-chunk reload
  expect(lastEvent!.defaultPrevented).toBe(true); // and cancelled the event, its contract

  // While the page is leaving, the loader may stay pending, or fail with the
  // chunk-load error itself. It must never hand React.lazy a module read off
  // undefined, which is the TypeError production reported.
  if (outcome !== PENDING && outcome.settled === "rejected") {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    expect(message).not.toMatch(/undefined.*SettingsModal|reading 'SettingsModal'/);
    expect(message).toContain("Failed to fetch dynamically imported module");
  } else if (outcome !== PENDING) {
    throw new Error(`loader resolved with ${JSON.stringify(outcome.value)} while a reload was under way`);
  }
});

const staleChunk = () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module: https://codecast.sh/assets/X-abc123.js"));

test("with the reload budget spent, the chunk-load error reaches the boundary", async () => {
  installStaleChunkReload();
  sessionStorage.setItem(RELOAD_COUNT_KEY, String(MAX_AUTO_RELOADS));
  const loader = namedExportLoader(() => vitePreload(staleChunk) as Promise<{ SettingsModal: () => null }>, "SettingsModal");

  await expect(loader()).rejects.toThrow("Failed to fetch dynamically imported module");
  expect(reloads).toBe(0);
  expect(lastEvent!.defaultPrevented).toBe(false);
});

test("a module that loaded without the export fails naming the module and the export", async () => {
  const loader = namedExportLoader(
    () => import("../chunkReloadGuard") as unknown as Promise<{ SettingsModal: () => null }>,
    "SettingsModal",
  );
  await expect(loader()).rejects.toThrow('Lazy component "SettingsModal" is missing from module "../chunkReloadGuard"');
});

test("a module with the export resolves to it", async () => {
  const SettingsModal = () => null;
  const loader = namedExportLoader(() => Promise.resolve({ SettingsModal }), "SettingsModal");
  expect((await loader()).default).toBe(SettingsModal);
});
