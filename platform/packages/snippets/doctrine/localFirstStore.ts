// The first doctrine section: the local-first store rules, generalized from
// the codecast AGENTS.md chapter that proved them. No product names — the
// rules hold for any app built on @platform/engine.

import type { SnippetDefinition } from "../src/types";

export const LOCAL_FIRST_STORE_END = "<!-- /platform-doctrine-local-first-store -->";

export const LOCAL_FIRST_STORE_BODY = `
## Local-first store

Local-first is the law. Every piece of server data a surface renders lives in the local store, and the surface reads the store. A server query is a feeder, never a render source: it subscribes in a hook, hands each push to the sync layer, and the component paints from the store synchronously. A populated cache is the ordinary first paint. A skeleton is only honest for a genuinely cold cache (not ready and zero rows). Never gate paint on "the query has not answered yet" when the store could already hold the answer.

Adding a synced collection is ONE registration in the app's sync registry: persistence, hydration phase, sync options, indexes, and the feed queries that feed it. The cache schema, the boot state, the typed store slot, and the guard tests all derive from that entry. Do not hand-wire a new collection piece by piece.

Registering a feed is a promise. A source-level test fails any UI file that subscribes to a registered feed query directly. If it fails on your code, the fix is to read the store and mount the feeder, not to widen the allowlist.

Every user-visible mutation renders from the local store synchronously. The UI must never wait on a server round trip to show the result of a user action. The optimistic write happens in the action() draft; the server echo reconciles afterward through the sync and pending machinery. For creates, write a stub row keyed by a local id and let the server row supersede it when it syncs back. If a feature seems to need an await-then-render flow, it is modeled wrong: restructure it as draft plus side effect.

action() is the default write path: mutative draft, persistence, server dispatch. Use sync() for incoming data and local bookkeeping that must not dispatch. Raw set() is only for ephemeral UI gestures (a modal toggle, a transient flag) that never touch shared state.
${LOCAL_FIRST_STORE_END}
`;

export const LOCAL_FIRST_STORE: SnippetDefinition = {
  slug: "local-first-store",
  name: "Local-first store rules",
  desc: "The store is the render source; queries are feeders; action() is the write path",
  detail:
    "Installs the platform's local-first store doctrine into the repo's agent " +
    "instruction file, so every agent working in the repo follows the same " +
    "rules: render from the store, feed it from queries, write through action().",
  writesTo: "AGENTS.md — a ## Local-first store section",
  shipped: "2026-08-21",
  enabledKey: "doctrine_local_first_store_enabled",
  versionKey: "doctrine_local_first_store_version",
  section: {
    spec: {
      headings: ["## Local-first store"],
      endMarker: LOCAL_FIRST_STORE_END,
    },
    body: LOCAL_FIRST_STORE_BODY,
  },
};
