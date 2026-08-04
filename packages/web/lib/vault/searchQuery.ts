// The vault search query grammar moved to @codecast/shared/vault when the CLI
// needed the same `tag:` / `path:` / `file:` operators the search pane parses —
// one grammar, so a query typed in the browser means the same thing in
// `cast vault search`. This re-export keeps every existing
// `lib/vault/searchQuery` import working; the implementation lives at
// packages/shared/vault/searchQuery.ts.
export * from "@codecast/shared/vault";
