// bun test preload (packages/web/bunfig.toml): runs once before every test file.
//
// The sync library's tiptap entry imports `@tiptap/pm/collab`, a subpath the
// tiptap 3 prosemirror package does not export; the app resolves it through the
// vite alias, bun has no alias, so under bun test the real CollabDocEditor
// could never load. A test that loaded it anyway (route warmups import every
// shell page) left a failed module record that no later `mock.module` could
// replace, and the next file to link DocumentDetailLayout died on it. Stubbing
// the hook here keeps the editor loadable everywhere; nothing under bun test
// can exercise the real sync, so nothing loses coverage.
import { mock } from "bun:test";

mock.module("@convex-dev/prosemirror-sync/tiptap", () => ({
  useTiptapSync: () => ({ isLoading: false, initialContent: null, extension: null, create: async () => {} }),
}));

// react-dom decides ONCE, at load, whether a DOM exists (`canUseDOM`). The
// first test file to load it settles that for the whole process: loaded with no
// window it takes the no-DOM path, native `input` events never reach onChange,
// and a later mount test types into a textarea that React never hears. 56 test
// files import react-dom before any DOM exists, so which one runs first — and
// therefore whether typing works at all — is an accident of suite order. That
// is why these tests pass alone and fail in a full run.
//
// Install a baseline DOM here, before any test file loads. A mount test that
// wants its own jsdom still replaces these globals; it just no longer decides
// what react-dom believes.
import { JSDOM } from "jsdom";

if (typeof (globalThis as Record<string, unknown>).window === "undefined") {
  const baseline = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const w = baseline.window as unknown as Record<string, unknown>;
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "HTMLInputElement", "HTMLButtonElement", "HTMLAnchorElement", "Element", "Node", "Event", "KeyboardEvent", "MouseEvent", "CustomEvent", "getComputedStyle", "MutationObserver"]) {
    const value = key === "window" ? w : w[key];
    if (value !== undefined) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
}
