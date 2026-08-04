// Wiki-link rewriting on rename moved to @codecast/shared/vault when
// `cast vault mv` needed it: a note moved from a terminal must leave the links
// that point at it working exactly as a note moved from the browser does, and
// two implementations of "what should this link say now" would drift. This
// re-export keeps every existing `lib/vault/linkRewrite` import working; the
// implementation lives at packages/shared/vault/linkRewrite.ts.
export * from "@codecast/shared/vault";
