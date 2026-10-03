// The project matcher lives in shared/contracts/projectRef so the server
// resolves a `--project` ref inside a write workspace (signals, goals) by the
// same rule every CLI `--project` flag uses.
export * from "@codecast/shared/contracts/projectRef";
