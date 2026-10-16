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
import { dirname, join } from "node:path";

mock.module("@convex-dev/prosemirror-sync/tiptap", () => ({
  useTiptapSync: () => ({ isLoading: false, initialContent: null, extension: null, create: async () => {} }),
}));

// @pierre/diffs draws in a shadow root after Shiki loads, which never happens
// under bun test; DiffView's tests read a light-DOM stand-in instead
// (test-helpers/pierreFileDiff.tsx). The real exports stay, so anything else
// the package provides behaves as in the app.
//
// Its shadow-root host registers itself on evaluation wherever HTMLElement
// exists. Under --isolate the module evaluates again inside a test's realm,
// and most test DOMs install jsdom's HTMLElement but no customElements, so the
// registration threw mid-test in whichever file it landed (walkie, org). The
// stand-in draws no shadow root, so the host stays unregistered.
mock.module(join(dirname(Bun.resolveSync("@pierre/diffs", import.meta.dir)), "components", "web-components.js"), () => ({ DiffsContainerLoaded: true }));
const pierreReact = await import("@pierre/diffs/react");
const { FileDiffStandIn } = await import("./pierreFileDiff");
mock.module("@pierre/diffs/react", () => ({ ...pierreReact, FileDiff: FileDiffStandIn }));
// With Pierre's drawing stood in, there is nothing to load first: a diff gets
// its renderer at once instead of the plain-text fallback.
const diffSetup = await import("../components/diff/pierre");
const { PierreDiff, diffLanguage } = await import("../components/diff/PierreDiff");
mock.module("../components/diff/pierre", () => ({
  ...diffSetup,
  useDiffRenderer: (name: string, language?: string) => ({ PierreDiff, lang: diffLanguage(name, language) }),
}));
