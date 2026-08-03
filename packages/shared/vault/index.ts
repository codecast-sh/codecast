// Vault code shared across runtimes. The markdown parser, the name index and
// the search grammar live here rather than in the browser because three readers
// now need them and they must never disagree: the web index worker parses notes
// to build links, tags and search, the daemon parses the same notes to push
// their metadata to the Convex mirror, and the CLI resolves the names an agent
// types (`cast vault cat sleep`) through the same rules `[[Sleep]]` follows.
// One parser, one resolver, one query grammar, one test corpus.
//
// PURE isomorphic data — no Node or DOM APIs.
export * from "./parseNote";
export * from "./searchQuery";
export * from "./vaultIndex";
