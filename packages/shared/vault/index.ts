// Vault code shared across runtimes. The markdown INDEXING parser lives here
// rather than in the browser because two readers now need it and they must
// never disagree: the web index worker parses notes to build links, tags and
// search, and the daemon parses the same notes to push their metadata to the
// Convex mirror. One parser, one set of syntax semantics, one test corpus.
//
// PURE isomorphic data — no Node or DOM APIs.
export * from "./parseNote";
