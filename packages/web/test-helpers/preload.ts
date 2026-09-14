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
