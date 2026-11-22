import { lazy, type ComponentType, type LazyExoticComponent } from "react";

// React.lazy for a component a module exports by name, the one way packages/web
// picks a named export lazily. Every React.lazy that does more than
// `lazy(() => import("./x"))` goes through this file (lazyNamed, namedExport or
// loadedModule); lib/__tests__/lazyNamed.guard.test.ts fails on one that doesn't.
//
// A raw mapping reads `m.X` off whatever the import resolved to. When a stale
// chunk fails to preload, installStaleChunkReload (lib/chunkReloadGuard.ts)
// starts a reload and cancels `vite:preloadError`, and Vite then RESOLVES the
// import with undefined. The raw mapping threw "Cannot read properties of
// undefined (reading 'SettingsModal')" from DashboardLayout (ct-91263), a
// TypeError the error boundary cannot tell from a code bug. Here an undefined
// module stays suspended instead: the page is already leaving.
export function lazyNamed<K extends string, M extends Record<K, ComponentType<any>>>(
  load: () => Promise<M>,
  name: K,
): LazyExoticComponent<M[K]> {
  return lazy(namedExportLoader(load, name));
}

// The factory lazyNamed hands React.lazy, exported so a test can drive it
// through Vite's preload semantics without rendering.
export function namedExportLoader<K extends string, M extends Record<K, ComponentType<any>>>(
  load: () => Promise<M>,
  name: K,
): () => Promise<{ default: M[K] }> {
  return () => namedExport(load, name).then((component) => ({ default: component }));
}

// The named export of a lazily loaded module, for a loader that holds the
// export itself (lib/composeViewLoader.ts) or hands it to its own wrapper
// (app/evals/page.tsx). Waits out a cancelled preload as loadedModule does.
export function namedExport<K extends string, M extends Record<K, unknown>>(
  load: () => Promise<M>,
  name: K,
): Promise<M[K]> {
  return loadedModule(load).then((module) => {
    const value = module[name];
    // A module that loaded but lacks the export is real breakage (a rename,
    // a removed export): say which, so the boundary and Sentry see it.
    if (value == null) throw new Error(`Lazy component "${name}" is missing from ${moduleSource(load)}`);
    return value;
  });
}

// The module a lazy import resolved to, for a loader that reads it in its own
// way (a figure picked by name, an icon set). The import resolves with
// undefined only when the stale-chunk guard cancelled the preload, which it
// does after starting a reload, so that answer stays suspended.
export function loadedModule<M>(load: () => Promise<M>): Promise<M> {
  return load().then((module: M | undefined) => (module == null ? new Promise<never>(() => {}) : module));
}

// The specifier the loader imports: the source path in dev, the hashed chunk
// in a build (`__vitePreload(() => import("./SettingsModal-abc.js"), ...)`).
function moduleSource(load: () => unknown): string {
  const match = /import\(\s*["'`]([^"'`]+)["'`]/.exec(String(load));
  return match ? `module "${match[1]}"` : "its lazy module";
}
