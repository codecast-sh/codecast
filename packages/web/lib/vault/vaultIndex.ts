// The vault index moved to @codecast/shared/vault when the CLI needed the same
// name resolution, backlinks and tag lookups the web index worker builds — an
// agent typing `cast vault cat sleep` must land on the file `[[Sleep]]` would.
// This re-export keeps every existing `lib/vault/vaultIndex` import working;
// the implementation lives at packages/shared/vault/vaultIndex.ts.
export * from "@codecast/shared/vault";
