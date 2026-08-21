// Incremental persistence diff for the IDB collection caches (web Dexie +
// native kv-store). The generic algorithm lives in @platform/engine
// (idbCollectionDiff there); this module only preserves codecast's import
// path for both persistence engines and the tests.
export { diffCollection, type CollectionDiff } from "@platform/engine";
