import { beforeEach, expect, test } from "bun:test";
import { installStaleChunkReload } from "../chunkReloadGuard";

// ct-91263: production reported "Cannot read properties of undefined (reading
// 'SettingsModal')" from DashboardLayout. Its lazy loader is
//   import("./settings/SettingsModal").then((m) => ({ default: m.SettingsModal }))
// and a built dynamic import goes through Vite's preload helper, which on a
// failed chunk dispatches `vite:preloadError` and, when that event is
// cancelled, RESOLVES the import with undefined instead of rejecting it.

// Vite 6.4.2's __vitePreload tail (node_modules/vite/dist/node/chunks/dep-*.js,
// handlePreloadError), reproduced so the test drives the same semantics.
function vitePreload<T>(baseModule: () => Promise<T>): Promise<T | undefined> {
  function handlePreloadError(err: unknown): undefined {
    const e = new Event("vite:preloadError", { cancelable: true }) as Event & { payload?: unknown };
    e.payload = err;
    window.dispatchEvent(e);
    if (!e.defaultPrevented) throw err;
    return undefined;
  }
  return Promise.resolve().then(() => baseModule().catch(handlePreloadError));
}

let reloads = 0;

beforeEach(() => {
  reloads = 0;
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
  // The exact shape of DashboardLayout's SettingsModal loader.
  const loader = () =>
    vitePreload(staleChunk).then((module: any) => ({ default: module.SettingsModal }));

  const PENDING = Symbol("pending");
  const outcome = await Promise.race([
    loader().then(
      (value) => ({ settled: "resolved" as const, value }),
      (error: unknown) => ({ settled: "rejected" as const, error }),
    ),
    new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), 50)),
  ]);

  expect(reloads).toBe(1); // the guard did start the stale-chunk reload

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
